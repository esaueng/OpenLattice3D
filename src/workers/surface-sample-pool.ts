// Bounded fan-out of surface-sampling streams to helper workers.
//
// Kept free of `self`/`Worker` globals so the scheduling, failure and response
// handling can be unit-tested in Node with fake workers.
import type { SurfaceHexSample } from '../geometry/lattice';
import { normalize } from '../geometry/vec3';
import type { SampleShape } from '../types/project';
import { failureCause, workerFailure } from '../utils/failure-cause';
import type { ShapeSampleWorkerMessage } from './surface-sample-worker';
import type { ShapeSampleParams, SurfaceSampleJob } from './surface-sampling';

/** The subset of the DOM Worker API the pool uses. */
export interface SampleWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessageerror: ((event: unknown) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}

/**
 * Run `jobs` with at most `concurrency` in flight and return their results in
 * job order, independent of completion order or concurrency.
 *
 * After the first failure no further job is started and the shared abort
 * signal fires so in-flight jobs can stop (e.g. terminate their worker). The
 * pool settles only once every started job has settled, then rejects with the
 * first error; later errors from aborted siblings are discarded.
 */
export async function runBoundedJobPool<J, R>(
  jobs: readonly J[],
  concurrency: number,
  run: (job: J, signal: AbortSignal) => R | Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(jobs.length);
  if (jobs.length === 0) return results;
  const controller = new AbortController();
  let nextJob = 0;
  let failure: { error: unknown } | null = null;

  const lane = async () => {
    while (!controller.signal.aborted && nextJob < jobs.length) {
      const index = nextJob++;
      try {
        results[index] = await run(jobs[index], controller.signal);
      } catch (error) {
        if (!failure) {
          failure = { error };
          controller.abort();
        }
        return;
      }
    }
  };

  const lanes = Math.min(Math.max(1, Math.floor(concurrency) || 1), jobs.length);
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  // TypeScript cannot see the assignment inside the async lanes.
  const settled = failure as { error: unknown } | null;
  if (settled) throw settled.error;
  return results;
}

/** Pack samples the way surface-sample-worker.ts replies (float32 xyz triples). */
export function packSurfaceSampleResponse(streamId: number, samples: readonly SurfaceHexSample[]): {
  streamId: number;
  positions: Float32Array;
  normals: Float32Array;
} {
  const positions = new Float32Array(samples.length * 3);
  const normals = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    positions.set(samples[i].pos, i * 3);
    normals.set(samples[i].normal, i * 3);
  }
  return { streamId, positions, normals };
}

/** Validate a helper worker's reply for `streamId` and unpack it, or throw. */
export function parseSurfaceSampleResponse(value: unknown, streamId: number): SurfaceHexSample[] {
  const response = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  const { positions, normals } = response;
  if (
    response.streamId !== streamId
    || !(positions instanceof Float32Array)
    || !(normals instanceof Float32Array)
    || positions.length !== normals.length
    || positions.length % 3 !== 0
  ) {
    throw workerFailure('Surface sampling worker returned a malformed response');
  }
  const samples: SurfaceHexSample[] = [];
  for (let j = 0; j < positions.length; j += 3) {
    samples.push({
      pos: [positions[j], positions[j + 1], positions[j + 2]],
      normal: normalize([normals[j], normals[j + 1], normals[j + 2]]),
    });
  }
  return samples;
}

/**
 * Run one stream on a fresh helper worker. The worker is always terminated
 * when the job settles, and immediately when `signal` aborts.
 */
export function runSurfaceSampleWorkerJob(
  createWorker: () => SampleWorkerLike,
  payload: ShapeSampleWorkerMessage,
  signal: AbortSignal,
): Promise<SurfaceHexSample[]> {
  if (signal.aborted) return Promise.reject(new Error('Surface sampling was stopped'));
  let worker: SampleWorkerLike;
  try {
    worker = createWorker();
  } catch (error) {
    return Promise.reject(failureCause(error) ? error : workerFailure('Could not start surface sampling worker'));
  }
  let onAbort: (() => void) | null = null;
  return new Promise<SurfaceHexSample[]>((resolve, reject) => {
    onAbort = () => reject(new Error('Surface sampling was stopped'));
    signal.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = (event) => {
      try {
        resolve(parseSurfaceSampleResponse(event.data, payload.streamId));
      } catch (error) {
        reject(error);
      }
    };
    worker.onerror = () => reject(workerFailure('Surface sampling worker failed'));
    worker.onmessageerror = () => reject(workerFailure('Surface sampling worker returned an unreadable response'));
    try {
      worker.postMessage(payload);
    } catch (error) {
      reject(failureCause(error) ? error : workerFailure('Could not send data to the surface sampling worker'));
    }
  }).finally(() => {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  });
}

export interface PoissonSampleRun {
  shape: SampleShape;
  params: ShapeSampleParams;
  jobs: readonly SurfaceSampleJob[];
  minDistance: number;
  maxWorkers: number;
  /** In-thread fallback used when only one worker is allowed. */
  sampleInline: (job: SurfaceSampleJob) => SurfaceHexSample[];
  createWorker: () => SampleWorkerLike;
}

/**
 * Sample every stream, inline or on bounded helper workers, and return the
 * per-stream results in job (stream) order so the merged set never depends on
 * worker count or completion order. The first failing stream stops the run.
 */
export async function sampleSurfaceStreams(run: PoissonSampleRun): Promise<SurfaceHexSample[][]> {
  const { shape, params, jobs, minDistance, maxWorkers } = run;
  return runBoundedJobPool(jobs, maxWorkers, (job, signal) => {
    if (maxWorkers <= 1) {
      // Round-trip through the worker wire format so the merged samples are
      // bit-identical whether or not helper workers were available.
      return parseSurfaceSampleResponse(
        packSurfaceSampleResponse(job.streamId, run.sampleInline(job)),
        job.streamId,
      );
    }
    return runSurfaceSampleWorkerJob(run.createWorker, {
      mode: 'shape',
      shape,
      params,
      targetCount: job.targetCount,
      minDistance,
      streamSeed: job.streamSeed,
      streamId: job.streamId,
    }, signal);
  });
}
