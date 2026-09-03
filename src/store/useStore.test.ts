import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS } from '../types/project';
import { buildPersistedAppState, hydrateFromSnapshot, useStore } from './useStore';

describe('persistence hydration', () => {
  it('releases the boot gate when browser storage is unavailable', async () => {
    await expect.poll(() => useStore.getState().persistenceHydrated).toBe(true);
  });

  it('persists preferences without source or generated mesh data', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'private-part.stl');
    useStore.getState().setResultMesh(mesh);

    const snapshot = buildPersistedAppState(useStore.getState()) as unknown as Record<string, unknown>;
    expect(snapshot).not.toHaveProperty('originalMesh');
    expect(snapshot).not.toHaveProperty('resultMesh');
    expect(snapshot).not.toHaveProperty('meshFileName');
    expect(snapshot).not.toHaveProperty('logs');
    expect(snapshot).toHaveProperty('params');
    expect(snapshot).toHaveProperty('generationSeed');
    expect(snapshot).toHaveProperty('viewerBackground');
  });

  it('drops geometry and unsafe CSS from legacy IndexedDB snapshots', () => {
    const mesh = generateCubeMesh(10);
    const legacySnapshot = {
      version: 1,
      savedAt: Date.now(),
      params: { ...DEFAULT_PARAMS, exportResolution: 1_000_000 },
      originalMesh: mesh,
      resultMesh: mesh,
      meshFileName: 'private-part.stl',
      logs: [{ time: Date.now(), level: 'info', message: 'private-part.stl' }],
      viewerBackground: 'url(https://attacker.example/pixel)',
    } as unknown as Parameters<typeof hydrateFromSnapshot>[0];

    const hydrated = hydrateFromSnapshot(legacySnapshot);
    expect(hydrated.originalMesh).toBeNull();
    expect(hydrated.resultMesh).toBeNull();
    expect(hydrated.meshFileName).toBe('');
    expect(hydrated.logs).toEqual([]);
    expect(hydrated.params?.exportResolution).toBe(DEFAULT_PARAMS.exportResolution);
    expect(hydrated.generationSeed).toBe(0);
    expect(hydrated.viewerBackground).toBe('#000000');
  });
});

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

  it('bulk-paints imported faces, keeps masks exclusive, and supports erasing', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');
    useStore.getState().setSelectionMode('keep_out');
    useStore.getState().paintTriangles([1, 2, 3], true);
    expect(Array.from(useStore.getState().keepOutTris)).toEqual([1, 2, 3]);

    useStore.getState().setSelectionMode('keep_in');
    useStore.getState().paintTriangles([2, 4], true);
    expect(Array.from(useStore.getState().keepOutTris)).toEqual([1, 3]);
    expect(Array.from(useStore.getState().keepInTris)).toEqual([2, 4]);

    useStore.getState().paintTriangles([2], false);
    expect(Array.from(useStore.getState().keepInTris)).toEqual([4]);
    useStore.getState().undoSelection();
    expect(Array.from(useStore.getState().keepInTris)).toEqual([2, 4]);
  });

  it('undoes a multi-segment brush stroke as one action', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');
    useStore.getState().setSelectionMode('keep_in');
    useStore.getState().beginSelectionStroke();
    useStore.getState().paintTriangles([1, 2], true);
    useStore.getState().paintTriangles([2, 3, 4], true);
    useStore.getState().endSelectionStroke();

    expect(Array.from(useStore.getState().keepInTris)).toEqual([1, 2, 3, 4]);
    expect(useStore.getState().selectionUndo).toHaveLength(1);
    useStore.getState().undoSelection();
    expect(useStore.getState().keepInTris.size).toBe(0);
  });
});

describe('project restoration', () => {
  it('restores source geometry and masks while clearing derived results', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().restoreProject({
      params: { ...DEFAULT_PARAMS, latticeType: 'bcc' },
      generationSeed: 123,
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
    expect(state.generationSeed).toBe(123);
    expect(Array.from(state.keepOutTris)).toEqual([1, 2]);
    expect(Array.from(state.keepInTris)).toEqual([3]);
    expect(state.resultMesh).toBeNull();
    expect(state.validation).toBeNull();
    expect(state.selectionUndo).toEqual([]);
  });
});

describe('workspace transitions', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  it('opens a newly selected sample in a clean original-model view', () => {
    useStore.getState().setViewMode('xray');
    useStore.getState().setSelectionMode('keep_in');
    useStore.getState().setDemoModeActive(true);

    useStore.getState().setSampleShape('cylinder');

    const state = useStore.getState();
    expect(state.viewMode).toBe('original');
    expect(state.selectionMode).toBe('none');
    expect(state.demoModeActive).toBe(false);
    expect(state.resultMesh).toBeNull();
  });

  it('opens an imported mesh in a clean original-model view', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setViewMode('lattice');
    useStore.getState().setSelectionMode('keep_out');
    useStore.getState().setDemoModeActive(true);

    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');

    const state = useStore.getState();
    expect(state.viewMode).toBe('original');
    expect(state.selectionMode).toBe('none');
    expect(state.demoModeActive).toBe(false);
  });

  it('returns to the source model when multiview closes', () => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().startDemoRun();
    expect(useStore.getState().viewMode).toBe('lattice');

    useStore.getState().setDemoModeActive(false);

    expect(useStore.getState().viewMode).toBe('original');
  });

  it('parks a finished run while multiview is open and restores it on exit', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setSampleShape('sphere');
    useStore.getState().setResultMesh(mesh);
    const generated = useStore.getState().resultMesh;
    expect(generated).not.toBeNull();

    useStore.getState().startDemoRun();
    expect(useStore.getState().resultMesh).toBeNull();

    useStore.getState().setDemoModeActive(false);

    expect(useStore.getState().resultMesh).toBe(generated);
    expect(useStore.getState().demoSuspended).toBeNull();
  });

  it('does not resurrect a parked run that belonged to a previous model', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setSampleShape('sphere');
    useStore.getState().setResultMesh(mesh);
    useStore.getState().startDemoRun();

    // Switching model while multiview is open must invalidate the parked run.
    useStore.getState().setSampleShape('cube');
    useStore.getState().setDemoModeActive(false);

    expect(useStore.getState().resultMesh).toBeNull();
    expect(useStore.getState().demoSuspended).toBeNull();
  });

  it('lets a run that finishes during multiview outrank the parked one', () => {
    const parked = generateCubeMesh(10);
    const fresh = generateCubeMesh(20);
    useStore.getState().setSampleShape('sphere');
    useStore.getState().setResultMesh(parked);
    useStore.getState().startDemoRun();

    useStore.getState().setResultMesh(fresh);
    useStore.getState().setDemoModeActive(false);

    expect(useStore.getState().resultMesh?.triCount).toBe(fresh.triCount);
  });

  it('refuses a viewer mode the current state cannot show', () => {
    useStore.getState().setSampleShape('sphere');

    useStore.getState().setViewMode('xray');
    expect(useStore.getState().viewMode).toBe('original');

    useStore.getState().setResultMesh(generateCubeMesh(10));
    useStore.getState().setViewMode('xray');
    expect(useStore.getState().viewMode).toBe('xray');
  });

  it('clears a stale persisted camera when the viewport is reset', () => {
    const beforeSignal = useStore.getState().viewportResetSignal;
    useStore.getState().setViewerCameraState({
      position: [10, 10, 10],
      target: [0, 0, 0],
      up: [0, 0, 1],
      zoom: 1,
      savedAt: Date.now(),
    });

    useStore.getState().resetViewport();

    expect(useStore.getState().viewerCameraState).toBeNull();
    expect(useStore.getState().viewportResetSignal).toBe(beforeSignal + 1);
  });

  it('normalizes programmatic viewer background updates to local colors', () => {
    useStore.getState().setViewerBackground('url(https://attacker.example/pixel)');
    expect(useStore.getState().viewerBackground).toBe('#000000');

    useStore.getState().setViewerBackground('#A1b2C3');
    expect(useStore.getState().viewerBackground).toBe('#a1b2c3');
  });
});
