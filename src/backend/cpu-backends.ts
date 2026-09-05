// CPU marching-cubes backends wired for parity and benchmark runs. These wrap
// the exact production code paths (lattice-worker for cpu-single,
// tiled-generation for cpu-tiled) with phase timing and synchronous tile
// execution so runs are reproducible in Node.
import {
  marchingCubesFromField,
  marchingCubesRectangular,
  sampleSdfField,
  sealFieldBoundary,
} from '../geometry/marching-cubes';
import { closeBoundaryLoops } from '../geometry/mesh-repair';
import type { Vec3 } from '../geometry/vec3';
import { runTiledGeneration, type TileWorkerLike } from '../workers/tiled-generation';
import type { LatticeTileJob, LatticeTileResponse } from '../workers/tile-types';
import { buildFixtureSdf, buildShapeSdf } from './fixtures';
import type {
  BackendFixture,
  BackendRunHooks,
  BackendRunResult,
  MarchingCubesBackend,
} from './types';

function now(): number {
  return performance.now();
}

function throwIfCancelled(hooks?: BackendRunHooks): void {
  if (hooks?.isCancelled?.()) throw new Error('Cancelled');
}

// Runs one tile inline and replies synchronously, so tiled runs need no real
// worker pool and stay deterministic in Node benchmarks and tests.
class InlineTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  postMessage(job: LatticeTileJob): void {
    const start = now();
    const sdf = buildShapeSdf(job.shape, job.sphereRadius, job.params, job.generationSeed);
    const result = marchingCubesRectangular(sdf, job.bounds, job.cells, 0);
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: job.tileId,
      positions: result.positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: { totalMs: now() - start, triCount: result.triCount },
    };
    this.onmessage?.({ data: response });
  }

  terminate(): void { /* nothing to release for inline execution */ }
}

export const cpuSingleBackend: MarchingCubesBackend = {
  id: 'cpu-single',
  run(fixture: BackendFixture, hooks?: BackendRunHooks): Promise<BackendRunResult> {
    const sdf = buildFixtureSdf(fixture);
    const cells: Vec3 = [fixture.resolution, fixture.resolution, fixture.resolution];

    const start = now();
    const field = sampleSdfField(sdf, fixture.bounds, cells);
    sealFieldBoundary(field, cells, 0);
    const fieldEnd = now();
    throwIfCancelled(hooks);

    const raw = marchingCubesFromField(field, fixture.bounds, cells, 0);
    const extractEnd = now();
    throwIfCancelled(hooks);

    const result = closeBoundaryLoops(raw).result;
    const cleanupEnd = now();

    return Promise.resolve({
      backend: 'cpu-single',
      result,
      timings: {
        fieldMs: fieldEnd - start,
        classifyScanEmitMs: extractEnd - fieldEnd,
        readbackMs: 0,
        mergeMs: null,
        cleanupMs: cleanupEnd - extractEnd,
        totalMs: cleanupEnd - start,
      },
    });
  },
};

export function createCpuTiledBackend(workerCount = 1): MarchingCubesBackend {
  return {
    id: 'cpu-tiled',
    async run(fixture: BackendFixture, hooks?: BackendRunHooks): Promise<BackendRunResult> {
      const isCancelled = () => hooks?.isCancelled?.() ?? false;
      const start = now();
      let tileComputeMs = 0;
      const { result: merged } = await runTiledGeneration(
        fixture.params,
        fixture.generationSeed,
        fixture.shape,
        fixture.sphereRadius,
        fixture.bounds,
        fixture.resolution,
        (_completed, _total, timingMs) => { tileComputeMs = timingMs; },
        isCancelled,
        { workerCount, createWorker: () => new InlineTileWorker() },
      );
      const tilesEnd = now();
      throwIfCancelled(hooks);

      // Tiles are extracted open along their seams; closing belongs after the
      // merge, exactly as lattice-worker does it.
      const result = closeBoundaryLoops(merged).result;
      const cleanupEnd = now();

      // Field sampling is fused into tile extraction on CPU, so the tile
      // worker total is reported as classifyScanEmitMs and the remaining wall
      // time covers scheduling plus the deterministic tile-id merge.
      return {
        backend: 'cpu-tiled',
        result,
        timings: {
          fieldMs: null,
          classifyScanEmitMs: tileComputeMs,
          readbackMs: 0,
          mergeMs: Math.max(0, tilesEnd - start - tileComputeMs),
          cleanupMs: cleanupEnd - tilesEnd,
          totalMs: cleanupEnd - start,
        },
      };
    },
  };
}

export interface BackendRunOutcome {
  run: BackendRunResult;
  fellBack: boolean;
  fallbackReason: string | null;
}

/**
 * Run the preferred backend and fall back explicitly on failure, mirroring
 * the production "cpu-tiled unavailable (reason); falling back to cpu-single"
 * path. Cancellation is an abort, not a fallback trigger: it always
 * propagates so a stale GPU result is never delivered after a cancel.
 */
export async function runBackendWithFallback(
  preferred: MarchingCubesBackend,
  fallback: MarchingCubesBackend,
  fixture: BackendFixture,
  hooks?: BackendRunHooks,
): Promise<BackendRunOutcome> {
  try {
    return { run: await preferred.run(fixture, hooks), fellBack: false, fallbackReason: null };
  } catch (error) {
    if (hooks?.isCancelled?.() || (error instanceof Error && error.message === 'Cancelled')) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    return { run: await fallback.run(fixture, hooks), fellBack: true, fallbackReason: reason };
  }
}
