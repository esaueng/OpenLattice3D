import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS } from '../../types/project';
import { resultHasClosedSkin } from './viewer-hints';

describe('resultHasClosedSkin', () => {
  it('is true for the default shelled result', () => {
    expect(resultHasClosedSkin(DEFAULT_PARAMS)).toBe(true);
  });

  it('is false when the lattice is exposed or there is no run', () => {
    expect(resultHasClosedSkin({ ...DEFAULT_PARAMS, noShell: true })).toBe(false);
    expect(resultHasClosedSkin({ ...DEFAULT_PARAMS, surfaceOnly: true })).toBe(false);
    expect(resultHasClosedSkin({ ...DEFAULT_PARAMS, shellThickness: 0 })).toBe(false);
    expect(resultHasClosedSkin(null)).toBe(false);
  });
});
