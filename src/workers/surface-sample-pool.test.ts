import { describe, expect, it } from 'vitest';
import {
  packSurfaceSampleResponse,
  parseSurfaceSampleResponse,
  runBoundedJobPool,
  sampleSurfaceStreams,
  type SampleWorkerLike,
} from './surface-sample-pool';
import type { ShapeSampleWorkerMessage } from './surface-sample-worker';
import { buildSurfaceSampleJobs, generateShapeSurfaceSamples, type ShapeSampleParams } from './surface-sampling';

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('runBoundedJobPool', () => {
  it('returns results in job order whatever order jobs finish in', async () => {
    const gates = [0, 1, 2, 3, 4].map(() => deferred<number>());
    const pool = runBoundedJobPool([0, 1, 2, 3, 4], 5, (job) => gates[job].promise);
    for (const job of [4, 2, 0, 3, 1]) gates[job].resolve(job * 10);
    await expect(pool).resolves.toEqual([0, 10, 20, 30, 40]);
  });

  it('never has more than `concurrency` jobs in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const results = await runBoundedJobPool(Array.from({ length: 12 }, (_, i) => i), 3, async (job) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await flush();
      inFlight--;
      return job;
    });
    expect(peak).toBe(3);
    expect(results).toEqual(Array.from({ length: 12 }, (_, i) => i));
  });

  it('stops scheduling after the first failure, aborts in-flight jobs and rejects with that error', async () => {
    const started: number[] = [];
    const aborted: number[] = [];
    const gates = Array.from({ length: 8 }, () => deferred<number>());
    let settled = false;
    const pool = runBoundedJobPool(Array.from({ length: 8 }, (_, i) => i), 3, (job, signal) => {
      started.push(job);
      signal.addEventListener('abort', () => {
        aborted.push(job);
        gates[job].reject(new Error(`job ${job} stopped`));
      });
      return gates[job].promise;
    });
    pool.then(() => { settled = true; }, () => { settled = true; });
    expect(started).toEqual([0, 1, 2]);

    gates[1].reject(new Error('job 1 failed'));
    await expect(pool).rejects.toThrow('job 1 failed');
    expect(settled).toBe(true);
    expect(started).toEqual([0, 1, 2]);
    expect(aborted).toEqual(expect.arrayContaining([0, 2]));
  });

  it('does not start queued jobs when in-flight siblings finish after a failure', async () => {
    const started: number[] = [];
    const gates = Array.from({ length: 6 }, () => deferred<number>());
    const pool = runBoundedJobPool(Array.from({ length: 6 }, (_, i) => i), 2, (job) => {
      started.push(job);
      return gates[job].promise;
    });
    gates[0].reject(new Error('first'));
    await flush();
    // Job 1 ignores the abort signal and completes normally afterwards.
    gates[1].resolve(1);
    await expect(pool).rejects.toThrow('first');
    expect(started).toEqual([0, 1]);
  });

  it('handles synchronous runners and an empty job list', async () => {
    await expect(runBoundedJobPool([1, 2, 3], 1, (job) => job * 2)).resolves.toEqual([2, 4, 6]);
    await expect(runBoundedJobPool([], 4, () => 1)).resolves.toEqual([]);
    await expect(runBoundedJobPool([1, 2], 2, () => { throw new Error('sync'); })).rejects.toThrow('sync');
  });
});

class FakeSampleWorker implements SampleWorkerLike {
  static instances: FakeSampleWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  message: ShapeSampleWorkerMessage | null = null;
  terminated = false;
  constructor() { FakeSampleWorker.instances.push(this); }
  postMessage(message: unknown) { this.message = message as ShapeSampleWorkerMessage; }
  terminate() { this.terminated = true; }
  /** Reply the way surface-sample-worker.ts does. */
  replyWithSamples() {
    const m = this.message!;
    const samples = generateShapeSurfaceSamples(m.shape, m.params, m.targetCount, m.minDistance, m.streamSeed);
    this.onmessage?.({ data: packSurfaceSampleResponse(m.streamId, samples) });
  }
}

const shapeParams: ShapeSampleParams = { radius: 25 };
const MIN_DISTANCE = 6;

function streamRun(maxWorkers: number, targetCount = 120) {
  FakeSampleWorker.instances = [];
  return {
    shape: 'sphere' as const,
    params: shapeParams,
    jobs: buildSurfaceSampleJobs(42, 'sphere', targetCount),
    minDistance: MIN_DISTANCE,
    maxWorkers,
    sampleInline: (job: { targetCount: number; streamSeed: number }) => generateShapeSurfaceSamples(
      'sphere', shapeParams, job.targetCount, MIN_DISTANCE, job.streamSeed,
    ),
    createWorker: () => new FakeSampleWorker(),
  };
}

describe('sampleSurfaceStreams', () => {
  it('produces identical samples inline and on helper workers, whatever the reply order', async () => {
    const inline = await sampleSurfaceStreams(streamRun(1));
    expect(FakeSampleWorker.instances).toHaveLength(0);

    const run = streamRun(4);
    const pending = sampleSurfaceStreams(run);
    expect(FakeSampleWorker.instances).toHaveLength(run.jobs.length);
    for (const worker of [...FakeSampleWorker.instances].reverse()) worker.replyWithSamples();
    const parallel = await pending;

    expect(parallel).toEqual(inline);
    expect(parallel.flat().length).toBeGreaterThan(0);
    expect(FakeSampleWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });

  it('stops after the first failed worker: no new workers, in-flight ones terminated', async () => {
    const run = streamRun(2);
    expect(run.jobs.length).toBeGreaterThan(2);
    const pending = sampleSurfaceStreams(run);
    expect(FakeSampleWorker.instances).toHaveLength(2);
    const [failing, sibling] = FakeSampleWorker.instances;

    failing.onerror?.({});
    await expect(pending).rejects.toMatchObject({ message: 'Surface sampling worker failed', diagnostic: 'worker' });
    expect(FakeSampleWorker.instances).toHaveLength(2);
    expect(failing.terminated).toBe(true);
    expect(sibling.terminated).toBe(true);
    // A late reply from the stopped sibling is ignored.
    expect(sibling.onmessage).toBeNull();
  });

  it('fails the run on an unreadable or malformed worker reply', async () => {
    const unreadable = sampleSurfaceStreams(streamRun(2));
    FakeSampleWorker.instances[0].onmessageerror?.({});
    await expect(unreadable).rejects.toThrow('unreadable response');
    expect(FakeSampleWorker.instances.every((worker) => worker.terminated)).toBe(true);

    const malformed = sampleSurfaceStreams(streamRun(2));
    FakeSampleWorker.instances[1].onmessage?.({ data: { streamId: 99, positions: new Float32Array(3), normals: new Float32Array(3) } });
    await expect(malformed).rejects.toThrow('malformed response');
    expect(FakeSampleWorker.instances).toHaveLength(2);
    expect(FakeSampleWorker.instances.every((worker) => worker.terminated)).toBe(true);
  });
});

describe('parseSurfaceSampleResponse', () => {
  it('unpacks a well-formed reply with unit normals', () => {
    const samples = parseSurfaceSampleResponse({
      streamId: 2,
      positions: new Float32Array([1, 2, 3]),
      normals: new Float32Array([0, 0, 2]),
    }, 2);
    expect(samples).toEqual([{ pos: [1, 2, 3], normal: [0, 0, 1] }]);
  });

  it.each([
    ['null', null],
    ['wrong stream', { streamId: 1, positions: new Float32Array(3), normals: new Float32Array(3) }],
    ['plain arrays', { streamId: 0, positions: [0, 0, 0], normals: [0, 0, 1] }],
    ['length mismatch', { streamId: 0, positions: new Float32Array(6), normals: new Float32Array(3) }],
    ['partial triple', { streamId: 0, positions: new Float32Array(4), normals: new Float32Array(4) }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseSurfaceSampleResponse(value, 0)).toThrow('malformed response');
  });
});
