import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, sanitizeLatticeParams } from './project';

describe('sanitizeLatticeParams', () => {
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
