import { describe, expect, it } from 'vitest';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS } from '../types/project';
import {
  buildGenerationSnapshot,
  describeSnapshotChanges,
  isSnapshotStale,
  type GenerationInputs,
} from './generation-snapshot';

function inputs(overrides: Partial<GenerationInputs> = {}): GenerationInputs {
  return {
    params: { ...DEFAULT_PARAMS },
    generationSeed: 7,
    originalMesh: null,
    meshFileName: 'Sphere R=25mm',
    sampleShape: 'sphere',
    sphereMode: true,
    sphereRadius: 25,
    keepOutTris: new Set(),
    keepInTris: new Set(),
    ...overrides,
  };
}

describe('generation snapshot', () => {
  it('is stable across mask insertion order and unrelated statistics inputs', () => {
    const a = buildGenerationSnapshot(inputs({ keepOutTris: new Set([3, 1, 2]) }));
    const b = buildGenerationSnapshot(inputs({
      keepOutTris: new Set([1, 2, 3]),
      params: { ...DEFAULT_PARAMS, materialDensityGPerCm3: 1.04 },
    }));
    expect(a.signature).toBe(b.signature);
    expect(isSnapshotStale(a, inputs({ keepOutTris: new Set([2, 3, 1]) }))).toBe(false);
  });

  it('goes stale when any generation input changes', () => {
    const snapshot = buildGenerationSnapshot(inputs());
    expect(isSnapshotStale(snapshot, inputs({ params: { ...DEFAULT_PARAMS, cellSize: 12 } }))).toBe(true);
    expect(isSnapshotStale(snapshot, inputs({ generationSeed: 8 }))).toBe(true);
    expect(isSnapshotStale(snapshot, inputs({ keepInTris: new Set([4]) }))).toBe(true);
    expect(isSnapshotStale(snapshot, inputs({ sampleShape: 'cube' }))).toBe(true);
    const mesh = generateCubeMesh(10);
    expect(isSnapshotStale(snapshot, inputs({
      originalMesh: mesh, sampleShape: null, sphereMode: false, meshFileName: 'cube.stl',
    }))).toBe(true);
  });

  it('never reports stale without a snapshot', () => {
    expect(isSnapshotStale(null, inputs({ generationSeed: 99 }))).toBe(false);
  });

  it('names what changed in form order', () => {
    const snapshot = buildGenerationSnapshot(inputs({ keepOutTris: new Set([1]) }));
    const changes = describeSnapshotChanges(snapshot, inputs({
      params: { ...DEFAULT_PARAMS, cellSize: 10, escapeHoles: true, materialDensityGPerCm3: 2 },
      generationSeed: 8,
      keepOutTris: new Set([1, 2]),
      sampleShape: 'torus',
    }));
    expect(changes).toEqual(['model', 'cell size', 'escape holes', 'seed', 'painted faces']);
  });

  it('reports repainted faces even when the counts match', () => {
    const snapshot = buildGenerationSnapshot(inputs({ keepOutTris: new Set([1]) }));
    expect(describeSnapshotChanges(snapshot, inputs({ keepOutTris: new Set([2]) }))).toEqual(['painted faces']);
  });
});
