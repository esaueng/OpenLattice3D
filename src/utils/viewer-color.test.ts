import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEWER_BACKGROUND,
  normalizeViewerBackground,
  parseViewerBackground,
} from './viewer-color';

describe('viewer background colors', () => {
  it('accepts six-digit colors and normalizes their case', () => {
    expect(parseViewerBackground('#A1b2C3')).toBe('#a1b2c3');
  });

  it.each([
    'url(https://attacker.example/pixel)',
    'linear-gradient(red, blue)',
    '#fff',
    '#12345678',
    '',
    null,
  ])('rejects non-color CSS value %j', (value) => {
    expect(parseViewerBackground(value)).toBeUndefined();
    expect(normalizeViewerBackground(value)).toBe(DEFAULT_VIEWER_BACKGROUND);
  });
});
