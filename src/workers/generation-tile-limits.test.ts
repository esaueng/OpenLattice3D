import { expect, it, vi } from 'vitest';
import { closeBoundaryLoops } from '../geometry/mesh-repair';
import { DEFAULT_PARAMS } from '../types/project';
import type { LatticeTileJob } from './tile-types';
import { runTiledGeneration, type TileWorkerLike } from './tiled-generation';

// Exercise the real scheduler's aggregate accounting with small allocations.
vi.mock('../geometry/mesh-limits', async (original) => ({
  ...await original<typeof import('../geometry/mesh-limits')>(),
  MAX_MESH_TRIANGLES: 2,
}));

it('rejects aggregate tile output and terminates workers before merging it', async () => {
  let posted = 0;
  let terminated = 0;
  const worker: TileWorkerLike = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(job: LatticeTileJob) {
      posted++;
      queueMicrotask(() => worker.onmessage?.({ data: {
        type: 'result', tileId: job.tileId, triCount: 2,
        positions: new Float32Array(18), normals: new Float32Array(6),
        timing: { totalMs: 1, triCount: 2 },
      } }));
    },
    terminate() { terminated++; },
  };
  await expect(runTiledGeneration(
    DEFAULT_PARAMS, 0, 'sphere', 25,
    { min: [-29, -29, -29], max: [29, 29, 29] }, 36,
    () => {}, () => false,
    { workerCount: 1, createWorker: () => worker },
  )).rejects.toThrow(/triangle memory limit/);
  expect(posted).toBe(2);
  expect(terminated).toBeGreaterThan(0);
});

it('rejects oversized tiled scheduling before creating a worker', () => {
  const createWorker = vi.fn<() => TileWorkerLike>();
  expect(() => runTiledGeneration(
    DEFAULT_PARAMS, 0, 'sphere', 25,
    { min: [-29, -29, -29], max: [29, 29, 29] }, 1000,
    () => {}, () => false, { createWorker },
  )).toThrow(/grid.*memory limit/);
  expect(createWorker).not.toHaveBeenCalled();
});

it('charges backing buffers even when the tile exposes an empty view', async () => {
  const worker: TileWorkerLike = {
    onmessage: null, onerror: null, onmessageerror: null,
    postMessage(job: LatticeTileJob) {
      queueMicrotask(() => worker.onmessage?.({ data: {
        type: 'result', tileId: job.tileId, triCount: 0,
        positions: new Float32Array(new ArrayBuffer(100), 0, 0), normals: new Float32Array(0),
        timing: { totalMs: 1, triCount: 0 },
      } }));
    },
    terminate() {},
  };
  await expect(runTiledGeneration(
    DEFAULT_PARAMS, 0, 'sphere', 25,
    { min: [-29, -29, -29], max: [29, 29, 29] }, 36,
    () => {}, () => false, { workerCount: 1, createWorker: () => worker },
  )).rejects.toThrow(/triangle memory limit/);
});

it('refuses hole repair that would expand accepted output beyond the limit', () => {
  const result = {
    positions: new Float32Array([0,0,0, 1,0,0, 1,1,0, 0,0,0, 1,1,0, 0,1,0]),
    normals: new Float32Array([0,0,1, 0,0,1]),
    triCount: 2,
  };
  expect(() => closeBoundaryLoops(result)).toThrow(/triangle memory limit/);
  expect(result.triCount).toBe(2);
  expect(result.positions).toHaveLength(18);
});
