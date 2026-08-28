// Web Worker for lattice generation (SDF sampling + marching cubes)
// This runs heavy computation off the main thread.

import {
  marchingCubesFromField,
  sampleSdfField,
  sealFieldBoundary,
} from '../geometry/marching-cubes';
import type { GridSdfSampler } from '../geometry/marching-cubes';
import { openField, openingIsResolvable } from '../geometry/morphology';
import { buildCombinedSDF, buildSurfaceHexLattice, buildSphereLattice, buildCubeLattice, buildCylinderLattice, buildTorusLattice, buildCapsuleLattice } from '../geometry/lattice';
import { MeshBVH } from '../geometry/bvh';
import { closeBoundaryLoops } from '../geometry/mesh-repair';
import {
  cutEscapeHolesInField,
  shouldApplyEscapeHoles,
} from '../geometry/escape-holes';
import type { LatticeParams, ValidationResult, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import { add, sub, dot, length, scale, normalize } from '../geometry/vec3';
import type { SurfaceHexSample } from '../geometry/lattice';
import type { TileBackend } from './tile-types';
import {
  ENABLE_SPARSE_TILE_SKIPPING,
  runTiledGeneration,
  terminateTileWorkers,
  TILE_SIZE,
  tileWorkerCount,
} from './tiled-generation';
import { estimateGenerationTimings, formatDuration } from './generation-estimate';
import { surfaceSampleTargetCount } from './surface-sampling-limits';
import {
  buildMeshSampler,
  buildSurfaceSampleJobs,
  generatePoissonSamples,
  generateShapeSurfaceSamples,
  sampleSurfacePointForShape,
  type ShapeSampleParams,
} from './surface-sampling';
import {
  createDeterministicRandom,
  normalizeGenerationSeed,
} from '../geometry/deterministic-random';
import { createProgressReporter } from './progress-reporter';

type SdfFunction = ((x: number, y: number, z: number) => number) & Partial<GridSdfSampler>;
type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

function generatedResultTransferList(response: WorkerResponse): Transferable[] {
  const transfers: Transferable[] = [];
  // Generated result buffers are worker-owned after marching/cleanup and are
  // transferred to the UI so the viewer receives usable Float32Arrays without
  // copying the large position/normal payloads.
  if (response.positions) transfers.push(response.positions.buffer);
  if (response.normals) transfers.push(response.normals.buffer);
  if (response.surfaceSamplePositions) transfers.push(response.surfaceSamplePositions.buffer);
  if (response.surfaceSampleNormals) transfers.push(response.surfaceSampleNormals.buffer);
  if (response.surfaceSampleHoleScales) transfers.push(response.surfaceSampleHoleScales.buffer);
  return transfers;
}

function isSharedFloat32Array(value: Float32Array): boolean {
  return typeof SharedArrayBuffer === 'function' && value.buffer instanceof SharedArrayBuffer;
}

function packSurfaceSamples(samples: SurfaceHexSample[]): {
  positions: Float32Array;
  normals: Float32Array;
  holeScales: Float32Array;
} | null {
  if (samples.length === 0) return null;
  const positions = new Float32Array(samples.length * 3);
  const normals = new Float32Array(samples.length * 3);
  const holeScales = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    positions[i * 3] = sample.pos[0];
    positions[i * 3 + 1] = sample.pos[1];
    positions[i * 3 + 2] = sample.pos[2];
    normals[i * 3] = sample.normal[0];
    normals[i * 3 + 1] = sample.normal[1];
    normals[i * 3 + 2] = sample.normal[2];
    holeScales[i] = sample.holeScale ?? 1;
  }
  return { positions, normals, holeScales };
}

export interface WorkerMessage {
  type: 'generate' | 'validate' | 'cancel';
  // For generate:
  meshPositions?: Float32Array;
  meshNormals?: Float32Array;
  meshTriCount?: number;
  meshBufferKind?: 'shared' | 'transfer';
  params?: LatticeParams;
  sphereMode?: boolean;
  sphereRadius?: number;
  sampleShape?: SampleShape | null;
  resolution?: number;
  keepOutTris?: number[];
  keepInTris?: number[];
  demoMode?: boolean;
  generationSeed?: number;
}

export interface WorkerResponse {
  type: 'progress' | 'result' | 'validation' | 'error';
  progress?: number;
  message?: string;
  positions?: Float32Array;
  normals?: Float32Array;
  triCount?: number;
  validation?: ValidationResult;
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
  /** Set when the requested feature width is smaller than the sample grid. */
  thinFilterSkipped?: string;
  backend?: TileBackend;
  transient?: boolean;
}

let cancelled = false;

type SurfaceSampleWorkerResponse = {
  streamId: number;
  positions: Float32Array;
  normals: Float32Array;
};

type ShapeSampleWorkerMessage = {
  mode: 'shape';
  shape: SampleShape;
  params: ShapeSampleParams;
  targetCount: number;
  minDistance: number;
  streamSeed: number;
  streamId: number;
};

async function generatePoissonSamplesParallel(
  shape: SampleShape,
  params: ShapeSampleParams,
  targetCount: number,
  minDistance: number,
  generationSeed: number,
  maxWorkers = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency ?? 2) - 1))
): Promise<SurfaceHexSample[]> {
  const jobs = buildSurfaceSampleJobs(generationSeed, shape, targetCount);
  const results: SurfaceHexSample[][] = Array.from({ length: jobs.length }, () => []);
  let nextJob = 0;

  const runJob = async () => {
    while (nextJob < jobs.length) {
      const job = jobs[nextJob++];
      if (maxWorkers <= 1) {
        results[job.streamId] = generateShapeSurfaceSamples(
          shape,
          params,
          job.targetCount,
          minDistance,
          job.streamSeed,
        );
        continue;
      }

      const worker = new Worker(new URL('./surface-sample-worker.ts', import.meta.url), { type: 'module' });
      const response = await new Promise<SurfaceSampleWorkerResponse>((resolve, reject) => {
        worker.onmessage = (event: MessageEvent<SurfaceSampleWorkerResponse>) => resolve(event.data);
        worker.onerror = () => reject(new Error('Surface sampling worker failed'));
        worker.onmessageerror = () => reject(new Error('Surface sampling worker returned an unreadable response'));
        const payload: ShapeSampleWorkerMessage = {
          mode: 'shape',
          shape,
          params,
          targetCount: job.targetCount,
          minDistance,
          streamSeed: job.streamSeed,
          streamId: job.streamId,
        };
        worker.postMessage(payload);
      }).finally(() => worker.terminate());
      if (
        response.streamId !== job.streamId
        || !(response.positions instanceof Float32Array)
        || !(response.normals instanceof Float32Array)
        || response.positions.length !== response.normals.length
        || response.positions.length % 3 !== 0
      ) {
        throw new Error('Surface sampling worker returned a malformed response');
      }
      const samples: SurfaceHexSample[] = [];
      for (let j = 0; j < response.positions.length; j += 3) {
        samples.push({
          pos: [response.positions[j], response.positions[j + 1], response.positions[j + 2]],
          normal: normalize([response.normals[j], response.normals[j + 1], response.normals[j + 2]]),
        });
      }
      results[job.streamId] = samples;
    }
  };

  const physicalWorkers = Math.min(Math.max(1, maxWorkers), jobs.length);
  await Promise.all(Array.from({ length: physicalWorkers }, () => runJob()));
  return results.flat().slice(0, targetCount);
}
type SurfaceSamplerTarget = {
  samples: SurfaceHexSample[];
  project: (p: Vec3) => { pos: Vec3; normal: Vec3 };
};

function estimateNormal(
  sdf: (x: number, y: number, z: number) => number,
  p: Vec3,
  eps: number
): Vec3 {
  const dx = sdf(p[0] + eps, p[1], p[2]) - sdf(p[0] - eps, p[1], p[2]);
  const dy = sdf(p[0], p[1] + eps, p[2]) - sdf(p[0], p[1] - eps, p[2]);
  const dz = sdf(p[0], p[1], p[2] + eps) - sdf(p[0], p[1], p[2] - eps);
  return normalize([dx, dy, dz]);
}

function projectToSurfaceSdf(
  sdf: (x: number, y: number, z: number) => number,
  p: Vec3,
  cellSize: number
): { pos: Vec3; normal: Vec3 } {
  const eps = Math.max(0.05, cellSize * 0.02);
  const d = sdf(p[0], p[1], p[2]);
  const n = estimateNormal(sdf, p, eps);
  const projected = sub(p, scale(n, d));
  const n2 = estimateNormal(sdf, projected, eps);
  return { pos: projected, normal: n2 };
}

function buildFibonacciSphereSamples(radius: number, count: number): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const z = 1 - 2 * t;
    const ring = Math.sqrt(1 - z * z);
    const theta = goldenAngle * i;
    const x = Math.cos(theta) * ring;
    const y = Math.sin(theta) * ring;
    const pos: Vec3 = [x * radius, y * radius, z * radius];
    samples.push({ pos, normal: normalize(pos) });
  }
  return samples;
}

function relaxSurfaceSamples(
  target: SurfaceSamplerTarget,
  cellSize: number,
  iterations: number,
  strength: number
): SurfaceHexSample[] {
  const samples = target.samples;
  if (samples.length === 0) return samples;
  for (let it = 0; it < iterations; it++) {
    const grid = new Map<string, SurfaceHexSample[]>();
    for (const sample of samples) {
      const key = `${Math.floor(sample.pos[0] / cellSize)},${Math.floor(sample.pos[1] / cellSize)},${Math.floor(sample.pos[2] / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(sample);
      else grid.set(key, [sample]);
    }

    for (const sample of samples) {
      const base = sample.pos;
      const cx = Math.floor(base[0] / cellSize);
      const cy = Math.floor(base[1] / cellSize);
      const cz = Math.floor(base[2] / cellSize);
      let push: Vec3 = [0, 0, 0];

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${cx + dx},${cy + dy},${cz + dz}`;
            const bucket = grid.get(key);
            if (!bucket) continue;
            for (const other of bucket) {
              if (other === sample) continue;
              const d = length(sub(base, other.pos));
              if (d > 1e-6 && d < cellSize) {
                const away = scale(sub(base, other.pos), (cellSize - d) / d);
                push = add(push, away);
              }
            }
          }
        }
      }

      const n = normalize(sample.normal);
      const normalComponent = scale(n, dot(push, n));
      const tangentMove = scale(sub(push, normalComponent), strength);
      sample.pos = add(sample.pos, tangentMove);
    }

    for (const sample of samples) {
      const projected = target.project(sample.pos);
      sample.pos = projected.pos;
      sample.normal = projected.normal;
    }
  }
  return samples;
}


function applyAdaptiveHoleScales(samples: SurfaceHexSample[], spacing: number): SurfaceHexSample[] {
  if (samples.length === 0) return samples;
  const cell = Math.max(0.1, spacing);
  const grid = new Map<string, SurfaceHexSample[]>();
  for (const sample of samples) {
    const key = `${Math.floor(sample.pos[0] / cell)},${Math.floor(sample.pos[1] / cell)},${Math.floor(sample.pos[2] / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(sample);
    else grid.set(key, [sample]);
  }

  for (const sample of samples) {
    const base = sample.pos;
    const cx = Math.floor(base[0] / cell);
    const cy = Math.floor(base[1] / cell);
    const cz = Math.floor(base[2] / cell);
    let nearest = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === sample) continue;
            const d = length(sub(base, other.pos));
            if (d > 1e-6 && d < nearest) nearest = d;
          }
        }
      }
    }

    if (!Number.isFinite(nearest)) {
      sample.holeScale = 1.0;
      continue;
    }
    // 0.866 = 2*cos(30°)/2 packing-safe factor for neighboring hex inradii
    const targetScale = (nearest / spacing) * 0.86;
    sample.holeScale = Math.max(0.72, Math.min(1.0, targetScale));
  }
  return samples;
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    terminateTileWorkers();
    return;
  }

  cancelled = false;

  if (msg.type === 'generate') {
    try {
      const generationStart = performance.now();
      const progressReporter = createProgressReporter((response) => postMessage(response));
      const params = msg.params!;
      const generationSeed = normalizeGenerationSeed(msg.generationSeed);
      const thinFilterActive = params.thinSectionFilter > 0;
      // Morphological opening must run before escape-hole subtraction so it
      // cannot silently change the requested hole diameter.
      const fieldParams = thinFilterActive && shouldApplyEscapeHoles(params)
        ? { ...params, escapeHoles: false }
        : params;
      const resolution = msg.resolution || 64;
      let sdf: SdfFunction;
      let objectSdf: ((x: number, y: number, z: number) => number) | null = null;
      let surfaceHexSdf: SdfFunction | null = null;
      let bounds: { min: Vec3; max: Vec3 };
      let sphereRadius: number | null = null;
      let thinFilterSkipped: string | null = null;
      let bvh: MeshBVH | null = null;
      let surfaceSamples: SurfaceHexSample[] = [];

      const isDemoGrid = Boolean(msg.demoMode);
      const shape = isDemoGrid ? null : (msg.sampleShape || (msg.sphereMode ? 'sphere' : null));
      const isSurfacePolygon = !isDemoGrid && params.variant === 'implicit_conformal' && (params.latticeType === 'hexagon' || params.latticeType === 'triangle');

      if (isDemoGrid) {
        const pad = params.cellSize * 0.5;
        const demoTypes: LatticeParams['latticeType'][] = [
          'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
          'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
        ];
        const cols = 4;
        const rows = Math.ceil(demoTypes.length / cols);
        const spacing = Math.max(20, params.cellSize * 2.6);
        const demoRadius = Math.max(7, Math.min(10, (msg.sphereRadius || 25) * 0.35));
        const windowHalf = Math.max(demoRadius + 1.8, spacing * 0.42);
        const baseParams: LatticeParams = { ...params, variant: 'shell_core', surfaceOnly: false, noShell: false };

        const boxSdf = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
          const dx = Math.abs(x) - hx;
          const dy = Math.abs(y) - hy;
          const dz = Math.abs(z) - hz;
          const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
          const inside = Math.min(Math.max(dx, dy, dz), 0);
          return outside + inside;
        };

        const cells = demoTypes.map((latticeType, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);
          const cx = (col - (cols - 1) / 2) * spacing;
          const cz = (row - (rows - 1) / 2) * spacing;
          const localParams: LatticeParams = { ...baseParams, latticeType };
          const sphereSdf = buildSphereLattice(demoRadius, localParams, generationSeed);
          return {
            cx,
            cz,
            sdf: (x: number, y: number, z: number) => {
              const localX = x - cx;
              const localZ = z - cz;
              return Math.max(
                sphereSdf(localX, y, localZ),
                boxSdf(localX, y, localZ, windowHalf, demoRadius + 2.2, windowHalf)
              );
            },
          };
        });

        const extentX = ((cols - 1) * spacing) * 0.5 + windowHalf + pad;
        const extentZ = ((rows - 1) * spacing) * 0.5 + windowHalf + pad;
        const extentY = demoRadius + 2.5 + pad;
        bounds = { min: [-extentX, -extentY, -extentZ], max: [extentX, extentY, extentZ] };

        sdf = (x, y, z) => {
          let d = Infinity;
          for (const c of cells) d = Math.min(d, c.sdf(x, y, z));
          return d;
        };

        postMessage({
          type: 'progress',
          progress: 0.06,
          message: `Demo grid ready: ${demoTypes.length} lattice types tiled on spheres`
        } as WorkerResponse);
      } else if (shape) {
        const pad = params.cellSize * 0.5;

        switch (shape) {
          case 'sphere': {
            sphereRadius = msg.sphereRadius || 25;
            const R = sphereRadius;
            bounds = { min: [-(R+pad), -(R+pad), -(R+pad)], max: [R+pad, R+pad, R+pad] };
            objectSdf = (x, y, z) => Math.sqrt(x * x + y * y + z * z) - R;
            sdf = isSurfacePolygon ? objectSdf : buildSphereLattice(R, fieldParams, generationSeed);
            break;
          }
          case 'cube': {
            const h = 15; // 30mm cube → halfSize 15
            bounds = { min: [-(h+pad), -(h+pad), -(h+pad)], max: [h+pad, h+pad, h+pad] };
            objectSdf = (x, y, z) => {
              const dx = Math.abs(x) - h;
              const dy = Math.abs(y) - h;
              const dz = Math.abs(z) - h;
              const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
              const inside = Math.min(Math.max(dx, dy, dz), 0);
              return outside + inside;
            };
            sdf = isSurfacePolygon ? objectSdf : buildCubeLattice(h, fieldParams, generationSeed);
            break;
          }
          case 'cylinder': {
            const cr = 15, ch = 20; // R=15, H=40 → halfH=20
            bounds = { min: [-cr-pad, -cr-pad, -ch-pad], max: [cr+pad, cr+pad, ch+pad] };
            objectSdf = (x, y, z) => {
              const dRadial = Math.sqrt(x * x + y * y) - cr;
              const dAxial = Math.abs(z) - ch;
              const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
              const inside = Math.min(Math.max(dRadial, dAxial), 0);
              return outside + inside;
            };
            sdf = isSurfacePolygon ? objectSdf : buildCylinderLattice(cr, ch, fieldParams, generationSeed);
            break;
          }
          case 'torus': {
            const mR = 20, tR = 8; // major=20, tube=8
            const xy = mR + tR + pad;
            bounds = { min: [-xy, -xy, -(tR+pad)], max: [xy, xy, tR+pad] };
            objectSdf = (x, y, z) => {
              const qx = Math.sqrt(x * x + y * y) - mR;
              return Math.sqrt(qx * qx + z * z) - tR;
            };
            sdf = isSurfacePolygon ? objectSdf : buildTorusLattice(mR, tR, fieldParams, generationSeed);
            break;
          }
          case 'capsule': {
            const capR = 12, capHH = 15; // R=12, H=30 → halfH=15, total extent = 15+12
            const capExt = capHH + capR + pad;
            bounds = { min: [-(capR+pad), -(capR+pad), -capExt], max: [capR+pad, capR+pad, capExt] };
            objectSdf = (x, y, z) => {
              const cz = Math.max(-capHH, Math.min(capHH, z));
              return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - capR;
            };
            sdf = isSurfacePolygon ? objectSdf : buildCapsuleLattice(capR, capHH, fieldParams, generationSeed);
            break;
          }
        }
        postMessage({ type: 'progress', progress: 0.05, message: `${shape} SDF ready` } as WorkerResponse);
        if (isSurfacePolygon) {
          const areaEstimate = (() => {
            switch (shape) {
              case 'sphere': return 4 * Math.PI * (sphereRadius ?? 25) ** 2;
              case 'cube': return 6 * (15 ** 2) * 4;
              case 'cylinder': return 2 * Math.PI * 15 * (40) + 2 * Math.PI * 15 * 15;
              case 'torus': return 4 * Math.PI * Math.PI * 20 * 8;
              case 'capsule': return 2 * Math.PI * 12 * (30) + 4 * Math.PI * 12 * 12;
              default: return 1000;
            }
          })();
          const sampleCount = surfaceSampleTargetCount(areaEstimate, params.cellSize);
          if (shape === 'sphere') {
            surfaceSamples = buildFibonacciSphereSamples(sphereRadius ?? 25, sampleCount);
          } else {
            const samplerParams = {
              radius: sphereRadius ?? 25,
              halfSize: 15,
              cylRadius: 15,
              cylHalfHeight: 20,
              torusMajor: 20,
              torusTube: 8,
              capRadius: 12,
              capHalfHeight: 15,
            };
            const fallbackRandom = createDeterministicRandom(
              generationSeed,
              'surface-sampling',
              shape,
              'fallback',
            );
            const fallbackSampler = () => sampleSurfacePointForShape(shape, samplerParams, fallbackRandom);
            surfaceSamples = await generatePoissonSamplesParallel(
              shape,
              samplerParams,
              sampleCount,
              params.cellSize * 0.75,
              generationSeed,
            );
            if (surfaceSamples.length < Math.floor(sampleCount * 0.8)) {
              surfaceSamples = generatePoissonSamples(fallbackSampler, sampleCount, params.cellSize * 0.75);
            }
          }
          const target: SurfaceSamplerTarget = {
            samples: surfaceSamples,
            project: (p) => projectToSurfaceSdf(objectSdf!, p, params.cellSize),
          };
          relaxSurfaceSamples(target, params.cellSize * 0.95, 10, 0.35);
          applyAdaptiveHoleScales(surfaceSamples, params.cellSize);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, fieldParams, surfaceSamples);
        }
      } else {
        // Build BVH from mesh
        const meshBufferKind = msg.meshBufferKind ?? (isSharedFloat32Array(msg.meshPositions!) ? 'shared' : 'transfer');
        postMessage({
          type: 'progress',
          progress: 0.01,
          message: `Mesh buffers: ${meshBufferKind === 'shared' ? 'SharedArrayBuffer shared-memory' : 'ArrayBuffer transfer'} path active`
        } as WorkerResponse);
        postMessage({ type: 'progress', progress: 0.02, message: 'Building BVH...' } as WorkerResponse);
        bvh = new MeshBVH(msg.meshPositions!, msg.meshNormals!, msg.meshTriCount!);

        // Compute bounds
        const positions = msg.meshPositions!;
        const mn: Vec3 = [Infinity, Infinity, Infinity];
        const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) {
          for (let d = 0; d < 3; d++) {
            if (positions[i + d] < mn[d]) mn[d] = positions[i + d];
            if (positions[i + d] > mx[d]) mx[d] = positions[i + d];
          }
        }
        const pad = params.cellSize * 0.5;
        bounds = {
          min: [mn[0] - pad, mn[1] - pad, mn[2] - pad],
          max: [mx[0] + pad, mx[1] + pad, mx[2] + pad],
        };

        postMessage({ type: 'progress', progress: 0.1, message: 'BVH built, computing SDF...' } as WorkerResponse);

        const keepOutSet = new Set(msg.keepOutTris || []);
        const keepInSet = new Set(msg.keepInTris || []);
        objectSdf = (x, y, z) => bvh!.signedDistance([x, y, z]);
        sdf = buildCombinedSDF({
          bvh,
          params: fieldParams,
          generationSeed,
          keepOutTris: keepOutSet,
          keepInTris: keepInSet,
        });
        if (keepOutSet.size > 0 || keepInSet.size > 0) {
          postMessage({
            type: 'progress',
            progress: 0.1,
            message: `Constraints active: ${keepOutSet.size} keep-out, ${keepInSet.size} keep-in triangles`,
          } as WorkerResponse);
        }
        if (isSurfacePolygon) {
          const positions = msg.meshPositions!;
          const normals = msg.meshNormals!;
          const triCount = msg.meshTriCount!;
          const meshSampler = buildMeshSampler(
            positions,
            normals,
            triCount,
            keepOutSet,
            createDeterministicRandom(generationSeed, 'surface-sampling', 'mesh'),
          );
          const totalArea = meshSampler?.totalArea ?? 0;
          const sampleCount = surfaceSampleTargetCount(totalArea, params.cellSize);
          if (meshSampler) {
            surfaceSamples = generatePoissonSamples(meshSampler.sample, sampleCount, params.cellSize * 0.75);
          }
          const target: SurfaceSamplerTarget = {
            samples: surfaceSamples,
            project: (p) => {
              const res = bvh!.closestPoint(p);
              const ni = res.triIndex * 3;
              const normal = normalize([normals[ni], normals[ni + 1], normals[ni + 2]]);
              return { pos: res.point, normal };
            },
          };
          relaxSurfaceSamples(target, params.cellSize * 0.95, 10, 0.35);
          applyAdaptiveHoleScales(surfaceSamples, params.cellSize);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, fieldParams, surfaceSamples);
        }
      }

      // Morphological opening is a whole-volume distance transform; tiling it
      // would make neighbouring seams disagree.
      const tileWorkerPoolAvailable = Boolean(
        shape
        && !isSurfacePolygon
        && !isDemoGrid
        && !thinFilterActive
        && tileWorkerCount() > 0
      );
      const selectedBackend: TileBackend = tileWorkerPoolAvailable ? 'cpu-tiled' : 'cpu-single';
      postMessage({
        type: 'progress',
        progress: 0.11,
        message: `Selected backend ${selectedBackend}`
      } as WorkerResponse);

      if (selectedBackend === 'cpu-tiled' && shape) {
        try {
          const tiledStart = performance.now();
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `Backend ${selectedBackend}: ${tileWorkerCount()} workers, ${TILE_SIZE}^3 tiles, sparse skip ${ENABLE_SPARSE_TILE_SKIPPING ? 'on' : 'off'}`
          } as WorkerResponse);
          const { result: rawTiledResult, stats: tileStats } = await runTiledGeneration(
            params,
            generationSeed,
            shape,
            sphereRadius ?? msg.sphereRadius ?? 25,
            bounds,
            resolution,
            (completed, total, timingMs, stats) => {
              progressReporter.report(
                0.12 + (completed / Math.max(1, total)) * 0.76,
                `cpu-tiled: ${completed}/${total} tiles processed, ${stats.tilesSkipped}/${stats.tilesTotal} skipped (${Math.round(timingMs)}ms worker time)`,
              );
            },
            () => cancelled,
          );
          if (cancelled) throw new Error('Cancelled');
          // Tiles are extracted open along their seams and merged here, so the
          // whole-surface repair belongs after the merge rather than per tile.
          const result = closeBoundaryLoops(rawTiledResult).result;
          postMessage({
            type: 'progress',
            progress: 0.95,
            message: `Geometry ready via ${selectedBackend} in ${Math.round(performance.now() - tiledStart)}ms (${tileStats.tilesSkipped}/${tileStats.tilesTotal} tiles skipped)`
          } as WorkerResponse);
          const response: WorkerResponse = {
            type: 'result',
            positions: result.positions,
            normals: result.normals,
            triCount: result.triCount,
            backend: selectedBackend,
          };
          postWorkerMessage(response, generatedResultTransferList(response));
          return;
        } catch (err: unknown) {
          terminateTileWorkers();
          if (cancelled) throw new Error('Cancelled');
          const message = err instanceof Error ? err.message : 'unknown error';
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `cpu-tiled unavailable (${message}); falling back to cpu-single`
          } as WorkerResponse);
        }
      }

      const initialEstimate = estimateGenerationTimings(params, resolution, !shape);
      let smoothedMarchSeconds = initialEstimate.marchSeconds;
      let estimateLabel = formatDuration(initialEstimate.preSeconds + initialEstimate.marchSeconds);
      postMessage({
        type: 'progress',
        progress: 0.12,
        message: `Estimated generation time: ~${estimateLabel}`
      } as WorkerResponse);

      // Run marching cubes
      const marchingStart = performance.now();
      const preSecondsActual = (marchingStart - generationStart) / 1000;
      const sdfToSample = surfaceHexSdf ?? sdf;
      const cells: Vec3 = [resolution, resolution, resolution];
      const spacing: Vec3 = [
        (bounds.max[0] - bounds.min[0]) / resolution,
        (bounds.max[1] - bounds.min[1]) / resolution,
        (bounds.max[2] - bounds.min[2]) / resolution,
      ];
      let lastSamplingPercent = -5;
      const field = sampleSdfField(sdfToSample, bounds, cells, (fraction) => {
        if (cancelled) throw new Error('Cancelled');
        const percent = Math.floor(fraction * 100);
        if (percent < 100 && percent < lastSamplingPercent + 5) return;
        lastSamplingPercent = percent;
        progressReporter.report(0.12 + fraction * 0.3, `Sampling field: ${percent}%`);
      });

      if (thinFilterActive) {
        const radius = params.thinSectionFilter / 2;
        if (openingIsResolvable(radius, spacing)) {
          postMessage({
            type: 'progress',
            progress: 0.44,
            message: `Removing features under ${params.thinSectionFilter}mm`,
          } as WorkerResponse);
          openField(
            field,
            [resolution + 1, resolution + 1, resolution + 1],
            spacing,
            radius,
          );
        } else {
          const largestSpacing = Math.max(...spacing);
          const needed = Math.ceil(
            (2 * largestSpacing / params.thinSectionFilter) * resolution,
          );
          thinFilterSkipped = `Cannot remove features under ${params.thinSectionFilter}mm at this grid: samples are ${largestSpacing.toFixed(2)}mm apart. Raise export resolution to about ${needed} or increase the threshold.`;
          postMessage({
            type: 'progress',
            progress: 0.44,
            message: thinFilterSkipped,
          } as WorkerResponse);
        }
      }

      if (!isDemoGrid) {
        cutEscapeHolesInField(field, bounds, cells, params);
      }
      sealFieldBoundary(field, cells, 0);

      let lastMarchingPercent = -5;
      const rawResult = marchingCubesFromField(field, bounds, cells, 0, (frac) => {
        if (cancelled) throw new Error('Cancelled');
        const percent = Math.floor(frac * 100);
        if (percent < 100 && percent < lastMarchingPercent + 5) return;
        lastMarchingPercent = percent;
        const overallProgress = 0.45 + frac * 0.39;
        const elapsedSeconds = (performance.now() - generationStart) / 1000;
        const marchElapsedSeconds = Math.max(0, elapsedSeconds - preSecondsActual);
        if (frac > 0.02) {
          const dynamicMarchTotal = marchElapsedSeconds / frac;
          smoothedMarchSeconds = smoothedMarchSeconds * 0.7 + dynamicMarchTotal * 0.3;
        }
        const remainingSeconds = Math.max(
          0,
          preSecondsActual + smoothedMarchSeconds - elapsedSeconds
        );
        estimateLabel = formatDuration(remainingSeconds);
        progressReporter.report(
          overallProgress,
          `Marching cubes: ${percent}% (~${estimateLabel} remaining)`,
        );
      });

      const result = closeBoundaryLoops(rawResult).result;

      postMessage({ type: 'progress', progress: 0.95, message: 'Geometry ready' } as WorkerResponse);

      // Send generated geometry immediately. positions/normals and optional
      // surface sample buffers are transferred; validation runs separately.
      const packedSamples = packSurfaceSamples(surfaceSamples);
      const response: WorkerResponse = {
        type: 'result',
        positions: result.positions,
        normals: result.normals,
        triCount: result.triCount,
        surfaceSamplePositions: packedSamples?.positions,
        surfaceSampleNormals: packedSamples?.normals,
        surfaceSampleHoleScales: packedSamples?.holeScales,
        thinFilterSkipped: thinFilterSkipped ?? undefined,
        backend: 'cpu-single',
      };
      postWorkerMessage(response, generatedResultTransferList(response));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message === 'Cancelled') {
        postMessage({ type: 'progress', progress: 0, message: 'Cancelled' } as WorkerResponse);
      } else {
        postMessage({ type: 'error', message } as WorkerResponse);
      }
    }
  }
};
