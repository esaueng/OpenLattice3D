import { describe, expect, it } from 'vitest';
import {
  buildCapsuleLattice,
  buildCubeLattice,
  buildCylinderLattice,
  buildSphereLattice,
  buildTorusLattice,
} from '../geometry/lattice';
import { marchingCubesRectangular, type MarchingCubesResult } from '../geometry/marching-cubes';
import { DEFAULT_PARAMS } from '../types/project';
import type { LatticeTileJob, LatticeTileResponse } from './tile-types';
import { runTiledGeneration, type TileWorkerLike } from './tiled-generation';

function hash(result: MarchingCubesResult): string {
  let value = 2166136261;
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  }
  return `${result.triCount}:${value.toString(16)}`;
}

function sdfFor(job: LatticeTileJob) {
  switch (job.shape) {
    case 'sphere': return buildSphereLattice(job.sphereRadius, job.params, job.generationSeed);
    case 'cube': return buildCubeLattice(15, job.params, job.generationSeed);
    case 'cylinder': return buildCylinderLattice(15, 20, job.params, job.generationSeed);
    case 'torus': return buildTorusLattice(20, 8, job.params, job.generationSeed);
    case 'capsule': return buildCapsuleLattice(12, 15, job.params, job.generationSeed);
  }
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
    }, (7 - job.tileId) % 4);
  }

  terminate(): void { this.terminated = true; }
}

class RejectingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminateCount = 0;

  postMessage(): void { throw new Error('worker channel closed'); }
  terminate(): void { this.terminateCount++; }
}

describe('tiled generation scheduling determinism', () => {
  it('keeps geometry byte-identical across supported worker counts and out-of-order tiles', async () => {
    const params = {
      ...DEFAULT_PARAMS,
      latticeType: 'gyroid' as const,
      noShell: true,
      shellThickness: 0,
      exportResolution: 1,
    };
    const hashes: string[] = [];
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
    }
    expect(new Set(hashes).size).toBe(1);
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
