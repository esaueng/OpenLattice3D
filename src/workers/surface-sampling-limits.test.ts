import { describe, expect, it } from 'vitest';
import {
  MAX_SURFACE_SAMPLES,
  surfaceSampleTargetCount,
} from './surface-sampling-limits';

describe('surface sampling limits', () => {
  it('keeps ordinary mesh sampling requests intact', () => {
    expect(surfaceSampleTargetCount(8_800, 4)).toBe(1_000);
  });

  it('rejects non-finite and oversized area-derived requests', () => {
    expect(() => surfaceSampleTargetCount(Infinity, 4)).toThrow(/non-finite area/);
    expect(() => surfaceSampleTargetCount(Number.MAX_VALUE, 0.1)).toThrow(
      new RegExp(`more than ${MAX_SURFACE_SAMPLES.toLocaleString()}`),
    );
  });
});
