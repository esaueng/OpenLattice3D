import { describe, expect, it } from 'vitest';
import { boundedNumberInput } from './numeric-input';

describe('boundedNumberInput', () => {
  it('keeps finite values inside the declared range', () => {
    expect(boundedNumberInput('8.5', 8, 2, 50)).toBeCloseTo(8.5);
  });

  it('clamps values to the declared range', () => {
    expect(boundedNumberInput('-2', 8, 2, 50)).toBe(2);
    expect(boundedNumberInput('1000', 8, 2, 50)).toBe(50);
  });

  it('uses the current fallback for empty or non-numeric edits', () => {
    expect(boundedNumberInput('', 8, 2, 50)).toBe(8);
    expect(boundedNumberInput('not-a-number', 1.5, 0.3, 10)).toBeCloseTo(1.5);
  });
});
