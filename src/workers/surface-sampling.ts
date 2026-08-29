import { addMeshTriangleArea, validateMeshPositions } from '../geometry/mesh-limits';
import type { SurfaceHexSample } from '../geometry/lattice';
import type { RandomSource } from '../geometry/deterministic-random';
import {
  createDeterministicRandom,
  DEFAULT_GENERATION_SEED,
  deriveGenerationSeed,
} from '../geometry/deterministic-random';
import type { SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import { cross, length, normalize, sub } from '../geometry/vec3';

export type ShapeSampleParams = {
  radius?: number;
  halfSize?: number;
  cylRadius?: number;
  cylHalfHeight?: number;
  torusMajor?: number;
  torusTube?: number;
  capRadius?: number;
  capHalfHeight?: number;
};

export type IndexedSurfaceHexSample = SurfaceHexSample & { triangleIndex: number };

export type MeshSampler = {
  sample: () => IndexedSurfaceHexSample;
  totalArea: number;
  cumulativeAreas: Float64Array;
};

export const SURFACE_SAMPLE_STREAM_COUNT = 4;

export type SurfaceSampleJob = {
  streamId: number;
  targetCount: number;
  streamSeed: number;
};

export function buildSurfaceSampleJobs(
  generationSeed: number,
  shape: SampleShape | 'mesh',
  targetCount: number,
): SurfaceSampleJob[] {
  const streamCount = Math.min(SURFACE_SAMPLE_STREAM_COUNT, Math.max(1, targetCount));
  const baseCount = Math.floor(targetCount / streamCount);
  const remainder = targetCount % streamCount;
  return Array.from({ length: streamCount }, (_, streamId) => ({
    streamId,
    targetCount: baseCount + (streamId < remainder ? 1 : 0),
    streamSeed: deriveGenerationSeed(generationSeed, 'surface-sampling', shape, 'stream', streamId),
  }));
}

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

/** Lower-bound search for the first triangle whose cumulative area is > target. */
export function pickTriangleIndex(
  cumulativeAreas: Float64Array,
  totalArea: number,
  random: RandomSource,
): number {
  if (cumulativeAreas.length === 0 || !(totalArea > 0) || !Number.isFinite(totalArea)) return -1;
  const target = Math.min(totalArea * random(), totalArea - Number.EPSILON * Math.max(1, totalArea));
  let lo = 0;
  let hi = cumulativeAreas.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cumulativeAreas[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo < cumulativeAreas.length ? lo : -1;
}

function sampleTriangle(a: Vec3, b: Vec3, c: Vec3, random: RandomSource): Vec3 {
  const r1 = random();
  const r2 = random();
  const sqrtR1 = Math.sqrt(r1);
  const u = 1 - sqrtR1;
  const v = sqrtR1 * (1 - r2);
  const w = sqrtR1 * r2;
  return [
    a[0] * u + b[0] * v + c[0] * w,
    a[1] * u + b[1] * v + c[1] * w,
    a[2] * u + b[2] * v + c[2] * w,
  ];
}

export function buildMeshSampler(
  positions: Float32Array,
  normals: Float32Array,
  triCount: number,
  keepOutTris: ReadonlySet<number>,
  random: RandomSource = createDeterministicRandom(DEFAULT_GENERATION_SEED, 'surface', 'mesh'),
): MeshSampler | null {
  validateMeshPositions(positions);
  if (!Number.isInteger(triCount) || triCount < 0) throw new Error('Mesh triangle count must be a non-negative integer');
  if (positions.length < triCount * 9 || normals.length < triCount * 3) {
    throw new Error('Mesh buffers are smaller than the declared triangle count');
  }

  const cumulativeAreas = new Float64Array(triCount);
  let totalArea = 0;
  for (let triangleIndex = 0; triangleIndex < triCount; triangleIndex++) {
    if (!keepOutTris.has(triangleIndex)) {
      const offset = triangleIndex * 9;
      const a: Vec3 = [positions[offset], positions[offset + 1], positions[offset + 2]];
      const b: Vec3 = [positions[offset + 3], positions[offset + 4], positions[offset + 5]];
      const c: Vec3 = [positions[offset + 6], positions[offset + 7], positions[offset + 8]];
      const area = triangleArea(a, b, c);
      if (area > 0) totalArea = addMeshTriangleArea(totalArea, area);
    }
    // Excluded and zero-area triangles retain the preceding cumulative value.
    cumulativeAreas[triangleIndex] = totalArea;
  }
  if (totalArea <= 1e-6) return null;

  return {
    totalArea,
    cumulativeAreas,
    sample: () => {
      const triangleIndex = pickTriangleIndex(cumulativeAreas, totalArea, random);
      if (triangleIndex < 0) throw new Error('Mesh sampler could not select an eligible triangle');
      const offset = triangleIndex * 9;
      const a: Vec3 = [positions[offset], positions[offset + 1], positions[offset + 2]];
      const b: Vec3 = [positions[offset + 3], positions[offset + 4], positions[offset + 5]];
      const c: Vec3 = [positions[offset + 6], positions[offset + 7], positions[offset + 8]];
      const normalOffset = triangleIndex * 3;
      return {
        pos: sampleTriangle(a, b, c, random),
        normal: normalize([
          normals[normalOffset],
          normals[normalOffset + 1],
          normals[normalOffset + 2],
        ]),
        triangleIndex,
      };
    },
  };
}

export function sampleSurfacePointForShape(
  shape: SampleShape,
  params: ShapeSampleParams,
  random: RandomSource,
): SurfaceHexSample {
  if (shape === 'sphere') {
    const radius = params.radius ?? 25;
    const theta = 2 * Math.PI * random();
    const phi = Math.acos(2 * random() - 1);
    const x = radius * Math.sin(phi) * Math.cos(theta);
    const y = radius * Math.sin(phi) * Math.sin(theta);
    const z = radius * Math.cos(phi);
    const pos: Vec3 = [x, y, z];
    return { pos, normal: normalize(pos) };
  }
  if (shape === 'cube') {
    const halfSize = params.halfSize ?? 15;
    const face = Math.floor(random() * 6);
    const u = (random() * 2 - 1) * halfSize;
    const v = (random() * 2 - 1) * halfSize;
    switch (face) {
      case 0: return { pos: [halfSize, u, v], normal: [1, 0, 0] };
      case 1: return { pos: [-halfSize, u, v], normal: [-1, 0, 0] };
      case 2: return { pos: [u, halfSize, v], normal: [0, 1, 0] };
      case 3: return { pos: [u, -halfSize, v], normal: [0, -1, 0] };
      case 4: return { pos: [u, v, halfSize], normal: [0, 0, 1] };
      default: return { pos: [u, v, -halfSize], normal: [0, 0, -1] };
    }
  }
  if (shape === 'cylinder') {
    const radius = params.cylRadius ?? 15;
    const halfHeight = params.cylHalfHeight ?? 20;
    const sideArea = 4 * Math.PI * radius * halfHeight;
    const capArea = Math.PI * radius * radius;
    const pick = random() * (sideArea + 2 * capArea);
    if (pick < sideArea) {
      const theta = random() * 2 * Math.PI;
      const z = (random() * 2 - 1) * halfHeight;
      const x = radius * Math.cos(theta);
      const y = radius * Math.sin(theta);
      return { pos: [x, y, z], normal: normalize([x, y, 0]) };
    }
    const theta = random() * 2 * Math.PI;
    const sampleRadius = Math.sqrt(random()) * radius;
    const top = pick < sideArea + capArea;
    return {
      pos: [sampleRadius * Math.cos(theta), sampleRadius * Math.sin(theta), top ? halfHeight : -halfHeight],
      normal: [0, 0, top ? 1 : -1],
    };
  }
  if (shape === 'torus') {
    const major = params.torusMajor ?? 20;
    const tube = params.torusTube ?? 8;
    const u = random() * 2 * Math.PI;
    const v = random() * 2 * Math.PI;
    const ring = major + tube * Math.cos(v);
    return {
      pos: [ring * Math.cos(u), ring * Math.sin(u), tube * Math.sin(v)],
      normal: normalize([Math.cos(u) * Math.cos(v), Math.sin(u) * Math.cos(v), Math.sin(v)]),
    };
  }

  const radius = params.capRadius ?? 12;
  const halfHeight = params.capHalfHeight ?? 15;
  const cylinderArea = 4 * Math.PI * radius * halfHeight;
  const sphereArea = 4 * Math.PI * radius * radius;
  if (random() * (cylinderArea + sphereArea) < cylinderArea) {
    const theta = random() * 2 * Math.PI;
    const z = (random() * 2 - 1) * halfHeight;
    const x = radius * Math.cos(theta);
    const y = radius * Math.sin(theta);
    return { pos: [x, y, z], normal: normalize([x, y, 0]) };
  }
  const theta = 2 * Math.PI * random();
  const phi = Math.acos(2 * random() - 1);
  const sx = radius * Math.sin(phi) * Math.cos(theta);
  const sy = radius * Math.sin(phi) * Math.sin(theta);
  const sz = radius * Math.cos(phi);
  const centerZ = random() > 0.5 ? halfHeight : -halfHeight;
  return { pos: [sx, sy, sz + centerZ], normal: normalize([sx, sy, sz]) };
}

export function generatePoissonSamples(
  sampler: () => SurfaceHexSample,
  targetCount: number,
  minDistance: number,
): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  let currentMin = minDistance;
  let attempts = 0;
  while (samples.length < targetCount && attempts < 6) {
    const grid = new Map<string, SurfaceHexSample[]>();
    for (const sample of samples) {
      const key = `${Math.floor(sample.pos[0] / currentMin)},${Math.floor(sample.pos[1] / currentMin)},${Math.floor(sample.pos[2] / currentMin)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(sample);
      else grid.set(key, [sample]);
    }
    const batchCount = Math.max(targetCount * 3, 200);
    for (let i = 0; i < batchCount && samples.length < targetCount; i++) {
      const candidate = sampler();
      const cx = Math.floor(candidate.pos[0] / currentMin);
      const cy = Math.floor(candidate.pos[1] / currentMin);
      const cz = Math.floor(candidate.pos[2] / currentMin);
      let accepted = true;
      for (let dx = -1; dx <= 1 && accepted; dx++) {
        for (let dy = -1; dy <= 1 && accepted; dy++) {
          for (let dz = -1; dz <= 1 && accepted; dz++) {
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const other of bucket) {
              if (length(sub(candidate.pos, other.pos)) < currentMin) {
                accepted = false;
                break;
              }
            }
          }
        }
      }
      if (accepted) {
        samples.push(candidate);
        const key = `${cx},${cy},${cz}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(candidate);
        else grid.set(key, [candidate]);
      }
    }
    if (samples.length < targetCount) {
      currentMin *= 0.85;
      attempts++;
    }
  }
  return samples;
}

export function generateShapeSurfaceSamples(
  shape: SampleShape,
  params: ShapeSampleParams,
  targetCount: number,
  minDistance: number,
  streamSeed: number,
): SurfaceHexSample[] {
  const random = createDeterministicRandom(streamSeed, 'shape-surface-samples');
  return generatePoissonSamples(
    () => sampleSurfacePointForShape(shape, params, random),
    targetCount,
    minDistance,
  );
}
