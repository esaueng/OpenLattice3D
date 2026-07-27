import { describe, expect, it } from 'vitest';
import { buildLatticeEvaluator } from './lattice';
import { marchingCubes } from './marching-cubes';
import { checkMinThickness } from './validation';
import { DEFAULT_PARAMS, type LatticeType } from '../types/project';

const SHEET_TYPES: LatticeType[] = [
  'gyroid',
  'schwarzP',
  'schwarzD',
  'neovius',
  'iwp',
  'spinodal',
];
const CALIBRATION_CASES = SHEET_TYPES.flatMap((latticeType) => (
  [6, 8, 12].map((cellSize) => ({ latticeType, cellSize }))
));

describe('TPMS thickness calibration', () => {
  it.each(CALIBRATION_CASES)(
    '$latticeType at $cellSize mm cells produces the requested wall thickness',
    ({ latticeType, cellSize }) => {
    const wallThickness = 1;
    const sdf = buildLatticeEvaluator({
      ...DEFAULT_PARAMS,
      latticeType,
      cellSize,
      wallThickness,
    });
    const result = marchingCubes(
      sdf,
      { min: [0, 0, 0], max: [cellSize, cellSize, cellSize] },
      48,
    );
    const measured = checkMinThickness(sdf, result, 0.8, 500);
    expect(measured.sampled).toBeGreaterThan(10);
    expect(measured.minMeasured).toBeGreaterThan(0.85);
    expect(measured.minMeasured).toBeLessThan(1.15);
    },
  );
});
