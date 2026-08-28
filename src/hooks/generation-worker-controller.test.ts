import { describe, expect, it } from 'vitest';
import {
  GenerationWorkerController,
  type GenerationResultResponse,
  type GenerationWorkerCallbacks,
  type GenerationWorkerLike,
  type WorkerErrorLike,
} from './generation-worker-controller';

class FakeWorker implements GenerationWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: WorkerErrorLike) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  posted: unknown[] = [];
  terminateCount = 0;
  postError: Error | null = null;

  postMessage(message: unknown): void {
    if (this.postError) throw this.postError;
    this.posted.push(message);
  }
  terminate(): void { this.terminateCount++; }
  emit(value: unknown): void { this.onmessage?.({ data: value }); }
  crash(message = 'boom'): void { this.onerror?.({ message }); }
  messageError(): void { this.onmessageerror?.({}); }
}

function result(marker = 1): GenerationResultResponse {
  return {
    type: 'result',
    positions: new Float32Array(9).fill(marker),
    normals: new Float32Array(3).fill(marker),
    triCount: 1,
    backend: 'cpu-single',
  };
}

function harness() {
  const failures: string[] = [];
  const results: GenerationResultResponse[] = [];
  const progress: number[] = [];
  const callbacks: GenerationWorkerCallbacks = {
    onProgress: (response) => progress.push(response.progress),
    onResult: (response) => results.push(response),
    onFailure: (message) => failures.push(message),
  };
  return { failures, results, progress, callbacks };
}

describe('main generation worker lifecycle', () => {
  it('recovers from crashes and unreadable messages without duplicate errors', () => {
    for (const fail of [(worker: FakeWorker) => worker.crash(), (worker: FakeWorker) => worker.messageError()]) {
      const worker = new FakeWorker();
      const state = harness();
      const controller = new GenerationWorkerController();
      controller.start(worker, state.callbacks);
      fail(worker);
      worker.crash('late duplicate');
      expect(controller.isActive).toBe(false);
      expect(worker.terminateCount).toBe(1);
      expect(state.failures).toHaveLength(1);
      expect(state.results).toEqual([]);
    }
  });

  it('rejects malformed responses and leaves the UI recoverable', () => {
    const worker = new FakeWorker();
    const ui = { generating: true, error: '' };
    const controller = new GenerationWorkerController();
    controller.start(worker, {
      onProgress: () => undefined,
      onResult: () => { ui.generating = false; },
      onFailure: (message) => { ui.generating = false; ui.error = message; },
    });
    worker.emit({ type: 'result', positions: new Float32Array(9), triCount: 1 });
    expect(ui.generating).toBe(false);
    expect(ui.error).toMatch(/malformed/);
    expect(controller.isActive).toBe(false);
  });

  it('reports a generation request that cannot be posted', () => {
    const worker = new FakeWorker();
    const state = harness();
    const controller = new GenerationWorkerController();
    controller.start(worker, state.callbacks);
    worker.postError = new Error('worker channel closed');

    controller.post({ type: 'generate' });

    expect(state.failures).toEqual(['Could not start generation worker: worker channel closed']);
    expect(controller.isActive).toBe(false);
    expect(worker.terminateCount).toBe(1);
  });

  it('invalidates cancellation races before a late result can commit', () => {
    const scheduled: (() => void)[] = [];
    const worker = new FakeWorker();
    const state = harness();
    const controller = new GenerationWorkerController((task) => scheduled.push(task));
    controller.start(worker, state.callbacks);
    expect(controller.cancel({ type: 'cancel' })).toBe(true);
    worker.emit(result());
    expect(state.results).toEqual([]);
    expect(worker.posted).toEqual([{ type: 'cancel' }]);
    expect(worker.terminateCount).toBe(0);
    scheduled[0]();
    expect(worker.terminateCount).toBe(1);
  });

  it('still terminates an invalidated worker when cancellation cannot be posted', () => {
    const scheduled: (() => void)[] = [];
    const worker = new FakeWorker();
    const state = harness();
    const controller = new GenerationWorkerController((task) => scheduled.push(task));
    controller.start(worker, state.callbacks);
    worker.postError = new Error('worker channel closed');

    expect(controller.cancel({ type: 'cancel' })).toBe(true);
    expect(controller.isActive).toBe(false);
    expect(scheduled).toHaveLength(1);
    scheduled[0]();
    expect(worker.terminateCount).toBe(1);
  });

  it('ignores stale messages after a replacement generation starts', () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const state = harness();
    const controller = new GenerationWorkerController();
    controller.start(first, state.callbacks);
    controller.start(second, state.callbacks);
    first.emit(result(1));
    second.emit(result(2));
    expect(first.terminateCount).toBe(1);
    expect(state.results).toHaveLength(1);
    expect(state.results[0].positions[0]).toBe(2);
  });
});
