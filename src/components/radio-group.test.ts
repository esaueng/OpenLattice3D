import { describe, expect, it } from 'vitest';
import { radioGroupKeyAction, radioGroupTabStop } from './radio-group';

const FOUR = [false, false, false, false];

describe('radioGroupKeyAction', () => {
  it('moves forward and back with the arrow keys, wrapping at the ends', () => {
    expect(radioGroupKeyAction('ArrowRight', 0, FOUR)).toEqual({ index: 1, select: true });
    expect(radioGroupKeyAction('ArrowDown', 3, FOUR)).toEqual({ index: 0, select: true });
    expect(radioGroupKeyAction('ArrowLeft', 0, FOUR)).toEqual({ index: 3, select: true });
    expect(radioGroupKeyAction('ArrowUp', 2, FOUR)).toEqual({ index: 1, select: true });
  });

  it('jumps to the first and last options with Home and End', () => {
    expect(radioGroupKeyAction('Home', 2, FOUR)).toEqual({ index: 0, select: true });
    expect(radioGroupKeyAction('End', 1, FOUR)).toEqual({ index: 3, select: true });
  });

  it('selects the focused option with Space', () => {
    expect(radioGroupKeyAction(' ', 2, FOUR)).toEqual({ index: 2, select: true });
  });

  it('skips disabled options', () => {
    const disabled = [true, false, true, false];
    expect(radioGroupKeyAction('ArrowRight', 1, disabled)).toEqual({ index: 3, select: true });
    expect(radioGroupKeyAction('ArrowRight', 3, disabled)).toEqual({ index: 1, select: true });
    expect(radioGroupKeyAction('Home', 3, disabled)).toEqual({ index: 1, select: true });
    expect(radioGroupKeyAction('End', 1, [false, false, true])).toEqual({ index: 1, select: true });
    expect(radioGroupKeyAction(' ', 0, disabled)).toBeNull();
  });

  it('ignores other keys, empty groups and fully disabled groups', () => {
    expect(radioGroupKeyAction('Tab', 0, FOUR)).toBeNull();
    expect(radioGroupKeyAction('Enter', 0, FOUR)).toBeNull();
    expect(radioGroupKeyAction('a', 0, FOUR)).toBeNull();
    expect(radioGroupKeyAction('ArrowRight', 0, [])).toBeNull();
    expect(radioGroupKeyAction('ArrowRight', 0, [true, true])).toBeNull();
  });
});

describe('radioGroupTabStop', () => {
  it('puts the single tab stop on the checked option, else the first enabled one', () => {
    expect(radioGroupTabStop(2, FOUR)).toBe(2);
    expect(radioGroupTabStop(-1, FOUR)).toBe(0);
    expect(radioGroupTabStop(0, [true, false])).toBe(1);
    expect(radioGroupTabStop(0, [true, true])).toBe(-1);
  });
});
