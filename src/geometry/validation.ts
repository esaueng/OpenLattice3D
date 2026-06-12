// Validation: check deviation, thickness, manifoldness, disconnected pieces
import type { Vec3 } from './vec3';
import { length, normalize, scale, add } from './vec3';
import type { MeshBVH } from './bvh';
import type { LatticeParams, ValidationResult } from '../types/project';
import type { MarchingCubesResult } from './marching-cubes';
import { buildEdgeTopology, countEdgeDefects, findConnectedComponents } from './mesh-topology';

export function checkTopology(result: MarchingCubesResult): {
  manifold: { passed: boolean; details: string };
  disconnected: { passed: boolean; fragmentCount: number };
} {
  const topology = buildEdgeTopology(result.positions, result.triCount);

  const { boundaryEdges, nonManifoldEdges } = countEdgeDefects(topology);
  const manifoldPassed = boundaryEdges === 0 && nonManifoldEdges === 0;
  const manifold = {
    passed: manifoldPassed,
    details: manifoldPassed
      ? 'Mesh is manifold and watertight'
      : `Non-manifold edges: ${nonManifoldEdges}, boundary edges: ${boundaryEdges}`,
  };

  const fragmentCount = result.triCount === 0 ? 0 : findConnectedComponents(topology).length;
  return {
    manifold,
    disconnected: { passed: fragmentCount <= 1, fragmentCount },
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

    // Only count as outer deviation if the point is outside the original mesh
    const signed = originalBvh.signedDistance([cx, cy, cz]);
    if (signed > maxDev) maxDev = signed;
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
