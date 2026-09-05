// Validation: check deviation, thickness, manifoldness, disconnected pieces
import type { Vec3 } from './vec3';
import type { MeshBVH } from './bvh';
import type { LatticeParams, ValidationResult } from '../types/project';
import type { MarchingCubesResult } from './marching-cubes';
import { buildEdgeTopology, countEdgeDefects, findConnectedComponents } from './mesh-topology';

export function checkTopology(result: MarchingCubesResult): {
  manifold: { passed: boolean; details: string };
  disconnected: { passed: boolean; fragmentCount: number };
} {
  if (result.triCount === 0) {
    return {
      manifold: { passed: false, details: 'Mesh is empty; no printable surface' },
      disconnected: { passed: false, fragmentCount: 0 },
    };
  }
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

function sdfNormal(
  sdf: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  step: number,
): Vec3 | null {
  const gx = sdf(x + step, y, z) - sdf(x - step, y, z);
  const gy = sdf(x, y + step, z) - sdf(x, y - step, z);
  const gz = sdf(x, y, z + step) - sdf(x, y, z - step);
  const magnitude = Math.hypot(gx, gy, gz);
  if (magnitude < 1e-12) return null;
  return [gx / magnitude, gy / magnitude, gz / magnitude];
}

function bisectCrossing(
  sdf: (x: number, y: number, z: number) => number,
  origin: Vec3,
  direction: Vec3,
  inside: number,
  outside: number,
): number {
  let insideDistance = inside;
  let outsideDistance = outside;
  for (let iteration = 0; iteration < 28; iteration++) {
    const midpoint = (insideDistance + outsideDistance) * 0.5;
    const value = sdf(
      origin[0] + direction[0] * midpoint,
      origin[1] + direction[1] * midpoint,
      origin[2] + direction[2] * midpoint,
    );
    if (value <= 0) insideDistance = midpoint;
    else outsideDistance = midpoint;
  }
  return (insideDistance + outsideDistance) * 0.5;
}

/**
 * Measure local wall thickness from the scalar-field gradient, not extracted
 * triangle winding. Both field crossings are bisection-refined. The 1st
 * percentile remains a representative measurement, while every measured ray
 * must meet the required minimum for validation to pass.
 */
export function checkMinThickness(
  sdf: (x: number, y: number, z: number) => number,
  result: MarchingCubesResult,
  minRequired: number,
  sampleCount: number = 1500,
): { passed: boolean; minMeasured: number; absoluteMin: number; sampled: number } {
  const { positions, triCount } = result;
  const stride = Math.max(1, Math.floor(triCount / sampleCount));
  const marchStep = minRequired / 16;
  const maxDepth = minRequired * 4;
  const gradientStep = Math.max(1e-4, minRequired * 0.01);
  const thicknesses: number[] = [];

  for (let i = 0; i < triCount; i += stride) {
    const o = i * 9;
    const px = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const py = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const pz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;

    const outward = sdfNormal(sdf, px, py, pz, gradientStep);
    if (!outward) continue;
    const inward: Vec3 = [-outward[0], -outward[1], -outward[2]];
    const origin: Vec3 = [px, py, pz];

    let seed = -1;
    for (let distance = 0; distance <= marchStep * 4; distance += marchStep) {
      if (sdf(
        origin[0] + inward[0] * distance,
        origin[1] + inward[1] * distance,
        origin[2] + inward[2] * distance,
      ) <= 0) {
        seed = distance;
        break;
      }
    }
    if (seed < 0) continue;

    const crossing = (sign: number): number => {
      let lastInside = seed;
      for (let distance = marchStep; distance <= maxDepth; distance += marchStep) {
        const candidate = seed + sign * distance;
        const value = sdf(
          origin[0] + inward[0] * candidate,
          origin[1] + inward[1] * candidate,
          origin[2] + inward[2] * candidate,
        );
        if (value > 0) return bisectCrossing(sdf, origin, inward, lastInside, candidate);
        lastInside = candidate;
      }
      return Number.NaN;
    };

    const far = crossing(1);
    const near = crossing(-1);
    if (!Number.isFinite(far) || !Number.isFinite(near)) continue;
    const thickness = far - near;
    if (thickness > 0) thicknesses.push(thickness);
  }

  if (thicknesses.length === 0) {
    // Keep numeric fields serializable; sampled=0 means unavailable, not 0mm.
    return { passed: false, minMeasured: 0, absoluteMin: 0, sampled: 0 };
  }

  thicknesses.sort((a, b) => a - b);
  const percentileIndex = Math.min(
    thicknesses.length - 1,
    Math.floor(thicknesses.length * 0.01),
  );
  const minMeasured = thicknesses[percentileIndex];
  const absoluteMin = thicknesses[0];
  return {
    passed: absoluteMin >= minRequired - 1e-3,
    minMeasured,
    absoluteMin,
    sampled: thicknesses.length,
  };
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
  if (minThickness.sampled === 0) warnings.push('Minimum thickness could not be measured');

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
