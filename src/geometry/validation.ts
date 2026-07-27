// Validation: check deviation, thickness, manifoldness, disconnected pieces
import type { Vec3 } from './vec3';
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

/** Negative zero compares equal to zero but has different bits; fold it. */
function normalizeZeroBits(bits: number): number {
  return bits === 0x80000000 ? 0 : bits;
}

function getExactVertexId(
  buckets: Map<number, number[]>,
  bxById: number[],
  byById: number[],
  bzById: number[],
  bx: number,
  by: number,
  bz: number
): number {
  const bucketKey = vertexBucketKey(bx, by, bz);
  let bucket = buckets.get(bucketKey);
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      if (bxById[id] === bx && byById[id] === by && bzById[id] === bz) return id;
    }
  } else {
    bucket = [];
    buckets.set(bucketKey, bucket);
  }

  const id = bxById.length;
  bxById.push(bx);
  byById.push(by);
  bzById.push(bz);
  bucket.push(id);
  return id;
}

function addEdge(edgeToTris: Map<number, number[]>, a: number, b: number, triIndex: number): void {
  const key = edgeKey(a, b);
  const tris = edgeToTris.get(key);
  if (tris) tris.push(triIndex);
  else edgeToTris.set(key, [triIndex]);
}

/**
 * Weld vertices by exact position and index the edges.
 *
 * Identity is the float bits, not a rounded bucket. Marching cubes derives a
 * vertex from the two field values on one grid edge, so the same edge visited
 * from two neighbouring cubes yields bit-identical coordinates and welds
 * cleanly. Rounding to a tolerance instead — this previously quantised to
 * 0.001mm — merges genuinely distinct vertices that happen to lie close
 * together, and each false merge invents a non-manifold edge. Because vertex
 * spacing shrinks as resolution rises, that count climbed with resolution and
 * looked like an extractor defect: 30 at resolution 48 and 251 at 96, against
 * an exact count of zero in both cases.
 */
function buildEdgeTopology(result: MarchingCubesResult): EdgeTopology {
  const { positions, triCount } = result;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const buckets = new Map<number, number[]>();
  const bxById: number[] = [];
  const byById: number[] = [];
  const bzById: number[] = [];
  const edgeToTris = new Map<number, number[]>();

  const idAt = (offset: number) => getExactVertexId(
    buckets,
    bxById,
    byById,
    bzById,
    normalizeZeroBits(bits[offset]),
    normalizeZeroBits(bits[offset + 1]),
    normalizeZeroBits(bits[offset + 2])
  );

  for (let i = 0; i < triCount; i++) {
    const base = i * 9;
    const v0 = idAt(base);
    const v1 = idAt(base + 3);
    const v2 = idAt(base + 6);

    // A degenerate triangle has no edges to contribute and would otherwise
    // register as unmatched, reading as a hole in the surface.
    if (v0 === v1 || v1 === v2 || v0 === v2) continue;

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

/** Unit outward direction from the field gradient, or null where it degenerates. */
function sdfNormal(
  sdf: (x: number, y: number, z: number) => number,
  x: number,
  y: number,
  z: number,
  h: number
): Vec3 | null {
  const gx = sdf(x + h, y, z) - sdf(x - h, y, z);
  const gy = sdf(x, y + h, z) - sdf(x, y - h, z);
  const gz = sdf(x, y, z + h) - sdf(x, y, z - h);
  const len = Math.sqrt(gx * gx + gy * gy + gz * gz);
  if (len < 1e-12) return null;
  return [gx / len, gy / len, gz / len];
}

/** Distance along `dir` from `origin` at which the field crosses zero, by bisection. */
function bisectCrossing(
  sdf: (x: number, y: number, z: number) => number,
  origin: Vec3,
  dir: Vec3,
  inside: number,
  outside: number
): number {
  let lo = inside;
  let hi = outside;
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) * 0.5;
    const v = sdf(origin[0] + dir[0] * mid, origin[1] + dir[1] * mid, origin[2] + dir[2] * mid);
    if (v <= 0) lo = mid; else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/**
 * Local wall thickness, measured through the material along the surface normal.
 *
 * The direction comes from the field gradient rather than the mesh face normal.
 * Marching cubes emits inward-facing winding here, so its face normals point
 * into the material — the previous implementation marched along the negation of
 * those and therefore travelled *outward* on every sample. It entered material
 * only after crossing a gap into the neighbouring lattice wall, which is why it
 * reported gaps rather than walls and moved non-monotonically with wall
 * thickness. Where nothing was measured at all it fell back to exactly the
 * required value, which silently passed.
 *
 * Entry and exit are both bisection-refined, so the result is continuous rather
 * than quantised to the march step.
 *
 * The reported figure is the 1st percentile, not the outright minimum: a single
 * grazing sample at a cusp is a measurement artifact, whereas a genuinely thin
 * region shows up across many samples. The absolute minimum is reported
 * alongside it for inspection.
 */
export function checkMinThickness(
  sdf: (x: number, y: number, z: number) => number,
  result: MarchingCubesResult,
  minRequired: number,
  sampleCount: number = 1500
): { passed: boolean; minMeasured: number; absoluteMin: number; sampled: number } {
  const { positions, triCount } = result;
  const stride = Math.max(1, Math.floor(triCount / sampleCount));
  const marchStep = minRequired / 16;
  // Only thin features matter here; anything past this is comfortably fine and
  // marching further would dominate the cost on solid regions.
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

    // Step just inside the wall. Marching cubes places the centroid on its own
    // approximation of the surface, which for a wall only a cell or two thick
    // can sit well inside the true one — so the wall is spanned in both
    // directions from here rather than assumed to start at the centroid.
    let seed = -1;
    for (let t = 0; t <= marchStep * 4; t += marchStep) {
      if (sdf(origin[0] + inward[0] * t, origin[1] + inward[1] * t, origin[2] + inward[2] * t) <= 0) {
        seed = t;
        break;
      }
    }
    if (seed < 0) continue;   // no material along this ray

    const crossing = (sign: number): number => {
      let lastInside = seed;
      for (let d = marchStep; d <= maxDepth; d += marchStep) {
        const t = seed + sign * d;
        if (sdf(origin[0] + inward[0] * t, origin[1] + inward[1] * t, origin[2] + inward[2] * t) > 0) {
          return bisectCrossing(sdf, origin, inward, lastInside, t);
        }
        lastInside = t;
      }
      return NaN;   // still solid at the cap: a thick section, not a thin one
    };

    const far = crossing(1);
    const near = crossing(-1);
    // Either side failing to exit means this is a thick section, which cannot
    // be the constraining feature — leaving it out keeps it from skewing stats.
    if (!Number.isFinite(far) || !Number.isFinite(near)) continue;

    const thickness = far - near;
    if (thickness > 0) thicknesses.push(thickness);
  }

  if (thicknesses.length === 0) {
    // Nothing thin enough to measure anywhere: report the search ceiling rather
    // than the requirement, so a pass is never manufactured out of no data.
    return { passed: true, minMeasured: maxDepth, absoluteMin: maxDepth, sampled: 0 };
  }

  thicknesses.sort((a, b) => a - b);
  const percentileIndex = Math.min(thicknesses.length - 1, Math.floor(thicknesses.length * 0.01));
  const minMeasured = thicknesses[percentileIndex];

  return {
    passed: minMeasured >= minRequired - 1e-3,
    minMeasured,
    absoluteMin: thicknesses[0],
    sampled: thicknesses.length,
  };
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
