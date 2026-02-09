// Validation: check deviation, thickness, manifoldness, disconnected pieces
import type { Vec3 } from './vec3';
import { length, normalize, scale, add } from './vec3';
import type { MeshBVH } from './bvh';
import type { LatticeParams, ValidationResult } from '../types/project';
import type { MarchingCubesResult } from './marching-cubes';

/** Check outer deviation: sample points on the result surface and measure distance to original mesh */
export function checkOuterDeviation(
  result: MarchingCubesResult,
  originalBvh: MeshBVH,
  tolerance: number,
  sampleCount: number = 2000
): { passed: boolean; maxDeviation: number } {
  const { positions, triCount } = result;
  let maxDev = 0;
  const step = Math.max(1, Math.floor(triCount / sampleCount));

  for (let i = 0; i < triCount; i += step) {
    // Sample triangle centroid
    const o = i * 9;
    const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;

    const res = originalBvh.closestPoint([cx, cy, cz]);
    // Only count as outer deviation if the point is outside the original mesh
    const sd = originalBvh.signedDistance([cx, cy, cz]);
    if (sd > 0) {
      // Outside original: measure deviation
      if (res.distance > maxDev) maxDev = res.distance;
    }
  }

  return { passed: maxDev <= tolerance, maxDeviation: maxDev };
}

/** Check outer deviation for sphere (fast path) */
export function checkSphereDeviation(
  result: MarchingCubesResult,
  radius: number,
  tolerance: number,
  sampleCount: number = 2000
): { passed: boolean; maxDeviation: number } {
  const { positions, triCount } = result;
  let maxDev = 0;
  const step = Math.max(1, Math.floor(triCount / sampleCount));

  for (let i = 0; i < triCount; i += step) {
    const o = i * 9;
    const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    const r = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const dev = Math.abs(r - radius);
    // Only if outside
    if (r > radius && dev > maxDev) maxDev = dev;
  }

  return { passed: maxDev <= tolerance, maxDeviation: maxDev };
}

/** Minimum thickness check: sample points inside the lattice, trace in normal direction */
export function checkMinThickness(
  sdf: (x: number, y: number, z: number) => number,
  result: MarchingCubesResult,
  minRequired: number,
  sampleCount: number = 500
): { passed: boolean; minMeasured: number } {
  const { positions, normals, triCount } = result;
  let minMeasured = Infinity;
  const step = Math.max(1, Math.floor(triCount / sampleCount));

  for (let i = 0; i < triCount; i += step) {
    const o = i * 9;
    // Surface point (centroid)
    const px = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const py = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const pz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    const n: Vec3 = [normals[i * 3], normals[i * 3 + 1], normals[i * 3 + 2]];
    const nLen = length(n);
    if (nLen < 1e-6) continue;
    const nn = normalize(n);

    // March inward along normal until SDF becomes positive again (exiting material)
    let thickness = 0;
    const stepSize = minRequired * 0.1;
    let p: Vec3 = [px, py, pz];
    let enteredMaterial = false;
    for (let s = 0; s < 50; s++) {
      p = add(p, scale(nn, -stepSize));  // inward
      thickness += stepSize;
      const val = sdf(p[0], p[1], p[2]);
      if (val <= 0) {
        enteredMaterial = true;
      } else if (enteredMaterial) {
        // Exited material
        break;
      }
      if (thickness > minRequired * 5) break;
    }
    if (enteredMaterial && thickness < minMeasured) {
      minMeasured = thickness;
    }
  }

  if (minMeasured === Infinity) minMeasured = minRequired; // fallback
  return { passed: minMeasured >= minRequired * 0.9, minMeasured };
}

/** Basic manifold check: count edges shared by != 2 triangles */
export function checkManifold(result: MarchingCubesResult): { passed: boolean; details: string } {
  const { positions, triCount } = result;
  const edgeCounts = new Map<string, number>();
  const q = (v: number) => Math.round(v * 1e3);

  for (let i = 0; i < triCount; i++) {
    const verts: string[] = [];
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      verts.push(`${q(positions[o])},${q(positions[o + 1])},${q(positions[o + 2])}`);
    }
    for (let e = 0; e < 3; e++) {
      const a = verts[e], b = verts[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    }
  }

  let nonManifold = 0;
  let boundary = 0;
  for (const c of edgeCounts.values()) {
    if (c === 1) boundary++;
    if (c > 2) nonManifold++;
  }

  // MC output is generally manifold but may have boundary edges
  const passed = nonManifold === 0 && boundary === 0;
  const details = passed
    ? 'Mesh is manifold and watertight'
    : `Non-manifold edges: ${nonManifold}, boundary edges: ${boundary}`;
  return { passed, details };
}

/** Disconnected pieces check using flood fill on triangle adjacency */
export function checkDisconnected(result: MarchingCubesResult): { passed: boolean; fragmentCount: number } {
  const { positions, triCount } = result;
  if (triCount === 0) return { passed: true, fragmentCount: 0 };

  // Build adjacency via shared edges
  const q = (v: number) => Math.round(v * 1e3);
  const edgeToTris = new Map<string, number[]>();

  for (let i = 0; i < triCount; i++) {
    const verts: string[] = [];
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      verts.push(`${q(positions[o])},${q(positions[o + 1])},${q(positions[o + 2])}`);
    }
    for (let e = 0; e < 3; e++) {
      const a = verts[e], b = verts[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (!edgeToTris.has(key)) edgeToTris.set(key, []);
      edgeToTris.get(key)!.push(i);
    }
  }

  // Build adjacency list
  const adj: number[][] = Array.from({ length: triCount }, () => []);
  for (const tris of edgeToTris.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].push(tris[j]);
        adj[tris[j]].push(tris[i]);
      }
    }
  }

  // Flood fill
  const visited = new Uint8Array(triCount);
  let components = 0;
  for (let i = 0; i < triCount; i++) {
    if (visited[i]) continue;
    components++;
    const stack = [i];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (visited[t]) continue;
      visited[t] = 1;
      for (const nb of adj[t]) {
        if (!visited[nb]) stack.push(nb);
      }
    }
  }

  return { passed: components <= 1, fragmentCount: components };
}

/** Run full validation suite */
export function runValidation(
  result: MarchingCubesResult,
  sdf: (x: number, y: number, z: number) => number,
  params: LatticeParams,
  originalBvh: MeshBVH | null,
  sphereRadius: number | null,
): ValidationResult {
  const warnings: string[] = [];

  // Outer deviation
  let outerDeviation: { passed: boolean; maxDeviation: number };
  if (sphereRadius !== null) {
    outerDeviation = checkSphereDeviation(result, sphereRadius, params.toleranceMm);
  } else if (originalBvh) {
    outerDeviation = checkOuterDeviation(result, originalBvh, params.toleranceMm);
  } else {
    outerDeviation = { passed: true, maxDeviation: 0 };
    warnings.push('No reference mesh for deviation check');
  }

  // Min thickness
  const minThickness = checkMinThickness(sdf, result, params.minFeatureSize);

  // Manifold
  const manifold = checkManifold(result);

  // Disconnected
  const disconnected = checkDisconnected(result);
  if (disconnected.fragmentCount > 1) {
    warnings.push(`${disconnected.fragmentCount} disconnected fragments detected`);
  }

  // Process-specific warnings
  if (params.processPreset === 'FDM' && params.variant === 'implicit_conformal') {
    warnings.push('FDM with open lattice exterior can be difficult to print');
  }

  if (!params.escapeHoles && params.variant === 'shell_core') {
    warnings.push('Escape holes disabled - trapped powder/resin likely');
  }

  const passed = outerDeviation.passed && minThickness.passed && manifold.passed && disconnected.passed;

  return {
    passed,
    outerDeviation: { ...outerDeviation, tolerance: params.toleranceMm },
    minThickness: { ...minThickness, required: params.minFeatureSize },
    manifold,
    disconnected,
    warnings,
  };
}
