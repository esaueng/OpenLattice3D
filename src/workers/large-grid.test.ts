import { describe, expect, it, vi } from 'vitest';
import { cutEscapeHolesInField } from '../geometry/escape-holes';
import {
  MAX_SINGLE_GENERATION_GRID,
  MAX_TILED_GENERATION_GRID,
} from '../geometry/generation-limits';
import { buildSampleShapeLattice } from '../geometry/lattice';
import {
  marchingCubesFromField,
  marchingCubesRectangular,
  sampleSdfField,
  sealFieldBoundary,
  type MarchingCubesResult,
} from '../geometry/marching-cubes';
import { MeshBVH } from '../geometry/bvh';
import { closeBoundaryLoops } from '../geometry/mesh-repair';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { sampleShapeBounds } from '../geometry/sample-shapes';
import { analyzeTopology, signedVolume } from '../geometry/__tests__/helpers';
import { DEFAULT_PARAMS, type LatticeParams } from '../types/project';
import { computeShapeTile } from './shape-tiles';
import type { LatticeTileJob, LatticeTileResponse } from './tile-types';
import { runMeshTiledGeneration, runTiledGeneration, type TileWorkerLike } from './tiled-generation';

function hash(result: MarchingCubesResult): string {
  let value = 2166136261;
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  }
  return `${result.triCount}:${value.toString(16)}`;
}

/** Mirrors lattice-tile-worker.ts for procedural tiles; out-of-order replies. */
class ShapeTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly jobs: LatticeTileJob[];
  constructor(jobs: LatticeTileJob[] = []) { this.jobs = jobs; }
  postMessage(job: LatticeTileJob): void {
    this.jobs.push(job);
    const result = computeShapeTile(job);
    const response: LatticeTileResponse = {
      type: 'result', tileId: job.tileId,
      positions: result.positions, normals: result.normals, triCount: result.triCount,
      timing: { totalMs: 1, triCount: result.triCount },
    };
    setTimeout(() => this.onmessage?.({ data: response }), (7 - job.tileId % 8) % 3);
  }
  terminate(): void {}
}

class RecordingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly jobs: LatticeTileJob[];
  constructor(jobs: LatticeTileJob[]) { this.jobs = jobs; }
  postMessage(job: LatticeTileJob): void {
    this.jobs.push(job);
    queueMicrotask(() => this.onmessage?.({ data: {
      type: 'result', tileId: job.tileId,
      positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0,
      timing: { totalMs: 1, triCount: 0 },
    } }));
  }
  terminate(): void {}
}

const noProgress = () => undefined;
const notCancelled = () => false;

describe('tiled generation above the single-field limit', () => {
  it('rejects a grid above the tiled limit before creating a worker', () => {
    const createWorker = vi.fn<() => TileWorkerLike>();
    const over = MAX_TILED_GENERATION_GRID + 1;
    expect(() => runTiledGeneration(
      DEFAULT_PARAMS, 0, 'sphere', 25, { min: [-29, -29, -29], max: [29, 29, 29] }, over,
      noProgress, notCancelled, { createWorker },
    )).toThrow(new RegExp(`${over}³ generation grid exceeds the ${MAX_TILED_GENERATION_GRID}³ memory limit for tiled generation.*triangle budget`));
    expect(createWorker).not.toHaveBeenCalled();

    const cube = generateCubeMesh(20);
    const bvh = new MeshBVH(cube.positions, cube.normals, cube.triCount);
    expect(() => runMeshTiledGeneration({
      bvh, params: DEFAULT_PARAMS, fieldParams: DEFAULT_PARAMS, generationSeed: 0,
      keepOutTris: [], keepInTris: [], bounds: { min: [-14, -14, -14], max: [14, 14, 14] }, resolution: over,
    }, noProgress, notCancelled, { createWorker })).toThrow(/memory limit for tiled generation/);
    expect(createWorker).not.toHaveBeenCalled();
  });

  it('schedules the largest tiled grid without allocating it', async () => {
    const jobs: LatticeTileJob[] = [];
    const resolution = MAX_TILED_GENERATION_GRID;
    // A small sphere in a large window: sparse skipping drops most tiles.
    const { stats } = await runTiledGeneration(
      DEFAULT_PARAMS, 0, 'sphere', 10, { min: [-170, -170, -170], max: [170, 170, 170] }, resolution,
      noProgress, notCancelled, { workerCount: 2, createWorker: () => new RecordingTileWorker(jobs) },
    );
    expect(stats.tilesTotal).toBe(Math.ceil(resolution / 32) ** 3);
    expect(stats.tilesProcessed).toBe(jobs.length);
    expect(jobs.length).toBeLessThan(stats.tilesTotal / 10);
    for (const job of jobs) {
      expect(job.gridCells).toEqual([resolution, resolution, resolution]);
      expect(Math.max(...job.cells)).toBeLessThanOrEqual(32);
    }
  });

  it('is byte-identical across worker counts above the old cap', async () => {
    const resolution = 300;
    expect(resolution).toBeGreaterThan(MAX_SINGLE_GENERATION_GRID);
    const params: LatticeParams = { ...DEFAULT_PARAMS, cellSize: 6 };
    const bounds = { min: [-150, -150, -150] as const, max: [150, 150, 150] as const };
    const hashes: string[] = [];
    let triangles = 0;
    for (const workerCount of [1, 3, 8]) {
      const { result, stats } = await runTiledGeneration(
        params, 0x5eed, 'sphere', 12,
        { min: [...bounds.min], max: [...bounds.max] }, resolution,
        noProgress, notCancelled, { workerCount, createWorker: () => new ShapeTileWorker() },
      );
      expect(stats.tilesSkipped).toBeGreaterThan(stats.tilesProcessed);
      hashes.push(hash(result));
      triangles = result.triCount;
      if (workerCount === 1) {
        const topology = analyzeTopology(closeBoundaryLoops(result).result);
        expect(topology.boundaryEdges).toBe(0);
        expect(topology.nonManifoldEdges).toBe(0);
      }
    }
    expect(triangles).toBeGreaterThan(10_000);
    expect(new Set(hashes).size).toBe(1);
  });
});

describe('procedural tile kernel', () => {
  it('leaves runs without escape holes byte-identical to the former kernel', async () => {
    const jobs: LatticeTileJob[] = [];
    const bounds = sampleShapeBounds('torus', 25, DEFAULT_PARAMS.cellSize * 0.5);
    await runTiledGeneration(
      DEFAULT_PARAMS, 7, 'torus', 25, bounds, 96,
      noProgress, notCancelled, { workerCount: 2, createWorker: () => new RecordingTileWorker(jobs) },
    );
    expect(jobs.length).toBeGreaterThan(8);
    for (const job of jobs) {
      const former = marchingCubesRectangular(
        buildSampleShapeLattice(job.shape, job.sphereRadius, job.params, job.generationSeed),
        job.bounds, job.cells, 0,
      );
      expect(hash(computeShapeTile(job))).toBe(hash(former));
    }
  });

  it('cuts escape holes from the grid bounds as the single-worker path does', async () => {
    const params: LatticeParams = {
      ...DEFAULT_PARAMS, escapeHoles: true, escapeHoleCount: 3, escapeHoleDiameter: 6,
    };
    const resolution = 80;
    const bounds = sampleShapeBounds('cube', 25, params.cellSize * 0.5);
    const cells: [number, number, number] = [resolution, resolution, resolution];
    // Single-worker sequence from lattice-worker.ts.
    const field = sampleSdfField(buildSampleShapeLattice('cube', 25, params, 3), bounds, cells);
    cutEscapeHolesInField(field, bounds, cells, params);
    sealFieldBoundary(field, cells, 0);
    const single = closeBoundaryLoops(marchingCubesFromField(field, bounds, cells, 0)).result;

    const { result } = await runTiledGeneration(
      params, 3, 'cube', 25, bounds, resolution,
      noProgress, notCancelled, { workerCount: 3, createWorker: () => new ShapeTileWorker() },
    );
    const tiled = closeBoundaryLoops(result).result;
    // Tile samples are computed from tile bounds, so float bits can differ
    // from the whole grid's; geometry agrees to rounding.
    expect(Math.abs(tiled.triCount - single.triCount)).toBeLessThanOrEqual(single.triCount * 1e-3);
    expect(Math.abs(signedVolume(tiled) - signedVolume(single))).toBeLessThan(signedVolume(single) * 1e-4);

    // Without the grid-bound cut (the former tile kernel) the holes differ.
    const formerJobs: LatticeTileJob[] = [];
    await runTiledGeneration(
      params, 3, 'cube', 25, bounds, resolution,
      noProgress, notCancelled, { workerCount: 1, createWorker: () => new RecordingTileWorker(formerJobs) },
    );
    let formerVolume = 0;
    for (const job of formerJobs) {
      formerVolume += signedVolume(marchingCubesRectangular(
        buildSampleShapeLattice(job.shape, job.sphereRadius, job.params, job.generationSeed),
        job.bounds, job.cells, 0,
      ));
    }
    expect(Math.abs(formerVolume - signedVolume(single))).toBeGreaterThan(signedVolume(single) * 1e-3);
  });
});
