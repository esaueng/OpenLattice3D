import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS } from '../types/project';
import { useStore } from './useStore';

describe('selection history', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  it('undoes and redoes keep-out painting', () => {
    useStore.getState().toggleKeepOut(4);
    expect(useStore.getState().keepOutTris.has(4)).toBe(true);
    expect(useStore.getState().selectionUndo).toHaveLength(1);

    useStore.getState().undoSelection();
    expect(useStore.getState().keepOutTris.has(4)).toBe(false);
    expect(useStore.getState().selectionRedo).toHaveLength(1);

    useStore.getState().redoSelection();
    expect(useStore.getState().keepOutTris.has(4)).toBe(true);
  });

  it('clears redo history after a new painting action', () => {
    useStore.getState().toggleKeepOut(1);
    useStore.getState().undoSelection();
    useStore.getState().toggleKeepIn(2);
    expect(useStore.getState().selectionRedo).toHaveLength(0);
  });
});

describe('project restoration', () => {
  it('restores source geometry and masks while clearing derived results', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().restoreProject({
      params: { ...DEFAULT_PARAMS, latticeType: 'bcc' },
      originalMesh: mesh,
      meshInfo: analyzeMesh(mesh),
      meshFileName: 'restored.stl',
      sampleShape: null,
      sphereRadius: 25,
      keepOutTris: [1, 2],
      keepInTris: [3],
    });
    const state = useStore.getState();
    expect(state.meshFileName).toBe('restored.stl');
    expect(state.params.latticeType).toBe('bcc');
    expect(Array.from(state.keepOutTris)).toEqual([1, 2]);
    expect(Array.from(state.keepInTris)).toEqual([3]);
    expect(state.resultMesh).toBeNull();
    expect(state.validation).toBeNull();
    expect(state.selectionUndo).toEqual([]);
  });
});
