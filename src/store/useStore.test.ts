import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS, type ValidationResult } from '../types/project';
import { buildPersistedAppState, hydrateFromSnapshot, useStore } from './useStore';
import { buildGenerationSnapshot } from './generation-snapshot';
import { computeStaleness, selectGenerationInputs } from './useResultStaleness';

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

  it('never restores a result-only view mode, which would show an empty canvas', () => {
    const hydrated = hydrateFromSnapshot({
      version: 3,
      savedAt: Date.now(),
      params: { ...DEFAULT_PARAMS },
      sampleShape: 'sphere',
      sphereMode: true,
      viewMode: 'xray',
    } as unknown as Parameters<typeof hydrateFromSnapshot>[0]);
    expect(hydrated.resultMesh).toBeNull();
    expect(hydrated.viewMode).toBe('original');
  });
});

describe('result record', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  function generateSphere() {
    const store = useStore.getState();
    store.setSampleShape('sphere');
    const snapshot = buildGenerationSnapshot(selectGenerationInputs(useStore.getState()));
    useStore.getState().setResultMesh(generateCubeMesh(10), snapshot);
    useStore.getState().setValidation({
      passed: true,
      outerDeviation: { passed: true, maxDeviation: 0, tolerance: 0.2 },
      minThickness: { passed: true, minMeasured: 1, required: 0.8, absoluteMin: 1, sampled: 10 },
      manifold: { passed: true, details: 'ok' },
      disconnected: { passed: true, fragmentCount: 1 },
      warnings: [],
    });
  }

  function staleness() {
    const state = useStore.getState();
    return computeStaleness(state.resultSnapshot, selectGenerationInputs(state));
  }

  it('matches the form right after generation and goes out of date on any edit', () => {
    generateSphere();
    expect(staleness()).toEqual({ stale: false, changes: [] });

    useStore.getState().updateParams({ cellSize: 12 });
    expect(staleness()).toEqual({ stale: true, changes: ['cell size'] });

    useStore.getState().updateParams({ cellSize: 8 });
    expect(staleness().stale).toBe(false);
  });

  it('keeps the previous result and verdict when the seed or parameters change', () => {
    generateSphere();
    useStore.getState().reseedGeneration();
    expect(useStore.getState().resultMesh).not.toBeNull();
    expect(useStore.getState().validation).not.toBeNull();
    expect(staleness().changes).toEqual(['seed']);

    useStore.getState().importParams({ wallThickness: 2 });
    expect(useStore.getState().resultMesh).not.toBeNull();
    expect(staleness().changes).toEqual(['wall thickness', 'seed']);
  });

  it('starts a new result without a verdict and legalises the view when cleared', () => {
    generateSphere();
    useStore.getState().setViewMode('xray');
    useStore.getState().setResultMesh(generateCubeMesh(12), null);
    expect(useStore.getState().validation).toBeNull();
    expect(useStore.getState().viewMode).toBe('xray');

    useStore.getState().setResultMesh(null);
    expect(useStore.getState().resultSnapshot).toBeNull();
    expect(useStore.getState().viewMode).toBe('original');
  });

  it('carries the record through a multiview round trip', () => {
    generateSphere();
    const snapshot = useStore.getState().resultSnapshot;
    useStore.getState().startDemoRun();
    expect(useStore.getState().resultSnapshot).toBeNull();
    useStore.getState().setDemoModeActive(false);
    expect(useStore.getState().resultSnapshot).toBe(snapshot);
    expect(useStore.getState().validation).not.toBeNull();
  });

  it('mirrors the multiview queue and resets it on exit', () => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().startDemoRun();
    useStore.getState().setDemoQueue({ done: 3, running: 1, total: 12 });
    expect(useStore.getState().demoQueue).toEqual({ done: 3, running: 1, total: 12 });
    useStore.getState().setDemoModeActive(false);
    expect(useStore.getState().demoQueue).toEqual({ done: 0, running: 0, total: 0 });
  });
});

describe('painting defaults and erase mode', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  it('sizes the brush to the part on import unless the user already chose one', () => {
    const mesh = generateCubeMesh(30);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');
    expect(useStore.getState().brushRadius).toBe(2.1);

    useStore.getState().setBrushRadius(5);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube-again.stl');
    expect(useStore.getState().brushRadius).toBe(5);
  });

  it('erases from both masks as one undoable action', () => {
    const mesh = generateCubeMesh(10);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'cube.stl');
    useStore.getState().setSelectionMode('keep_out');
    useStore.getState().paintTriangles([1, 2], true);
    useStore.getState().setSelectionMode('keep_in');
    useStore.getState().paintTriangles([3], true);

    useStore.getState().setSelectionMode('erase');
    useStore.getState().paintTriangles([2, 3, 9], true);
    expect(Array.from(useStore.getState().keepOutTris)).toEqual([1]);
    expect(useStore.getState().keepInTris.size).toBe(0);

    useStore.getState().paintTriangles([7], true);
    expect(useStore.getState().selectionUndo).toHaveLength(3);
    useStore.getState().undoSelection();
    expect(Array.from(useStore.getState().keepOutTris)).toEqual([1, 2]);
    expect(Array.from(useStore.getState().keepInTris)).toEqual([3]);
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
    expect(useStore.getState().viewMode).toBe('cross_section');

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

describe('completed result staleness', () => {
  const mesh = generateCubeMesh(10);
  const validation: ValidationResult = {
    passed: true,
    outerDeviation: { passed: true, maxDeviation: 0, tolerance: 0.2 },
    minThickness: { passed: true, minMeasured: 1, required: 0.8, absoluteMin: 1, sampled: 10 },
    manifold: { passed: true, details: 'Mesh is manifold and watertight' },
    disconnected: { passed: true, fragmentCount: 1 },
    warnings: [],
  };

  function staleness() {
    const state = useStore.getState();
    return computeStaleness(state.resultSnapshot, selectGenerationInputs(state));
  }

  beforeEach(() => {
    useStore.getState().resetProject();
    useStore.getState().setSampleShape('cube');
    useStore.getState().setResultMesh(mesh, buildGenerationSnapshot(selectGenerationInputs(useStore.getState())));
    useStore.getState().setValidation(validation);
    useStore.getState().setViewMode('xray');
  });

  const edits = [
    ['cell size', () => useStore.getState().updateParams({ cellSize: 12 }), 'cell size'],
    ['validation tolerance', () => useStore.getState().updateParams({ toleranceMm: 0.4 }), 'tolerance'],
    ['lattice type', () => useStore.getState().setLatticeType('bcc'), 'lattice type'],
    ['process preset', () => useStore.getState().setProcessPreset('SLA_DLP'), 'process preset'],
    ['variant', () => useStore.getState().setVariant('implicit_conformal'), 'generation variant'],
    ['seed', () => useStore.getState().reseedGeneration(), 'seed'],
    ['face constraints', () => useStore.getState().toggleKeepIn(1), 'painted faces'],
  ] as const;

  it.each(edits)('keeps completed geometry and its verdict, marked out of date, on %s changes', (_name, edit, change) => {
    expect(staleness().stale).toBe(false);
    edit();
    const state = useStore.getState();
    expect(state.resultMesh).toBe(mesh);
    expect(state.validation).toBe(validation);
    expect(state.viewMode).toBe('xray');
    expect(staleness().stale).toBe(true);
    expect(staleness().changes).toContain(change);
  });

  it.each(edits)('restores a parked multiview result as out of date after %s changes', (_name, edit) => {
    useStore.getState().startDemoRun();
    edit();
    useStore.getState().setDemoModeActive(false);
    expect(useStore.getState().resultMesh).toBe(mesh);
    expect(useStore.getState().validation).toBe(validation);
    expect(useStore.getState().demoSuspended).toBeNull();
    expect(staleness().stale).toBe(true);
  });

  it('stays current for unchanged inputs and display-only edits', () => {
    useStore.getState().updateParams({ cellSize: 8, materialDensityGPerCm3: 1.2 });
    useStore.getState().setLatticeType('gyroid');
    useStore.getState().setViewerBackground('#112233');
    useStore.getState().setClipPlane({ axis: 'x' });
    expect(useStore.getState().resultMesh).toBe(mesh);
    expect(useStore.getState().validation).toBe(validation);
    expect(staleness().stale).toBe(false);
  });

  it('drops a completed result only when the model itself changes', () => {
    useStore.getState().setSampleShape('torus');
    expect(useStore.getState().resultMesh).toBeNull();
    expect(useStore.getState().resultSnapshot).toBeNull();
    expect(useStore.getState().viewMode).toBe('original');
  });
});

describe('parameter continuity across model and type changes', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  it('keeps the user parameters when a sample part is chosen', () => {
    useStore.getState().updateParams({ cellSize: 6, wallThickness: 1.4, exportResolution: 5 });
    useStore.getState().setSampleShape('torus');
    expect(useStore.getState().params.cellSize).toBe(6);
    expect(useStore.getState().params.wallThickness).toBe(1.4);
    expect(useStore.getState().params.exportResolution).toBe(5);
  });

  it('restores the overwritten values when leaving a polygon surface type', () => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().updateParams({ cellSize: 9, exportResolution: 3, minFeatureSize: 0.8 });

    useStore.getState().setLatticeType('hexagon');
    let p = useStore.getState().params;
    expect([p.cellSize, p.exportResolution, p.minFeatureSize, p.surfaceOnly, p.variant]).toEqual([4, 5, 2, true, 'implicit_conformal']);

    useStore.getState().setLatticeType('gyroid');
    p = useStore.getState().params;
    expect([p.cellSize, p.exportResolution, p.minFeatureSize, p.surfaceOnly, p.noShell, p.variant]).toEqual([9, 3, 0.8, false, false, 'shell_core']);
    expect(useStore.getState().polygonOverrideBackup).toBeNull();
  });

  it('does not clobber a value the user changed while the polygon type was active', () => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().updateParams({ cellSize: 9 });
    useStore.getState().setLatticeType('triangle');
    useStore.getState().updateParams({ cellSize: 3 });
    useStore.getState().setLatticeType('hexagon');
    useStore.getState().setLatticeType('bcc');
    expect(useStore.getState().params.cellSize).toBe(3);
    expect(useStore.getState().params.surfaceOnly).toBe(false);
  });

  it('applies a multiview edit to every tile', () => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().startDemoRun();
    useStore.getState().updateParams({ cellSize: 11 });
    const byType = useStore.getState().demoParamsByType;
    expect(byType.gyroid?.cellSize).toBe(11);
    expect(byType.bcc?.cellSize).toBe(11);
    expect(byType.hexagon?.cellSize).toBe(11);
    expect(byType.hexagon?.surfaceOnly).toBe(true);
    expect(byType.hexagon?.latticeType).toBe('hexagon');
  });
});

describe('imported mesh fixes', () => {
  beforeEach(() => {
    useStore.getState().resetProject();
  });

  it('rescales an imported mesh in place and keeps painted faces', () => {
    const mesh = generateCubeMesh(1);
    useStore.getState().setOriginalMesh(mesh, analyzeMesh(mesh), 'inch.stl');
    useStore.getState().toggleKeepOut(2);
    useStore.getState().setResultMesh(mesh);
    useStore.getState().scaleOriginalMesh(25.4);
    const state = useStore.getState();
    expect(state.meshInfo?.boundingBox.max[0]).toBeCloseTo(12.7, 5);
    expect(state.meshInfo?.volumeMm3).toBeCloseTo(25.4 ** 3, 1);
    expect(state.keepOutTris.has(2)).toBe(true);
    expect(state.resultMesh).toBeNull();
    expect(state.viewMode).toBe('original');
  });

  it('closes boundary loops and reports the edge counts', () => {
    const cube = generateCubeMesh(30);
    const open = {
      positions: cube.positions.slice(0, 10 * 9),
      normals: cube.normals.slice(0, 10 * 3),
      triCount: 10,
    };
    useStore.getState().setOriginalMesh(open, analyzeMesh(open), 'open.stl');
    expect(useStore.getState().closeMeshHoles()).toEqual({ before: 4, after: 0 });
    const state = useStore.getState();
    expect(state.meshInfo?.isWatertight).toBe(true);
    expect(state.meshInfo?.repaired).toBe(true);
    expect(state.originalMesh?.triCount).toBeGreaterThan(10);
    expect(useStore.getState().closeMeshHoles()).toBeNull();
  });
});
