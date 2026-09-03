import { describe, expect, it } from 'vitest';
import { boundedNumberInput, committableNumber, isCommittableNumber } from './numeric-input';

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

describe('isCommittableNumber', () => {
  it('accepts a finished value inside the range', () => {
    expect(isCommittableNumber('8.5', 2, 50)).toBe(true);
  });

  it('rejects a partial entry instead of clamping it', () => {
    // Typing "0.35" into a min=0.3 field passes through "0", which must not
    // become 0.3 -- that would rewrite the field under the cursor.
    expect(isCommittableNumber('0', 0.3, 5)).toBe(false);
    expect(isCommittableNumber('0.', 0.3, 5)).toBe(false);
    expect(isCommittableNumber('0.35', 0.3, 5)).toBe(true);
  });

  it('rejects an empty or out-of-range draft', () => {
    expect(isCommittableNumber('', 2, 50)).toBe(false);
    expect(isCommittableNumber('999', 2, 50)).toBe(false);
    expect(isCommittableNumber('not-a-number', 2, 50)).toBe(false);
  });
});

describe('committableNumber', () => {
  it('returns the number only when it is safe to commit', () => {
    expect(committableNumber('8.5', 2, 50)).toBeCloseTo(8.5);
    expect(committableNumber('0', 2, 50)).toBeNull();
    expect(committableNumber('', 2, 50)).toBeNull();
  });
});
