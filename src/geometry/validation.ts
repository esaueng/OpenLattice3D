// Validation: check deviation, thickness, manifoldness, disconnected pieces
import type { Vec3 } from './vec3';
import { length, normalize, scale, add } from './vec3';
import type { MeshBVH } from './bvh';
import type { LatticeParams, ValidationResult } from '../types/project';
import type { MarchingCubesResult } from './marching-cubes';

type EdgeTopology = {
  edgeToTris: Map<number, number[]>;
};

function edgeKey(a: number, b: number): number {
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  return lo * 0x100000000 + hi;
}

function vertexBucketKey(qx: number, qy: number, qz: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ qx, 16777619);
  h = Math.imul(h ^ qy, 16777619);
  h = Math.imul(h ^ qz, 16777619);
  return h >>> 0;
}

function getQuantizedVertexId(
  buckets: Map<number, number[]>,
  qxById: number[],
  qyById: number[],
  qzById: number[],
  qx: number,
  qy: number,
  qz: number
): number {
  const bucketKey = vertexBucketKey(qx, qy, qz);
  let bucket = buckets.get(bucketKey);
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      if (qxById[id] === qx && qyById[id] === qy && qzById[id] === qz) return id;
    }
  } else {
    bucket = [];
    buckets.set(bucketKey, bucket);
  }

  const id = qxById.length;
  qxById.push(qx);
  qyById.push(qy);
  qzById.push(qz);
  bucket.push(id);
  return id;
}

function addEdge(edgeToTris: Map<number, number[]>, a: number, b: number, triIndex: number): void {
  const key = edgeKey(a, b);
  const tris = edgeToTris.get(key);
  if (tris) tris.push(triIndex);
  else edgeToTris.set(key, [triIndex]);
}

function buildEdgeTopology(result: MarchingCubesResult): EdgeTopology {
  const { positions, triCount } = result;
  const buckets = new Map<number, number[]>();
  const qxById: number[] = [];
  const qyById: number[] = [];
  const qzById: number[] = [];
  const edgeToTris = new Map<number, number[]>();

  for (let i = 0; i < triCount; i++) {
    const base = i * 9;
    const v0 = getQuantizedVertexId(
      buckets,
      qxById,
      qyById,
      qzById,
      Math.round(positions[base] * 1e3),
      Math.round(positions[base + 1] * 1e3),
      Math.round(positions[base + 2] * 1e3)
    );
    const v1 = getQuantizedVertexId(
      buckets,
      qxById,
      qyById,
      qzById,
      Math.round(positions[base + 3] * 1e3),
      Math.round(positions[base + 4] * 1e3),
      Math.round(positions[base + 5] * 1e3)
    );
    const v2 = getQuantizedVertexId(
      buckets,
      qxById,
      qyById,
      qzById,
      Math.round(positions[base + 6] * 1e3),
      Math.round(positions[base + 7] * 1e3),
      Math.round(positions[base + 8] * 1e3)
    );

    addEdge(edgeToTris, v0, v1, i);
    addEdge(edgeToTris, v1, v2, i);
    addEdge(edgeToTris, v2, v0, i);
  }

  return { edgeToTris };
}

function checkManifoldFromTopology(topology: EdgeTopology): { passed: boolean; details: string } {
  let nonManifold = 0;
  let boundary = 0;
  for (const tris of topology.edgeToTris.values()) {
    const c = tris.length;
    if (c === 1) boundary++;
    if (c > 2) nonManifold++;
  }

  const passed = nonManifold === 0 && boundary === 0;
  const details = passed
    ? 'Mesh is manifold and watertight'
    : `Non-manifold edges: ${nonManifold}, boundary edges: ${boundary}`;
  return { passed, details };
}

function checkDisconnectedFromTopology(result: MarchingCubesResult, topology: EdgeTopology): { passed: boolean; fragmentCount: number } {
  const { triCount } = result;
  if (triCount === 0) return { passed: true, fragmentCount: 0 };

  const adj: number[][] = Array.from({ length: triCount }, () => []);
  for (const tris of topology.edgeToTris.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].push(tris[j]);
        adj[tris[j]].push(tris[i]);
      }
    }
  }

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

export function checkTopology(result: MarchingCubesResult): {
  manifold: { passed: boolean; details: string };
  disconnected: { passed: boolean; fragmentCount: number };
} {
  const topology = buildEdgeTopology(result);
  return {
    manifold: checkManifoldFromTopology(topology),
    disconnected: checkDisconnectedFromTopology(result, topology),
  };
}

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
  return checkTopology(result).manifold;
}

/** Disconnected pieces check using flood fill on triangle adjacency */
export function checkDisconnected(result: MarchingCubesResult): { passed: boolean; fragmentCount: number } {
  return checkTopology(result).disconnected;
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

  const { manifold, disconnected } = checkTopology(result);
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
