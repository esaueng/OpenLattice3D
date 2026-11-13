import { describe, expect, it } from 'vitest';
import {
  buildPlateGridLines,
  buildPlateGridSpec,
  formatGridSpacing,
  minorStepFor,
  niceStepAtOrBelow,
  type GridBounds,
} from './build-plate-grid';

function cube(size: number, center: [number, number, number] = [0, 0, 0]): GridBounds {
  const h = size / 2;
  return {
    min: [center[0] - h, center[1] - h, center[2] - h],
    max: [center[0] + h, center[1] + h, center[2] + h],
  };
}

describe('niceStepAtOrBelow', () => {
  it.each([
    [16, 10], [10, 10], [9.6, 5], [6.4, 5], [4.9, 2], [2, 2], [1.99, 1], [0.384, 0.2], [0.3, 0.2], [150, 100],
  ])('rounds %f down to the 1-2-5 step %f', (value, expected) => {
    expect(niceStepAtOrBelow(value)).toBeCloseTo(expected, 12);
  });

  it('falls back to 1 mm for unusable input', () => {
    expect(niceStepAtOrBelow(0)).toBe(1);
    expect(niceStepAtOrBelow(-3)).toBe(1);
    expect(niceStepAtOrBelow(Number.NaN)).toBe(1);
  });
});

describe('minorStepFor', () => {
  it.each([[10, 2], [20, 5], [50, 10], [1, 0.2], [0.2, 0.05], [5, 1], [100, 20]])(
    'subdivides a %f mm major into %f mm',
    (major, minor) => {
      expect(minorStepFor(major)).toBeCloseTo(minor, 12);
      expect(Math.abs(major / minorStepFor(major) - Math.round(major / minorStepFor(major)))).toBeLessThan(1e-9);
    },
  );
});

describe('buildPlateGridSpec', () => {
  it('uses 10 mm squares with 2 mm subdivisions under the 50 mm sample sphere', () => {
    const spec = buildPlateGridSpec(cube(50))!;
    expect(spec.major).toBe(10);
    expect(spec.minor).toBe(2);
    expect(spec.center).toEqual([0, 0]);
    expect(spec.halfExtent).toBe(40);
  });

  it('tells a 1.2 mm cube and a 20 mm cube apart', () => {
    const small = buildPlateGridSpec(cube(1.2))!;
    const large = buildPlateGridSpec(cube(20))!;
    expect(small.major).toBeCloseTo(0.2, 12);
    expect(small.minor).toBeCloseTo(0.05, 12);
    expect(large.major).toBe(5);
    expect(large.minor).toBe(1);
  });

  it('sits just below the lowest point, close enough not to float', () => {
    const spec = buildPlateGridSpec(cube(30, [0, 0, 15]))!;
    expect(spec.z).toBeLessThan(0);
    expect(spec.z).toBeGreaterThan(-0.2);
  });

  it('covers an off-centre footprint from a centre snapped to the major spacing', () => {
    const bounds: GridBounds = { min: [103, -7, 2], max: [181, 9, 20] };
    const spec = buildPlateGridSpec(bounds)!;
    expect(spec.center[0] / spec.major).toBeCloseTo(Math.round(spec.center[0] / spec.major), 9);
    expect(spec.center[0] - spec.halfExtent).toBeLessThanOrEqual(bounds.min[0]);
    expect(spec.center[0] + spec.halfExtent).toBeGreaterThanOrEqual(bounds.max[0]);
    expect(spec.center[1] - spec.halfExtent).toBeLessThanOrEqual(bounds.min[1]);
    expect(spec.center[1] + spec.halfExtent).toBeGreaterThanOrEqual(bounds.max[1]);
    expect(spec.halfExtent / spec.major).toBeCloseTo(Math.round(spec.halfExtent / spec.major), 9);
  });

  it('still gives a tall, thin part a readable grid', () => {
    const spec = buildPlateGridSpec({ min: [-1, -1, 0], max: [1, 1, 100] })!;
    expect(spec.major).toBeGreaterThanOrEqual(10);
  });

  it('returns null for non-finite bounds', () => {
    expect(buildPlateGridSpec({ min: [Infinity, 0, 0], max: [-Infinity, 0, 0] })).toBeNull();
  });
});

describe('buildPlateGridLines', () => {
  it('emits major lines on every major step and minor lines between them, without overlap', () => {
    const spec = buildPlateGridSpec(cube(50))!;
    const { major, minor } = buildPlateGridLines(spec);
    // 80 mm square: 9 major and 32 minor lines in each direction, two endpoints each.
    expect(major.length).toBe(9 * 2 * 2 * 3);
    expect(minor.length).toBe(32 * 2 * 2 * 3);
    for (let i = 2; i < major.length; i += 3) expect(major[i]).toBeCloseTo(spec.z, 6);
    // First major line runs along Y at x = -40.
    expect(Array.from(major.slice(0, 6))).toEqual([-40, -40, spec.z, -40, 40, spec.z].map(Math.fround));
  });

  it('drops subdivisions when they would need an unbounded number of lines', () => {
    const { minor } = buildPlateGridLines({ major: 10, minor: 0.001, center: [0, 0], halfExtent: 40, z: 0 });
    expect(minor.length).toBe(0);
  });
});

describe('formatGridSpacing', () => {
  it('prints millimetres without float noise or trailing zeros', () => {
    expect(formatGridSpacing(10)).toBe('10 mm');
    expect(formatGridSpacing(0.2)).toBe('0.2 mm');
    expect(formatGridSpacing(0.1 + 0.2)).toBe('0.3 mm');
    expect(formatGridSpacing(0.05)).toBe('0.05 mm');
  });
});
