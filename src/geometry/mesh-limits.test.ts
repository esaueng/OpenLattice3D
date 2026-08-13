import { describe, expect, it } from 'vitest';
import {
  MAX_SURFACE_SAMPLE_COUNT,
  addMeshTriangleArea,
  surfaceSampleCount,
  validateMeshPositions,
} from './mesh-limits';

describe('mesh resource limits', () => {
  it('rejects non-finite and excessively large coordinates', () => {
    expect(() => validateMeshPositions([0, Number.NaN, 1])).toThrow(/coordinate/);
    expect(() => validateMeshPositions([0, 1e20, 1])).toThrow(/coordinate/);
  });

  it('rejects non-finite and excessively large accumulated areas', () => {
    expect(() => addMeshTriangleArea(0, Number.POSITIVE_INFINITY)).toThrow(/surface area/);
    expect(() => addMeshTriangleArea(1_000_000_000_000, 1)).toThrow(/surface area/);
  });

  it('caps surface samples independently of mesh area', () => {
    expect(surfaceSampleCount(1_000_000_000_000, 0.01)).toBe(MAX_SURFACE_SAMPLE_COUNT);
    expect(surfaceSampleCount(55, 1)).toBe(100);
  });
});
