import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import { useModelImport } from './useModelImport';
import { useStore } from '../store/useStore';
import { DEFAULT_PARAMS } from '../types/project';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { exportBinarySTL } from '../geometry/stl-parser';
import { createProjectFile } from '../utils/project-file';

type Controls = ReturnType<typeof useModelImport>;
type Change = (event: React.ChangeEvent<HTMLInputElement>) => Promise<void>;

function controls(): Controls {
  let captured: Controls | undefined;
  function Harness() { captured = useModelImport(); return null; }
  renderToString(createElement(Harness));
  return captured!;
}

function change(intake: Controls, accept: '.stl' | '.json'): Change {
  return intake.fileInputs.props.children.find((input: { props: { accept: string } }) => input.props.accept === accept).props.onChange;
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
  await expect.poll(() => useStore.getState().persistenceHydrated).toBe(true);
  useStore.getState().resetProject();
});

describe('shared model intake ownership', () => {
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
    const older = change(first, '.stl')(event({ name: 'older.stl', size: 684, arrayBuffer: () => oldRead.promise }));
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
    await change(second, '.stl')(event({ name: 'newer.stl', size: stl.byteLength, arrayBuffer: async () => stl }));
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
    const older = change(first, '.stl')(event({ name: 'older.stl', size: 100, arrayBuffer: () => oldRead.promise }));
    second.loadSample('cube');
    await change(second, '.stl')(event({ name: 'newer.stl', size: 1, arrayBuffer: async () => new ArrayBuffer(1) }));
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
