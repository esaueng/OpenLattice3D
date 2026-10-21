import { describe, expect, it } from 'vitest';
import { ModelIntakeController } from './model-intake-controller';
import type { GenerationWorkerLike, WorkerErrorLike } from './generation-worker-controller';
import { prepareStl } from '../workers/model-intake';
import { exportBinarySTL } from '../geometry/stl-parser';
import { generateCubeMesh } from '../geometry/mesh-analysis';

class FakeWorker implements GenerationWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: WorkerErrorLike) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  terminated = 0;
  posted: unknown[] = [];
  postMessage(request: unknown) { this.posted.push(request); }
  terminate() { this.terminated++; }
}
const request = { kind: 'json' as const, file: { name: 'test.json', size: 20 } as File };
const result = { type: 'result', result: { kind: 'json', parsed: { kind: 'parameters', params: { cellSize: 11 }, accepted: ['cellSize'], warnings: [] } } };

describe('shared model intake worker controller', () => {
  it('terminates superseded work, ignores captured late callbacks, and does not cancel a newer owner', async () => {
    const first = new FakeWorker();
    const second = new FakeWorker();
    const workers = [first, second];
    const controller = new ModelIntakeController(() => workers.shift()!);
    const old = controller.run(10, request);
    const lateMessage = first.onmessage!;
    const lateError = first.onerror!;
    const newer = controller.run(11, request);
    expect(await old).toBeNull();
    expect(first.terminated).toBe(1);
    expect(first.onmessage).toBeNull();
    lateMessage({ data: result });
    lateError({ message: 'old crash' });
    controller.cancelUnless(11);
    expect(second.terminated).toBe(0);
    second.onmessage!({ data: result });
    expect(await newer).toEqual(result.result);
    expect(second.terminated).toBe(1);
    expect(second.onerror).toBeNull();
    expect(second.posted).toEqual([request]);
  });

  it('stops work immediately when sample, reset or unmount advances the epoch', async () => {
    const worker = new FakeWorker();
    const controller = new ModelIntakeController(() => worker);
    const pending = controller.run(20, request);
    controller.cancelUnless(21);
    expect(await pending).toBeNull();
    expect(worker.terminated).toBe(1);
    expect(worker.onmessageerror).toBeNull();
    controller.dispose();
    expect(worker.terminated).toBe(1);
  });

  it('settles start, post, crash, decode and worker-reported failures with cleanup', async () => {
    const startup = new ModelIntakeController(() => { throw new Error('blocked'); });
    await expect(startup.run(1, request)).rejects.toThrow('Could not start import worker: blocked');
    for (const failure of ['post', 'crash', 'decode', 'reported']) {
      const worker = new FakeWorker();
      if (failure === 'post') worker.postMessage = () => { throw new Error('post failed'); };
      const controller = new ModelIntakeController(() => worker);
      const pending = controller.run(1, request);
      const expected = expect(pending).rejects.toThrow(/post failed|crashed|unreadable|bad STL/);
      if (failure === 'crash') worker.onerror!({ message: 'boom' });
      if (failure === 'decode') worker.onmessageerror!({});
      if (failure === 'reported') worker.onmessage!({ data: { type: 'error', message: 'bad STL' } });
      await expected;
      expect(worker.terminated).toBe(1);
      expect([worker.onmessage, worker.onerror, worker.onmessageerror]).toEqual([null, null, null]);
    }
  });

  it('rejects malformed and wrong-kind results without exposing partial state', async () => {
    const cube = generateCubeMesh(10);
    const stl = prepareStl(exportBinarySTL(cube.positions, cube.normals, cube.triCount), 'cube.stl');
    for (const malformed of [null, {}, { type: 'error', message: '' },
      { type: 'result', result: stl },
      { type: 'result', result: { ...result.result, parsed: { kind: 'parameters', params: { cellSize: NaN }, accepted: ['cellSize'], warnings: [] } } },
      { type: 'result', result: { kind: 'json', parsed: { kind: 'project', params: {} } } },
    ]) {
      const worker = new FakeWorker();
      const controller = new ModelIntakeController(() => worker);
      const pending = controller.run(1, request);
      worker.onmessage!({ data: malformed });
      await expect(pending).rejects.toThrow('malformed');
      expect(worker.terminated).toBe(1);
    }
  });
});
