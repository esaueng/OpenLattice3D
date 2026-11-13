import {
  assertGenerationGrid,
  assertGenerationOutputBudget,
  MAX_TILE_WORKERS,
  TILE_SIZE,
} from '../geometry/generation-limits';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { MeshBVH } from '../geometry/bvh';
import {
  canShareMemory,
  clonePackedMeshBVH,
  packSerializedMeshBVH,
  type PackedMeshBVH,
} from '../geometry/bvh-serialization';
import { sampleShapeObjectSdf } from '../geometry/sample-shapes';
import type { Vec3 } from '../geometry/vec3';
import type { LatticeParams, SampleShape } from '../types/project';
import { mergeMeshTilesInGridOrder, planMeshTiles } from './mesh-tiles';
import type {
  LatticeTileJob,
  LatticeTileResponse,
  LatticeTileResult,
  MeshTileInit,
  MeshTileJob,
  TileSkipStats,
  TileWorkerMessage,
} from './tile-types';
import { DiagnosedError, parseFailureCause, workerFailure } from '../utils/failure-cause';

export { TILE_SIZE };
export const ENABLE_SPARSE_TILE_SKIPPING = true;

export interface TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: TileWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

export interface TiledGenerationOptions {
  workerCount?: number;
  createWorker?: () => TileWorkerLike;
}

export interface MeshTiledGenerationOptions extends TiledGenerationOptions {
  /** Force shared or transferred BVH buffers; defaults to shared when isolated. */
  shareMemory?: boolean;
  /** Override sparse skipping (defaults to ENABLE_SPARSE_TILE_SKIPPING). */
  sparseSkipping?: boolean;
}

let activeTileWorkers: TileWorkerLike[] = [];

export function terminateTileWorkers(): void {
  for (const worker of activeTileWorkers) worker.terminate();
  activeTileWorkers = [];
}

export function tileWorkerCount(): number {
  return Math.max(1, Math.min(MAX_TILE_WORKERS, (globalThis.navigator?.hardwareConcurrency || 4) - 1));
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
  const gridCells: Vec3 = [resolution, resolution, resolution];
  assertGenerationGrid(gridCells, 'cpu-tiled');
  const dx = (bounds.max[0] - bounds.min[0]) / resolution;
  const dy = (bounds.max[1] - bounds.min[1]) / resolution;
  const dz = (bounds.max[2] - bounds.min[2]) / resolution;
  let tileId = 0;
  let tilesTotal = 0;
  let tilesSkipped = 0;
  const objectSdf = sampleShapeObjectSdf(shape, sphereRadius);

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
          gridBounds: bounds,
          gridCells,
          origin: [x, y, z],
        });
      }
    }
  }
  return {
    jobs,
    stats: { tilesTotal, tilesSkipped, tilesProcessed: jobs.length },
  };
}

/**
 * Concatenate procedural tiles in tile-id order. Each tile is extracted over
 * its own bounds and the tiles of one z slab follow each other whole, so the
 * merged triangles are not in whole-grid emission order (and their vertex
 * positions come from tile, not grid, coordinates). Grid vertex ids require
 * that order, so procedural tiles request none and cleanup keeps the
 * position-hash weld. Interleaving rows like mergeMeshTilesInGridOrder would
 * reorder triangles and change the output.
 */
function mergeTileResults(results: LatticeTileResult[]): MarchingCubesResult {
  const sorted = [...results].sort((a, b) => a.tileId - b.tileId);
  const triangleCount = sorted.reduce((sum, result) => sum + result.triCount, 0);
  const positionLength = sorted.reduce((sum, result) => sum + result.positions.length, 0);
  const normalLength = sorted.reduce((sum, result) => sum + result.normals.length, 0);
  assertGenerationOutputBudget(triangleCount, positionLength, normalLength);
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
  return runTilePool(jobs, stats, onProgress, isCancelled, options, null)
    .then((results) => ({ result: mergeTileResults(results), stats }));
}

export interface MeshTiledGenerationInput {
  bvh: MeshBVH;
  /** Requested parameters (escape holes are cut into the field from these). */
  params: LatticeParams;
  /** Parameters the field is built from, as on the single-worker path. */
  fieldParams: LatticeParams;
  generationSeed: number;
  keepOutTris: readonly number[];
  keepInTris: readonly number[];
  bounds: { min: Vec3; max: Vec3 };
  resolution: number;
}

export interface MeshTiledGenerationStats extends TileSkipStats {
  /** Whether tiles could be skipped (closed, consistently oriented mesh). */
  sparseSkipping: boolean;
  bvhTransfer: 'shared' | 'transfer';
}

/**
 * Imported-mesh generation over the tile pool. Output (before cleanup) is
 * byte-identical to the single-worker extraction for any worker count; see
 * mesh-tiles.ts.
 */
export function runMeshTiledGeneration(
  input: MeshTiledGenerationInput,
  onProgress: (completed: number, total: number, timingMs: number, stats: TileSkipStats) => void,
  isCancelled: () => boolean,
  options: MeshTiledGenerationOptions = {},
): Promise<{ result: MarchingCubesResult; stats: MeshTiledGenerationStats }> {
  const serialized = input.bvh.serialize();
  const plan = planMeshTiles({
    bvh: input.bvh,
    serialized,
    params: input.params,
    bounds: input.bounds,
    resolution: input.resolution,
    tileSize: TILE_SIZE,
    hasKeepOut: input.keepOutTris.length > 0,
    hasKeepIn: input.keepInTris.length > 0,
    enableSparseSkipping: options.sparseSkipping ?? ENABLE_SPARSE_TILE_SKIPPING,
  });
  const shared = options.shareMemory ?? canShareMemory();
  const stats: MeshTiledGenerationStats = {
    ...plan.stats,
    sparseSkipping: plan.sparseSkipping,
    bvhTransfer: shared ? 'shared' : 'transfer',
  };
  if (plan.jobs.length === 0) {
    return Promise.resolve({
      result: { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 },
      stats,
    });
  }
  // Shared memory: one packed copy posted to every worker. Otherwise each
  // worker gets its own copy, transferred so the host never holds two.
  const packed = packSerializedMeshBVH(serialized, shared);
  const workerCount = Math.min(Math.max(1, options.workerCount ?? tileWorkerCount()), plan.jobs.length);
  let workersInitialized = 0;
  const initFor = (): { message: MeshTileInit; transfer: Transferable[] } => {
    workersInitialized++;
    let bvh: PackedMeshBVH = packed;
    if (!shared && workersInitialized < workerCount) bvh = clonePackedMeshBVH(packed);
    const message: MeshTileInit = {
      type: 'mesh-init',
      bvh,
      fieldParams: input.fieldParams,
      params: input.params,
      generationSeed: input.generationSeed,
      keepOutTris: [...input.keepOutTris],
      keepInTris: [...input.keepInTris],
      gridBounds: input.bounds,
      gridCells: [input.resolution, input.resolution, input.resolution],
    };
    return { message, transfer: shared ? [] : [bvh.buffer as ArrayBuffer] };
  };
  return runTilePool(plan.jobs, plan.stats, onProgress, isCancelled, { ...options, workerCount }, initFor)
    .then((results) => ({ result: mergeMeshTilesInGridOrder(plan, results, input.resolution), stats }));
}

function runTilePool(
  jobs: readonly (LatticeTileJob | MeshTileJob)[],
  stats: TileSkipStats,
  onProgress: (completed: number, total: number, timingMs: number, stats: TileSkipStats) => void,
  isCancelled: () => boolean,
  options: TiledGenerationOptions,
  initMessage: (() => { message: MeshTileInit; transfer: Transferable[] }) | null,
): Promise<LatticeTileResult[]> {
  if (jobs.length === 0) return Promise.resolve([]);
  const workerCount = Math.min(
    Math.max(1, options.workerCount ?? tileWorkerCount()),
    jobs.length,
  );
  const results: LatticeTileResult[] = [];
  let nextJob = 0;
  let completed = 0;
  let timingMs = 0;
  let retainedTriangles = 0;
  let retainedPositions = 0;
  let retainedNormals = 0;
  let retainedBytes = 0;

  return new Promise<LatticeTileResult[]>((resolve, reject) => {
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
      resolve(results);
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
          fail(workerFailure(`Could not start tile worker job${detail}`));
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
          fail(workerFailure('Tile worker returned a malformed response'));
          return;
        }
        if (response.type === 'error') {
          const cause = parseFailureCause(response.diagnostic);
          fail(cause ? new DiagnosedError(response.message, cause) : new Error(response.message));
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
          || (response.vertexIds !== undefined && (
            !(response.vertexIds instanceof Uint32Array)
            || response.vertexIds.length * 3 !== response.positions.length
          ))
        ) {
          fail(workerFailure('Tile worker returned a malformed response'));
          return;
        }
        // Grid vertex ids (at most a third of the position bytes, validated
        // above) are left out so the triangle budget keeps its thresholds.
        const responseBytes = response.positions.buffer.byteLength
          + (response.normals.buffer === response.positions.buffer ? 0 : response.normals.buffer.byteLength);
        try {
          assertGenerationOutputBudget(
            retainedTriangles + response.triCount,
            retainedPositions + response.positions.length,
            retainedNormals + response.normals.length,
            retainedBytes + responseBytes,
          );
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Generation memory limit exceeded'));
          return;
        }
        retainedBytes += responseBytes;
        retainedTriangles += response.triCount;
        retainedPositions += response.positions.length;
        retainedNormals += response.normals.length;
        results[response.tileId] = response;
        inFlightTileId = null;
        completed++;
        timingMs += response.timing.totalMs;
        onProgress(completed, jobs.length, timingMs, stats);
        if (completed === jobs.length) finish();
        else postNext();
      };
      worker.onerror = () => fail(workerFailure('Tile worker failed'));
      worker.onmessageerror = () => fail(workerFailure('Tile worker returned an unreadable response'));
      if (initMessage) {
        try {
          const { message, transfer } = initMessage();
          worker.postMessage(message, transfer);
        } catch (error) {
          const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
          fail(workerFailure(`Could not initialize tile worker${detail}`));
          return;
        }
      }
      postNext();
    };
    try {
      for (let i = 0; i < workerCount; i++) startWorker();
    } catch (error) {
      terminateTileWorkers();
      fail(workerFailure(error instanceof Error ? error.message : 'Tile worker creation failed'));
    }
  }).finally(() => terminateTileWorkers());
}
