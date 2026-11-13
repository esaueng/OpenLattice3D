import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelImport } from './useModelImport';
import { useStore } from '../store/useStore';
import { DEFAULT_PARAMS } from '../types/project';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { exportBinarySTL } from '../geometry/stl-parser';
import { createProjectFile } from '../utils/project-file';
import { readModelFile, type IntakeRequest } from '../workers/model-intake';
import { modelIntake } from './model-intake-client';
import { usePendingReplacement } from './pending-model-replacement';
import type { GenerationWorkerLike, WorkerErrorLike } from './generation-worker-controller';
import { MESH_FILE_ACCEPT } from '../utils/dropped-files';
import { create3MF } from '../geometry/three-mf';
import { buildObj } from '../utils/obj';
import { trackFailure, trackFeature } from '../analytics';
import { failureCause } from '../utils/failure-cause';

vi.mock('../analytics', async (importOriginal) => ({
  ...await importOriginal<typeof import('../analytics')>(),
  trackFailure: vi.fn(),
  trackFeature: vi.fn(),
}));

// Exercise actual file reads/parsers in Node while retaining worker lifecycle
// and deliberately delivering late messages after termination.
class InProcessWorker implements GenerationWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: WorkerErrorLike) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  postMessage(request: IntakeRequest) {
    const deliver = this.onmessage;
    void readModelFile(request).then(
      result => deliver?.({ data: { type: 'result', result } }),
      error => deliver?.({ data: { type: 'error', message: error.message } }),
    );
  }
  terminate() {}
}

type Controls = ReturnType<typeof useModelImport>;
type Change = (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;

function controls(): Controls {
  let captured: Controls | undefined;
  function Harness() { captured = useModelImport(); return null; }
  renderToString(createElement(Harness));
  return captured!;
}

function change(intake: Controls, accept: 'mesh' | '.json'): Change {
  const wanted = accept === 'mesh' ? MESH_FILE_ACCEPT : accept;
  return intake.fileInputs.props.children.find((input: { props: { accept: string } }) => input.props.accept === wanted).props.onChange;
}

function event(file: Pick<File, 'name' | 'size'> & Partial<Pick<File, 'text' | 'arrayBuffer'>>): React.ChangeEvent<HTMLInputElement> {
  return { target: { files: [file], value: 'selected' } } as unknown as React.ChangeEvent<HTMLInputElement>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function parameterFile(name: string, cellSize: number) {
  return { name, size: 20, text: async () => JSON.stringify({ cellSize }) };
}

beforeEach(async () => {
  vi.stubGlobal('Worker', InProcessWorker);
  await expect.poll(() => useStore.getState().persistenceHydrated).toBe(true);
  useStore.getState().resetProject();
});
afterEach(() => { modelIntake.dispose(); vi.unstubAllGlobals(); });

describe('import analytics wiring', () => {
  beforeEach(() => vi.clearAllMocks());
  it('records an import action for a model and parameters', async () => {
    const mesh = generateCubeMesh(10);
    const stl = exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount);
    const intake = controls();
    await change(intake, 'mesh')(event({ name: 'private-part.stl', size: stl.byteLength, arrayBuffer: async () => stl }));
    await change(intake, '.json')(event(parameterFile('private.json', 11)));
    expect(vi.mocked(trackFeature).mock.calls).toEqual([['import'], ['import']]);
    expect(trackFailure).not.toHaveBeenCalled();
  });
  it('records error_import with a worker cause when the import worker crashes', async () => {
    class CrashingWorker extends InProcessWorker {
      override postMessage() { this.onerror?.({ message: 'private-part.stl' }); }
    }
    vi.stubGlobal('Worker', CrashingWorker);
    await change(controls(), '.json')(event(parameterFile('private.json', 11)));
    expect(trackFailure).toHaveBeenCalledExactlyOnceWith('error_import', expect.any(Error));
    expect(failureCause(vi.mocked(trackFailure).mock.calls[0][1])).toBe('worker');
    expect(trackFeature).not.toHaveBeenCalled();
  });
  it('records error_import for unreadable files and files without usable parameters', async () => {
    const intake = controls();
    await change(intake, '.json')(event({ name: 'broken.json', size: 5, text: async () => '{bad' }));
    await change(intake, '.json')(event({ name: 'empty.json', size: 2, text: async () => '{}' }));
    expect(vi.mocked(trackFailure).mock.calls.map((call) => call[0])).toEqual(['error_import', 'error_import']);
  });
});

describe('shared model intake ownership', () => {
  it('preserves the valid model when startup, crash or protocol failure occurs', async () => {
    for (const failure of ['startup', 'crash', 'malformed']) {
      class FailingWorker extends InProcessWorker {
        constructor() { super(); if (failure === 'startup') throw new Error('startup blocked'); }
        override postMessage() {
          if (failure === 'crash') this.onerror?.({ message: 'crash' });
          else this.onmessage?.({ data: { type: 'result', result: {} } });
        }
      }
      vi.stubGlobal('Worker', FailingWorker);
      useStore.getState().setSampleShape('sphere');
      const intake = controls();
      await change(intake, '.json')(event(parameterFile('failure.json', 11)));
      expect(useStore.getState().sampleShape).toBe('sphere');
      expect(useStore.getState().params.cellSize).toBe(DEFAULT_PARAMS.cellSize);
      expect(useStore.getState().importNotice).toMatchObject({ level: 'error', message: expect.stringContaining('failure.json') });
    }
  });

  it('keeps the newer parameter import across separate hook instances', async () => {
    const first = controls();
    const second = controls();
    const oldRead = deferred<string>();
    const older = change(first, '.json')(event({ name: 'older.json', size: 20, text: () => oldRead.promise }));
    await change(second, '.json')(event(parameterFile('newer.json', 11)));
    const notice = useStore.getState().importNotice;
    oldRead.resolve(JSON.stringify({ cellSize: 7 }));
    await older;
    expect(useStore.getState().params.cellSize).toBe(11);
    expect(useStore.getState().importNotice).toEqual(notice);
    expect(useStore.getState().logs.some((entry) => entry.message.includes('Imported') && entry.message.includes('older.json'))).toBe(false);
  });

  it('does not let a delayed STL replace a newer sample', async () => {
    const first = controls();
    const second = controls();
    const oldRead = deferred<ArrayBuffer>();
    const older = change(first, 'mesh')(event({ name: 'older.stl', size: 684, arrayBuffer: () => oldRead.promise }));
    second.loadSample('torus');
    const mesh = generateCubeMesh(10);
    oldRead.resolve(exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount));
    await older;
    expect(useStore.getState().sampleShape).toBe('torus');
    expect(useStore.getState().originalMesh).toBeNull();
    expect(useStore.getState().importNotice).toBeNull();
  });

  it('does not let a delayed full project undo a newer STL', async () => {
    const first = controls();
    const second = controls();
    const oldRead = deferred<string>();
    const older = change(first, '.json')(event({ name: 'older-project.json', size: 100, text: () => oldRead.promise }));
    const mesh = generateCubeMesh(10);
    const stl = exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount);
    await change(second, 'mesh')(event({ name: 'newer.stl', size: stl.byteLength, arrayBuffer: async () => stl }));
    const notice = useStore.getState().importNotice;
    oldRead.resolve(JSON.stringify(createProjectFile({
      params: { ...DEFAULT_PARAMS, cellSize: 7 }, generationSeed: 0,
      source: { kind: 'sample', fileName: 'Cube', shape: 'cube', sphereRadius: 25 },
      keepOutTris: new Set(), keepInTris: new Set(), validation: null,
      clipPlane: { axis: 'z', position: 0.5, flipped: false }, viewerBackground: '#000000',
    })));
    await older;
    expect(useStore.getState().meshFileName).toBe('newer.stl');
    expect(useStore.getState().originalMesh?.triCount).toBe(mesh.triCount);
    expect(useStore.getState().sampleShape).toBeNull();
    expect(useStore.getState().importNotice).toEqual(notice);
  });

  it('does not restore parameters or errors after reset supersedes an import', async () => {
    for (const failed of [false, true]) {
      const intake = controls();
      const oldRead = deferred<string>();
      const older = change(intake, '.json')(event({ name: 'older.json', size: 20, text: () => oldRead.promise }));
      useStore.getState().resetProject();
      if (failed) oldRead.reject(new Error('old read failed'));
      else oldRead.resolve(JSON.stringify({ cellSize: 7 }));
      await older;
      expect(useStore.getState().params).toEqual(DEFAULT_PARAMS);
      expect(useStore.getState().importNotice).toBeNull();
      expect(useStore.getState().logs).toEqual([]);
    }
  });

  it('keeps the previous valid model when the latest import fails and suppresses an older failure notice', async () => {
    const first = controls();
    first.loadSample('sphere');
    const oldRead = deferred<string>();
    const older = change(first, '.json')(event({ name: 'older.json', size: 20, text: () => oldRead.promise }));
    await change(controls(), '.json')(event({ name: 'newer.json', size: 5, text: async () => '{bad' }));
    const notice = useStore.getState().importNotice;
    oldRead.reject(new Error('older failure'));
    await older;
    expect(useStore.getState().sampleShape).toBe('sphere');
    expect(notice?.message).toContain('newer.json');
    expect(useStore.getState().importNotice).toEqual(notice);
    expect(useStore.getState().logs.some((entry) => entry.message.includes('older failure'))).toBe(false);
  });

  it('preserves a newer sample and its notice when an older STL read fails', async () => {
    const first = controls();
    const second = controls();
    const oldRead = deferred<ArrayBuffer>();
    const older = change(first, 'mesh')(event({ name: 'older.stl', size: 100, arrayBuffer: () => oldRead.promise }));
    second.loadSample('cube');
    await change(second, 'mesh')(event({ name: 'newer.stl', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }));
    const notice = useStore.getState().importNotice;
    expect(notice?.message).toContain('newer.stl');
    expect(notice?.detail).toBe('The previous model is still loaded.');
    oldRead.reject(new Error('older STL failure'));
    await older;
    expect(useStore.getState().sampleShape).toBe('cube');
    expect(useStore.getState().importNotice).toEqual(notice);
    expect(useStore.getState().logs.some((entry) => entry.message.includes('older STL failure'))).toBe(false);
  });
});

describe('confirm before replacing work', () => {
  function stlFile(name: string, size = 10) {
    const mesh = generateCubeMesh(size);
    const stl = exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount);
    return { name, size: stl.byteLength, arrayBuffer: async () => stl };
  }

  it('loads a sample straight away when nothing would be lost', () => {
    const intake = controls();
    intake.loadSample('sphere');
    intake.loadSample('cube');
    expect(useStore.getState().sampleShape).toBe('cube');
    expect(usePendingReplacement.getState().pending).toBeNull();
  });

  it('holds a sample load while a result exists, and loads it only on confirmation', () => {
    const intake = controls();
    intake.loadSample('sphere');
    useStore.getState().setResultMesh(generateCubeMesh(10), null);
    intake.loadSample('cube');
    expect(useStore.getState().sampleShape).toBe('sphere');
    expect(useStore.getState().resultMesh).not.toBeNull();
    expect(usePendingReplacement.getState().pending).toMatchObject({ kind: 'sample', shape: 'cube' });
    expect(useStore.getState().logs.at(-1)?.message).toContain('would discard the generated lattice');

    intake.confirmReplacement();
    expect(useStore.getState().sampleShape).toBe('cube');
    expect(useStore.getState().resultMesh).toBeNull();
    expect(usePendingReplacement.getState().pending).toBeNull();
  });

  it('keeps an imported STL with painted faces when the user cancels a new STL', async () => {
    const intake = controls();
    await change(intake, 'mesh')(event(stlFile('first.stl')));
    useStore.getState().markFaces([0, 1, 2], 'keep_out');
    await change(intake, 'mesh')(event(stlFile('second.stl', 20)));
    expect(useStore.getState().meshFileName).toBe('first.stl');
    expect(useStore.getState().keepOutTris.size).toBe(3);
    expect(usePendingReplacement.getState().pending).toMatchObject({ kind: 'mesh', fileName: 'second.stl' });

    intake.cancelReplacement();
    expect(usePendingReplacement.getState().pending).toBeNull();
    expect(useStore.getState().meshFileName).toBe('first.stl');
    expect(useStore.getState().keepOutTris.size).toBe(3);
    // Undo history survives a cancelled replacement.
    expect(useStore.getState().selectionUndo.length).toBeGreaterThan(0);
  });

  it('commits a held STL import with its notice once confirmed', async () => {
    const intake = controls();
    await change(intake, 'mesh')(event(stlFile('first.stl')));
    useStore.getState().markFaces([0], 'keep_in');
    vi.mocked(trackFeature).mockClear();
    await intake.importFile(stlFile('second.stl', 20) as unknown as File);
    expect(trackFeature).not.toHaveBeenCalled();
    intake.confirmReplacement();
    expect(trackFeature).toHaveBeenCalledExactlyOnceWith('import');
    expect(useStore.getState().meshFileName).toBe('second.stl');
    expect(useStore.getState().keepInTris.size).toBe(0);
    expect(useStore.getState().importNotice).not.toBeNull();
  });

  it('drops a held replacement once the model changes another way', () => {
    const intake = controls();
    intake.loadSample('sphere');
    useStore.getState().setResultMesh(generateCubeMesh(10), null);
    intake.loadSample('torus');
    expect(usePendingReplacement.getState().pending).not.toBeNull();
    useStore.getState().resetProject();
    expect(usePendingReplacement.getState().pending).toBeNull();
    intake.confirmReplacement();
    expect(useStore.getState().sampleShape).toBeNull();
  });

  it('explains an unsupported dropped file and keeps the model', async () => {
    const intake = controls();
    intake.loadSample('cube');
    await intake.importFile({ name: 'part.step', size: 10 } as File);
    expect(useStore.getState().sampleShape).toBe('cube');
    expect(useStore.getState().importNotice).toMatchObject({ level: 'error', message: expect.stringContaining('.stl, .3mf or .obj'), detail: 'The previous model is still loaded.' });
  });
});

describe('3MF and OBJ intake routing', () => {
  const bytesFile = (name: string, bytes: Uint8Array) => {
    const buffer = bytes.slice().buffer;
    return { name, size: bytes.byteLength, arrayBuffer: async () => buffer } as unknown as File;
  };

  it('imports a dropped 3MF and OBJ through the shared worker intake', async () => {
    const intake = controls();
    await intake.importFile(bytesFile('plate.3mf', create3MF(generateCubeMesh(12))));
    expect(useStore.getState().meshFileName).toBe('plate.3mf');
    expect(useStore.getState().meshInfo).toMatchObject({ triangleCount: 12, volumeMm3: 1728 });
    expect(useStore.getState().importNotice).toMatchObject({ level: 'info', scalePrompt: false });
    expect(useStore.getState().logs.some((entry) => entry.message.includes('3MF declares unit "millimeter"'))).toBe(true);

    useStore.getState().resetProject();
    const obj = buildObj(generateCubeMesh(8), { meshFileName: 'x', params: DEFAULT_PARAMS });
    await change(intake, 'mesh')(event(bytesFile('part.obj', obj)));
    expect(useStore.getState().meshFileName).toBe('part.obj');
    expect(useStore.getState().meshInfo).toMatchObject({ triangleCount: 12, volumeMm3: 512 });
  });

  it('holds a 3MF that would replace work until confirmed', async () => {
    const intake = controls();
    await intake.importFile(bytesFile('first.obj', buildObj(generateCubeMesh(8), { meshFileName: 'x', params: DEFAULT_PARAMS })));
    useStore.getState().markFaces([0], 'keep_out');
    await intake.importFile(bytesFile('second.3mf', create3MF(generateCubeMesh(12))));
    expect(useStore.getState().meshFileName).toBe('first.obj');
    expect(usePendingReplacement.getState().pending).toMatchObject({ kind: 'mesh', fileName: 'second.3mf', result: { format: '3mf' } });
    intake.confirmReplacement();
    expect(useStore.getState().meshFileName).toBe('second.3mf');
  });

  it('reports a malformed 3MF and keeps the previous model', async () => {
    const intake = controls();
    intake.loadSample('cube');
    const truncated = create3MF(generateCubeMesh(12)).slice(0, 100);
    await intake.importFile(bytesFile('broken.3mf', truncated));
    expect(useStore.getState().sampleShape).toBe('cube');
    expect(useStore.getState().importNotice).toMatchObject({
      level: 'error', message: expect.stringContaining('Could not import broken.3mf: 3MF package is not a readable ZIP'), detail: 'The previous model is still loaded.',
    });
  });

  it('checks the 3MF byte budget on the main thread before starting the worker', async () => {
    const intake = controls();
    const read = vi.fn();
    await intake.importFile({ name: 'huge.3mf', size: 129 * 1024 * 1024, arrayBuffer: read } as unknown as File);
    expect(read).not.toHaveBeenCalled();
    expect(useStore.getState().importNotice).toMatchObject({ level: 'error', message: expect.stringContaining('3MF file huge.3mf is 129 MiB, exceeding the 128 MiB import limit') });
  });
});
