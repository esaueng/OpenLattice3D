import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { Vec3 } from '../geometry/vec3';
import type { LatticeParams, SampleShape } from '../types/project';
import type {
  LatticeTileJob,
  LatticeTileResponse,
  LatticeTileResult,
  TileSkipStats,
} from './tile-types';

export const TILE_SIZE = 32;
export const ENABLE_SPARSE_TILE_SKIPPING = true;
const MAX_TILE_WORKERS = 8;

export interface TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: LatticeTileJob): void;
  terminate(): void;
}

export interface TiledGenerationOptions {
  workerCount?: number;
  createWorker?: () => TileWorkerLike;
}

let activeTileWorkers: TileWorkerLike[] = [];

export function terminateTileWorkers(): void {
  for (const worker of activeTileWorkers) worker.terminate();
  activeTileWorkers = [];
}

export function tileWorkerCount(): number {
  return Math.max(1, Math.min(MAX_TILE_WORKERS, (globalThis.navigator?.hardwareConcurrency || 4) - 1));
}

function objectSdfForShape(shape: SampleShape, sphereRadius: number): (x: number, y: number, z: number) => number {
  switch (shape) {
    case 'sphere': {
      const radius = sphereRadius || 25;
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - radius;
    }
    case 'cube': {
      const halfSize = 15;
      return (x, y, z) => {
        const dx = Math.abs(x) - halfSize;
        const dy = Math.abs(y) - halfSize;
        const dz = Math.abs(z) - halfSize;
        const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0));
        return outside + Math.min(Math.max(dx, dy, dz), 0);
      };
    }
    case 'cylinder': {
      return (x, y, z) => {
        const radial = Math.hypot(x, y) - 15;
        const axial = Math.abs(z) - 20;
        return Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0);
      };
    }
    case 'torus':
      return (x, y, z) => Math.hypot(Math.hypot(x, y) - 20, z) - 8;
    case 'capsule':
      return (x, y, z) => {
        const centerZ = Math.max(-15, Math.min(15, z));
        return Math.hypot(x, y, z - centerZ) - 12;
      };
  }
}

function sparseSkipMargin(params: LatticeParams, tileBounds: { min: Vec3; max: Vec3 }): number {
  const sx = tileBounds.max[0] - tileBounds.min[0];
  const sy = tileBounds.max[1] - tileBounds.min[1];
  const sz = tileBounds.max[2] - tileBounds.min[2];
  const tileRadius = 0.5 * Math.hypot(sx, sy, sz);
  const featureMargin = Math.max(
    params.cellSize * 0.25,
    params.wallThickness,
    params.strutDiameter,
    params.shellThickness,
    params.surfaceDepth,
    params.thinSectionFilter,
    0,
  );
  return tileRadius + featureMargin;
}

function classifySparseTile(
  params: LatticeParams,
  objectSdf: (x: number, y: number, z: number) => number,
  tileBounds: { min: Vec3; max: Vec3 },
): 'process' | 'skip' {
  if (!ENABLE_SPARSE_TILE_SKIPPING) return 'process';
  const { min, max } = tileBounds;
  const center: Vec3 = [
    (min[0] + max[0]) * 0.5,
    (min[1] + max[1]) * 0.5,
    (min[2] + max[2]) * 0.5,
  ];
  const margin = sparseSkipMargin(params, tileBounds);
  let minimum = Infinity;
  let maximum = -Infinity;
  const record = (distance: number) => {
    minimum = Math.min(minimum, distance);
    maximum = Math.max(maximum, distance);
  };
  for (const x of [min[0], max[0]]) {
    for (const y of [min[1], max[1]]) {
      for (const z of [min[2], max[2]]) record(objectSdf(x, y, z));
    }
  }
  record(objectSdf(center[0], center[1], center[2]));
  if (minimum > margin) return 'skip';
  if (params.surfaceOnly && maximum < -params.surfaceDepth - margin) return 'skip';
  return 'process';
}

function buildTileJobs(
  params: LatticeParams,
  generationSeed: number,
  shape: SampleShape,
  sphereRadius: number,
  bounds: { min: Vec3; max: Vec3 },
  resolution: number,
): { jobs: LatticeTileJob[]; stats: TileSkipStats } {
  const jobs: LatticeTileJob[] = [];
  const dx = (bounds.max[0] - bounds.min[0]) / resolution;
  const dy = (bounds.max[1] - bounds.min[1]) / resolution;
  const dz = (bounds.max[2] - bounds.min[2]) / resolution;
  let tileId = 0;
  let tilesTotal = 0;
  let tilesSkipped = 0;
  const objectSdf = objectSdfForShape(shape, sphereRadius);

  for (let z = 0; z < resolution; z += TILE_SIZE) {
    const cellsZ = Math.min(TILE_SIZE, resolution - z);
    for (let y = 0; y < resolution; y += TILE_SIZE) {
      const cellsY = Math.min(TILE_SIZE, resolution - y);
      for (let x = 0; x < resolution; x += TILE_SIZE) {
        const cellsX = Math.min(TILE_SIZE, resolution - x);
        tilesTotal++;
        const tileBounds = {
          min: [bounds.min[0] + x * dx, bounds.min[1] + y * dy, bounds.min[2] + z * dz] as Vec3,
          max: [
            bounds.min[0] + (x + cellsX) * dx,
            bounds.min[1] + (y + cellsY) * dy,
            bounds.min[2] + (z + cellsZ) * dz,
          ] as Vec3,
        };
        if (classifySparseTile(params, objectSdf, tileBounds) === 'skip') {
          tilesSkipped++;
          continue;
        }
        jobs.push({
          type: 'tile',
          tileId: tileId++,
          params,
          generationSeed,
          shape,
          sphereRadius,
          cells: [cellsX, cellsY, cellsZ],
          bounds: tileBounds,
        });
      }
    }
  }
  return {
    jobs,
    stats: { tilesTotal, tilesSkipped, tilesProcessed: jobs.length },
  };
}

function mergeTileResults(results: LatticeTileResult[]): MarchingCubesResult {
  const sorted = [...results].sort((a, b) => a.tileId - b.tileId);
  const triangleCount = sorted.reduce((sum, result) => sum + result.triCount, 0);
  const positionLength = sorted.reduce((sum, result) => sum + result.positions.length, 0);
  const normalLength = sorted.reduce((sum, result) => sum + result.normals.length, 0);
  const positions = new Float32Array(positionLength);
  const normals = new Float32Array(normalLength);
  let positionOffset = 0;
  let normalOffset = 0;
  for (const result of sorted) {
    positions.set(result.positions, positionOffset);
    normals.set(result.normals, normalOffset);
    positionOffset += result.positions.length;
    normalOffset += result.normals.length;
  }
  return { positions, normals, triCount: triangleCount };
}

export function runTiledGeneration(
  params: LatticeParams,
  generationSeed: number,
  shape: SampleShape,
  sphereRadius: number,
  bounds: { min: Vec3; max: Vec3 },
  resolution: number,
  onProgress: (completed: number, total: number, timingMs: number, stats: TileSkipStats) => void,
  isCancelled: () => boolean,
  options: TiledGenerationOptions = {},
): Promise<{ result: MarchingCubesResult; stats: TileSkipStats }> {
  const { jobs, stats } = buildTileJobs(params, generationSeed, shape, sphereRadius, bounds, resolution);
  if (jobs.length === 0) {
    return Promise.resolve({
      result: { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 },
      stats,
    });
  }
  const workerCount = Math.min(
    Math.max(1, options.workerCount ?? tileWorkerCount()),
    jobs.length,
  );
  const results: LatticeTileResult[] = [];
  let nextJob = 0;
  let completed = 0;
  let timingMs = 0;

  return new Promise<{ result: MarchingCubesResult; stats: TileSkipStats }>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      terminateTileWorkers();
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      terminateTileWorkers();
      resolve({ result: mergeTileResults(results), stats });
    };
    const startWorker = () => {
      const worker = options.createWorker?.()
        ?? new Worker(new URL('./lattice-tile-worker.ts', import.meta.url), { type: 'module' }) as unknown as TileWorkerLike;
      activeTileWorkers.push(worker);
      let inFlightTileId: number | null = null;
      const postNext = () => {
        if (settled) return;
        if (isCancelled()) {
          fail(new Error('Cancelled'));
          return;
        }
        const job = jobs[nextJob++];
        if (!job) {
          if (completed === jobs.length) finish();
          return;
        }
        inFlightTileId = job.tileId;
        try {
          worker.postMessage(job);
        } catch (error) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
          fail(new Error(`Could not start tile worker job${detail}`));
        }
      };
      worker.onmessage = (event) => {
        if (settled) return;
        const response = event.data as LatticeTileResponse;
        if (
          typeof response !== 'object'
          || response === null
          || (response.type !== 'result' && response.type !== 'error')
          || response.tileId !== inFlightTileId
        ) {
          fail(new Error('Tile worker returned a malformed response'));
          return;
        }
        if (response.type === 'error') {
          fail(new Error(response.message));
          return;
        }
        if (
          !(response.positions instanceof Float32Array)
          || !(response.normals instanceof Float32Array)
          || !Number.isInteger(response.triCount)
          || response.triCount < 0
          || response.positions.length < response.triCount * 9
          || response.normals.length < response.triCount * 3
          || !Number.isFinite(response.timing?.totalMs)
        ) {
          fail(new Error('Tile worker returned a malformed response'));
          return;
        }
        results[response.tileId] = response;
        inFlightTileId = null;
        completed++;
        timingMs += response.timing.totalMs;
        onProgress(completed, jobs.length, timingMs, stats);
        if (completed === jobs.length) finish();
        else postNext();
      };
      worker.onerror = () => fail(new Error('Tile worker failed'));
      worker.onmessageerror = () => fail(new Error('Tile worker returned an unreadable response'));
      postNext();
    };
    try {
      for (let i = 0; i < workerCount; i++) startWorker();
    } catch (error) {
      terminateTileWorkers();
      fail(error instanceof Error ? error : new Error('Tile worker creation failed'));
    }
  }).finally(() => terminateTileWorkers());
}
