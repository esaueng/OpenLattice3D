import { describe, expect, it } from 'vitest';
import { CONFIRM_TIMEOUT_MS, confirmActionLabel, confirmHint, pressConfirm } from './confirm';

describe('shared confirm wording', () => {
  it('arms with one "Yes, …" label for every destructive action', () => {
    expect(confirmActionLabel('Start over')).toBe('Yes, start over');
    expect(confirmActionLabel('Replace model')).toBe('Yes, replace model');
  });

  it('explains how to confirm, with or without a timeout', () => {
    expect(confirmHint('Start over')).toBe(
      `Click “Yes, start over” to confirm. It cancels by itself after ${CONFIRM_TIMEOUT_MS / 1000} seconds.`,
    );
    expect(confirmHint('Replace model', null)).toBe('Choose “Yes, replace model” to continue.');
  });

  it('needs two presses to act', () => {
    const first = pressConfirm(false);
    expect(first).toEqual({ armed: true, confirmed: false });
    expect(pressConfirm(first.armed)).toEqual({ armed: false, confirmed: true });
  });
});
