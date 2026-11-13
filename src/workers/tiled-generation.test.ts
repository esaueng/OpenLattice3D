import { describe, expect, it } from 'vitest';
import { buildSampleShapeLattice } from '../geometry/lattice';
import { marchingCubesRectangular, type MarchingCubesResult } from '../geometry/marching-cubes';
import { DEFAULT_PARAMS } from '../types/project';
import { closeBoundaryLoops, closeExtractedBoundaryLoops, type RepairWorkCounters } from '../geometry/mesh-repair';
import { analyzeTopology } from '../geometry/__tests__/helpers';
import type { LatticeTileJob, LatticeTileResponse } from './tile-types';
import { runTiledGeneration, type TileWorkerLike } from './tiled-generation';
import { failureCause } from '../utils/failure-cause';

function hash(result: MarchingCubesResult): string {
  let value = 2166136261;
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  }
  return `${result.triCount}:${value.toString(16)}`;
}

function sdfFor(job: LatticeTileJob) {
  return buildSampleShapeLattice(job.shape, job.sphereRadius, job.params, job.generationSeed);
}

class ComputingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private terminated = false;

  postMessage(job: LatticeTileJob): void {
    const result = marchingCubesRectangular(sdfFor(job), job.bounds, job.cells, 0);
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: job.tileId,
      positions: result.positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: { totalMs: job.tileId + 1, triCount: result.triCount },
    };
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: response });
    }, (7 - job.tileId % 8) % 4);
  }

  terminate(): void { this.terminated = true; }
}

/** Answers every tile with an empty mesh plus the given `vertexIds` field. */
class BadIdsTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly vertexIds: unknown;
  constructor(vertexIds: unknown) { this.vertexIds = vertexIds; }
  postMessage(job: LatticeTileJob): void {
    setTimeout(() => this.onmessage?.({ data: {
      type: 'result', tileId: job.tileId,
      positions: new Float32Array(9), normals: new Float32Array(3), triCount: 1,
      vertexIds: this.vertexIds,
      timing: { totalMs: 1, triCount: 1 },
    } }), 0);
  }
  terminate(): void {}
}

class RejectingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminateCount = 0;

  postMessage(): void { throw new Error('worker channel closed'); }
  terminate(): void { this.terminateCount++; }
}

class FailingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly mode: 'crash' | 'unreadable' | 'oom' | 'error';
  constructor(mode: 'crash' | 'unreadable' | 'oom' | 'error') { this.mode = mode; }
  postMessage(job: LatticeTileJob): void {
    setTimeout(() => {
      if (this.mode === 'crash') this.onerror?.({});
      else if (this.mode === 'unreadable') this.onmessageerror?.({});
      else this.onmessage?.({ data: { type: 'error', tileId: job.tileId, message: 'private', diagnostic: this.mode === 'oom' ? 'out_of_memory' : undefined } });
    }, 0);
  }
  terminate(): void {}
}

describe('tile failure causes', () => {
  it.each([
    ['crash', 'worker'], ['unreadable', 'worker'], ['oom', 'out_of_memory'], ['error', undefined],
  ] as const)('classifies a %s tile failure as %s', async (mode, expected) => {
    const error = await runTiledGeneration(
      DEFAULT_PARAMS, 1, 'sphere', 25,
      { min: [-29, -29, -29], max: [29, 29, 29] }, 36,
      () => undefined, () => false,
      { workerCount: 1, createWorker: () => new FailingTileWorker(mode) },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(failureCause(error)).toBe(expected);
  });
});

describe('tile response validation', () => {
  it.each([
    ['too few ids', new Uint32Array(2)],
    ['too many ids', new Uint32Array(4)],
    ['ids of the wrong type', new Int32Array(3)],
    ['ids that are not an array', [0, 1, 2]],
  ] as const)('rejects %s as a worker failure', async (_label, vertexIds) => {
    const error = await runTiledGeneration(
      DEFAULT_PARAMS, 1, 'sphere', 25,
      { min: [-29, -29, -29], max: [29, 29, 29] }, 36,
      () => undefined, () => false,
      { workerCount: 1, createWorker: () => new BadIdsTileWorker(vertexIds) },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/malformed response/);
    expect(failureCause(error)).toBe('worker');
  });

  it('accepts ids with one entry per vertex reference', async () => {
    const { result } = await runTiledGeneration(
      DEFAULT_PARAMS, 1, 'sphere', 25,
      { min: [-29, -29, -29], max: [29, 29, 29] }, 36,
      () => undefined, () => false,
      { workerCount: 1, createWorker: () => new BadIdsTileWorker(new Uint32Array(3)) },
    );
    // Procedural merges never forward ids, even when a tile sends them.
    expect(result.vertexIds).toBeUndefined();
  });
});

describe('tiled generation scheduling determinism', () => {
  it.each([
    ['gyroid', 96], ['gyroid', 192], ['bcc', 192],
  ] as const)('keeps a shell-bearing %s torus closed at resolution %i', async (latticeType, resolution) => {
    const params = { ...DEFAULT_PARAMS, latticeType };
    const { result } = await runTiledGeneration(
      params, 0, 'torus', 25,
      { min: [-32, -32, -12], max: [32, 32, 12] }, resolution,
      () => undefined, () => false,
      { workerCount: 1, createWorker: () => new ComputingTileWorker() },
    );
    const repaired = closeBoundaryLoops(result);
    const topology = analyzeTopology(repaired.result);
    expect(repaired.result.triCount).toBeGreaterThan(100_000);
    expect(topology.boundaryEdges).toBe(0);
    expect(topology.nonManifoldEdges).toBe(0);
  });
  it('keeps geometry byte-identical across supported worker counts and out-of-order tiles', async () => {
    const params = {
      ...DEFAULT_PARAMS,
      latticeType: 'gyroid' as const,
      noShell: true,
      shellThickness: 0,
      exportResolution: 1,
    };
    const hashes: string[] = [];
    const cleanedHashes: string[] = [];
    const tileCounts: number[] = [];
    for (const workerCount of [1, 2, 4, 8]) {
      const { result, stats } = await runTiledGeneration(
        params,
        0xabcdef01,
        'sphere',
        25,
        { min: [-29, -29, -29], max: [29, 29, 29] },
        36,
        () => undefined,
        () => false,
        { workerCount, createWorker: () => new ComputingTileWorker() },
      );
      hashes.push(hash(result));
      tileCounts.push(stats.tilesProcessed);
      // Procedural tiles stay on the hash weld (merged by tile id, no ids).
      expect(result.vertexIds).toBeUndefined();
      const counters: RepairWorkCounters = { corners: 0, weldProbes: 0, edgeVisits: 0, loopSteps: 0 };
      const cleaned = closeExtractedBoundaryLoops(result, counters).result;
      expect(counters.gridIdCorners).toBeUndefined();
      expect(hash(cleaned)).toBe(hash(closeBoundaryLoops(result).result));
      cleanedHashes.push(hash(cleaned));
    }
    expect(new Set(hashes).size).toBe(1);
    expect(new Set(cleanedHashes).size).toBe(1);
    expect(new Set(tileCounts).size).toBe(1);
    expect(tileCounts[0]).toBeGreaterThan(1);
  });

  it('terminates the pool when a tile job cannot be posted', async () => {
    const worker = new RejectingTileWorker();
    await expect(runTiledGeneration(
      DEFAULT_PARAMS,
      1,
      'sphere',
      25,
      { min: [-29, -29, -29], max: [29, 29, 29] },
      36,
      () => undefined,
      () => false,
      { workerCount: 1, createWorker: () => worker },
    )).rejects.toThrow(/worker channel closed/);
    expect(worker.terminateCount).toBeGreaterThanOrEqual(1);
  });
});
