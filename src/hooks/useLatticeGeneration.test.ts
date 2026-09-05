import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { useStore } from '../store/useStore';
import { DEFAULT_PARAMS, type ValidationResult } from '../types/project';
import type { WorkerMessage } from '../workers/lattice-worker';
import type { ValidationWorkerMessage } from '../workers/validation-worker';
import { useLatticeGeneration, type LatticeGenerationControls } from './useLatticeGeneration';

type ViewMode = ReturnType<typeof useStore.getState>['viewMode'];

vi.mock('../utils/notifications', () => ({
  requestNotificationPermission: vi.fn(),
  sendNotification: vi.fn(),
}));

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  message: WorkerMessage | ValidationWorkerMessage | null = null;
  terminated = false;

  constructor() { FakeWorker.instances.push(this); }
  postMessage(message: WorkerMessage | ValidationWorkerMessage, transfer: Transferable[] = []) {
    this.message = structuredClone(message, { transfer });
  }
  terminate() { this.terminated = true; }
  emit(data: unknown) { this.onmessage?.({ data }); }
}

const mesh = generateCubeMesh(10);
const validation: ValidationResult = {
  passed: true,
  outerDeviation: { passed: true, maxDeviation: 0, tolerance: 0.2 },
  minThickness: { passed: true, minMeasured: 1, required: 0.8, absoluteMin: 1, sampled: 10 },
  manifold: { passed: true, details: 'Mesh is manifold and watertight' },
  disconnected: { passed: true, fragmentCount: 1 },
  warnings: [],
};
let controls: LatticeGenerationControls;
function Harness({ capture }: { capture: (value: LatticeGenerationControls) => void }) {
  capture(useLatticeGeneration());
  return null;
}
function finishGeneration(worker = FakeWorker.instances[0]) {
  worker.emit({ type: 'result', ...mesh });
  return FakeWorker.instances.at(-1)!;
}

beforeEach(async () => {
  await expect.poll(() => useStore.getState().persistenceHydrated).toBe(true);
  useStore.getState().resetProject();
  useStore.getState().setSampleShape('sphere');
  FakeWorker.instances = [];
  vi.stubGlobal('Worker', FakeWorker);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  renderToString(createElement(Harness, { capture: (value) => { controls = value; } }));
});

afterEach(() => {
  controls.cancelGeneration();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('generation inputs and validation lifecycle', () => {
  const edits = [
    ['sample', () => useStore.getState().setSampleShape('cube')],
    ['import', () => useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl')],
    ['parameters', () => useStore.getState().updateParams({ wallThickness: 2 })],
    ['seed', () => useStore.getState().reseedGeneration()],
    ['constraints', () => useStore.getState().toggleKeepIn(1)],
    ['reset', () => useStore.getState().resetProject()],
    ['project restore', () => useStore.getState().restoreProject({
      params: DEFAULT_PARAMS, generationSeed: 12, originalMesh: null, meshInfo: null,
      meshFileName: 'Cube', sampleShape: 'cube', sphereRadius: 25, keepOutTris: [], keepInTris: [],
    })],
  ] as const;

  it.each(edits)('invalidates generation on %s edits and ignores late replies', (_name, edit) => {
    controls.startGeneration();
    const worker = FakeWorker.instances[0];
    edit();
    expect(worker.terminated).toBe(true);
    expect(useStore.getState().generating).toBe(false);
    worker.emit({ type: 'progress', progress: 1, message: 'stale' });
    finishGeneration(worker);
    expect(useStore.getState().resultMesh).toBeNull();
    expect(useStore.getState().validation).toBeNull();
    expect(useStore.getState().progressMessage).not.toBe('stale');
    expect(FakeWorker.instances).toHaveLength(1);
  });

  it.each(edits)('invalidates pending validation on %s edits', (_name, edit) => {
    controls.startGeneration();
    const worker = finishGeneration();
    edit();
    expect(worker.terminated).toBe(true);
    worker.emit({ type: 'result', validation });
    expect(useStore.getState().resultMesh).toBeNull();
    expect(useStore.getState().validation).toBeNull();
  });

  it('can generate again after invalidation without accepting an older result', () => {
    controls.startGeneration();
    const old = FakeWorker.instances[0];
    useStore.getState().setSampleShape('cube');
    expect(controls.canGenerate()).toBe(true);
    controls.startGeneration();
    old.emit({ type: 'result', ...mesh });
    expect(useStore.getState().generating).toBe(true);
    const worker = finishGeneration(FakeWorker.instances[1]);
    worker.emit({ type: 'result', validation });
    expect(useStore.getState().validation).toEqual(validation);
    expect(useStore.getState().resultMesh?.triCount).toBe(mesh.triCount);
  });

  it('validates captured inputs while allowing display and mass-density edits', () => {
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');
    useStore.getState().toggleKeepIn(1);
    const snapshot = useStore.getState();
    controls.startGeneration();
    useStore.getState().updateParams({ materialDensityGPerCm3: 1.2 });
    useStore.getState().setViewerBackground('#123456');
    const worker = finishGeneration();
    const message = worker.message as ValidationWorkerMessage;
    expect(message.params).toEqual(snapshot.params);
    expect(message.keepInTris).toEqual([1]);
    expect(message.meshPositions).toEqual(mesh.positions);
    expect(mesh.positions.byteLength).toBeGreaterThan(0);
    worker.emit({ type: 'result', validation });
    expect(useStore.getState().validation).toEqual(validation);
  });

  it('terminates validation on cancellation and ignores its late result', () => {
    controls.startGeneration();
    const worker = finishGeneration();
    controls.cancelGeneration();
    expect(worker.terminated).toBe(true);
    worker.emit({ type: 'result', validation });
    expect(useStore.getState().validation).toBeNull();
  });

  it('rejects empty generation results instead of enabling exports', () => {
    useStore.getState().setResultMesh(mesh);
    controls.startGeneration();
    FakeWorker.instances[0].emit({
      type: 'result', positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0,
    });
    expect(useStore.getState().generating).toBe(false);
    expect(useStore.getState().resultMesh).toBeNull();
    expect(useStore.getState().validation).toBeNull();
    expect(useStore.getState().generationError).toMatch(/empty mesh/);
    expect(FakeWorker.instances).toHaveLength(1);
  });
});

describe('completed generation view', () => {
  it('shows the first result in a result view', () => {
    controls.startGeneration();
    finishGeneration();
    expect(useStore.getState().viewMode).toBe('xray');
  });

  it.each<ViewMode>(['lattice', 'cross_section', 'xray'])('preserves %s when regenerating', (mode) => {
    useStore.getState().setResultMesh(mesh);
    useStore.getState().setViewMode(mode);
    controls.startGeneration();
    finishGeneration();
    expect(useStore.getState().viewMode).toBe(mode);
  });
});
