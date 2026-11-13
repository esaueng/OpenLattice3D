import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, sanitizeLatticeParams } from './project';

describe('sanitizeLatticeParams', () => {
  it('keeps escape holes disabled by default', () => {
    expect(DEFAULT_PARAMS.escapeHoles).toBe(false);
  });

  it('accepts a full valid parameter set', () => {
    const { params, accepted, rejected } = sanitizeLatticeParams(DEFAULT_PARAMS);
    expect(rejected).toEqual([]);
    expect(accepted.length).toBe(Object.keys(DEFAULT_PARAMS).length);
    expect(params).toEqual(DEFAULT_PARAMS);
  });

  it('rejects wrong types and out-of-range numbers', () => {
    const { params, accepted, rejected } = sanitizeLatticeParams({
      cellSize: 'abc',
      wallThickness: NaN,
      strutDiameter: -5,
      shellThickness: Infinity,
      gradientStrength: 2,
      noShell: 'yes',
      latticeType: 'cube-of-doom',
      toleranceMm: 0.2,
    });
    expect(accepted).toEqual(['toleranceMm']);
    expect(params).toEqual({ toleranceMm: 0.2 });
    expect(rejected).toContain('cellSize');
    expect(rejected).toContain('wallThickness');
    expect(rejected).toContain('strutDiameter');
    expect(rejected).toContain('shellThickness');
    expect(rejected).toContain('gradientStrength');
    expect(rejected).toContain('noShell');
    expect(rejected).toContain('latticeType');
  });

  it('ignores unknown keys entirely', () => {
    const { params, accepted, rejected } = sanitizeLatticeParams({
      cellSize: 8,
      __proto__injection: true,
      somethingElse: 'x',
    });
    expect(accepted).toEqual(['cellSize']);
    expect(rejected).toEqual([]);
    expect(Object.keys(params)).toEqual(['cellSize']);
  });

  it('validates enums', () => {
    expect(sanitizeLatticeParams({ latticeType: 'gyroid' }).accepted).toEqual(['latticeType']);
    expect(sanitizeLatticeParams({ variant: 'shell_core' }).accepted).toEqual(['variant']);
    expect(sanitizeLatticeParams({ processPreset: 'NOPE' }).rejected).toEqual(['processPreset']);
  });

  it('handles non-object input', () => {
    expect(sanitizeLatticeParams(null).accepted).toEqual([]);
    expect(sanitizeLatticeParams('[]').accepted).toEqual([]);
    expect(sanitizeLatticeParams(42).accepted).toEqual([]);
  });
});

describe('manual escape hole sanitization', () => {
  it('accepts xyz triples and rejects malformed lists', async () => {
    const { sanitizeLatticeParams } = await import('./project');
    const good = sanitizeLatticeParams({ escapeHolePlacement: 'manual', escapeHoleManualCenters: [1, 2, 3] });
    expect(good.accepted).toEqual(['escapeHolePlacement', 'escapeHoleManualCenters']);
    const bad = sanitizeLatticeParams({ escapeHolePlacement: 'random', escapeHoleManualCenters: [1, 2] });
    expect(bad.rejected).toEqual(['escapeHolePlacement', 'escapeHoleManualCenters']);
    const nan = sanitizeLatticeParams({ escapeHoleManualCenters: [1, 2, Number.NaN] });
    expect(nan.rejected).toEqual(['escapeHoleManualCenters']);
  });
});

describe('lattice orientation sanitization', () => {
  it('defaults to the identity orientation', () => {
    expect(DEFAULT_PARAMS.latticeRotationDeg).toEqual([0, 0, 0]);
    expect(DEFAULT_PARAMS.cellScale).toEqual([1, 1, 1]);
  });

  it('accepts in-range xyz triples and copies them', () => {
    const rotation = [-180, 45.5, 180];
    const scale = [0.25, 1, 4];
    const { params, rejected } = sanitizeLatticeParams({ latticeRotationDeg: rotation, cellScale: scale });
    expect(rejected).toEqual([]);
    expect(params.latticeRotationDeg).toEqual(rotation);
    expect(params.cellScale).toEqual(scale);
    expect(params.latticeRotationDeg).not.toBe(rotation);
    expect(params.cellScale).not.toBe(scale);
  });

  it.each([
    ['an angle beyond 180°', { latticeRotationDeg: [0, 181, 0] }],
    ['a non-finite angle', { latticeRotationDeg: [0, Number.NaN, 0] }],
    ['a string angle', { latticeRotationDeg: ['0', 0, 0] }],
    ['two angles', { latticeRotationDeg: [0, 0] }],
    ['a scalar rotation', { latticeRotationDeg: 45 }],
    ['a stretch below 0.25', { cellScale: [1, 0.2, 1] }],
    ['a stretch above 4', { cellScale: [1, 1, 4.5] }],
    ['a zero stretch', { cellScale: [0, 1, 1] }],
    ['four stretch entries', { cellScale: [1, 1, 1, 1] }],
    ['a null stretch', { cellScale: null }],
  ])('rejects %s', (_label, input) => {
    const { params, accepted, rejected } = sanitizeLatticeParams(input);
    expect(accepted).toEqual([]);
    expect(params).toEqual({});
    expect(rejected).toEqual(Object.keys(input));
  });

  it('leaves older parameter sets without orientation fields valid', () => {
    const legacy: Record<string, unknown> = { ...DEFAULT_PARAMS };
    delete legacy.latticeRotationDeg;
    delete legacy.cellScale;
    const { params, rejected } = sanitizeLatticeParams(legacy);
    expect(rejected).toEqual([]);
    expect({ ...DEFAULT_PARAMS, ...params }).toEqual(DEFAULT_PARAMS);
  });
});
