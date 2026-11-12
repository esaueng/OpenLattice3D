import { describe, expect, it } from 'vitest';
import { describeWorkAtRisk, workLostByReplacingModel, type ReplaceableWorkState } from './model-replacement';

const EMPTY = new Set<number>();

function state(overrides: Partial<ReplaceableWorkState> = {}): ReplaceableWorkState {
  return {
    originalMesh: null,
    sphereMode: true,
    resultMesh: null,
    pinnedRun: null,
    keepOutTris: EMPTY,
    keepInTris: EMPTY,
    demoModeActive: false,
    ...overrides,
  };
}

describe('workLostByReplacingModel', () => {
  it('lets a bare model be replaced without asking', () => {
    expect(workLostByReplacingModel(state())).toBeNull();
    expect(workLostByReplacingModel(state({ sphereMode: false, originalMesh: {} }))).toBeNull();
  });

  it('never asks when no model is loaded', () => {
    expect(workLostByReplacingModel(state({ sphereMode: false, resultMesh: {}, pinnedRun: {} }))).toBeNull();
  });

  it('flags a result, painted faces, a pinned run or the comparison grid', () => {
    expect(workLostByReplacingModel(state({ resultMesh: {} }))).toMatchObject({ result: true });
    expect(workLostByReplacingModel(state({ keepOutTris: new Set([1, 2]), keepInTris: new Set([3]) })))
      .toMatchObject({ paintedFaces: 3, result: false });
    expect(workLostByReplacingModel(state({ pinnedRun: {} }))).toMatchObject({ pinnedRun: true });
    expect(workLostByReplacingModel(state({ demoModeActive: true }))).toMatchObject({ comparison: true });
  });
});

describe('describeWorkAtRisk', () => {
  it('lists what would be lost in reading order', () => {
    expect(describeWorkAtRisk({ result: true, paintedFaces: 0, pinnedRun: false, comparison: false }))
      .toBe('the generated lattice');
    expect(describeWorkAtRisk({ result: true, paintedFaces: 1, pinnedRun: false, comparison: false }))
      .toBe('the generated lattice and 1 painted face');
    expect(describeWorkAtRisk({ result: true, paintedFaces: 1200, pinnedRun: true, comparison: false }))
      .toBe('the generated lattice, 1,200 painted faces and the pinned run');
  });
});
