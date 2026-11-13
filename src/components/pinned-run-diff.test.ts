import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, type LatticeParams } from '../types/project';
import type { GenerationSnapshot } from '../store/generation-snapshot';
import { diffSnapshotParams } from './pinned-run-diff';

function snapshot(params: Partial<LatticeParams> = {}): GenerationSnapshot {
  return {
    signature: 'x',
    params: { ...DEFAULT_PARAMS, ...params },
    generationSeed: 1,
    sourceKey: 'sphere',
    keepOutCount: 0,
    keepInCount: 0,
  };
}

describe('diffSnapshotParams', () => {
  it('treats equal array params in new arrays as unchanged', () => {
    const a = snapshot({ latticeRotationDeg: [0, 0, 45], cellScale: [1, 1, 2] });
    const b = snapshot({ latticeRotationDeg: [0, 0, 45], cellScale: [1, 1, 2] });
    expect(diffSnapshotParams(a, b)).toEqual([]);
  });

  it('lists orientation, stretch and grading changes with readable values', () => {
    const a = snapshot();
    const b = snapshot({ latticeRotationDeg: [0, 0, 45], cellScale: [1, 1, 2], gradientEnabled: true });
    expect(diffSnapshotParams(a, b)).toEqual([
      'stretch (1, 1, 1) → (1, 1, 2)',
      'rotation (0, 0, 0) → (0, 0, 45)',
      'graded density false → true',
    ]);
  });

  it('returns nothing without both snapshots', () => {
    expect(diffSnapshotParams(null, snapshot())).toEqual([]);
  });
});
