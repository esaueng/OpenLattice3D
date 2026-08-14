import { describe, expect, it } from 'vitest';
import { escapeControlCharacters } from './text-safety';

describe('escapeControlCharacters', () => {
  it('keeps ordinary file names readable', () => {
    expect(escapeControlCharacters('bracket v2.stl')).toBe('bracket v2.stl');
  });

  it('renders line and control characters as visible escapes', () => {
    const escaped = escapeControlCharacters('part.stl\nERR forged\r\n\t\u0000\u2028next');
    expect(escaped).toBe('part.stl\\nERR forged\\r\\n\\t\\u0000\\u2028next');
    expect(escaped).not.toContain('\r');
    expect(escaped).not.toContain('\n');
    expect(escaped).not.toContain('\u0000');
    expect(escaped).not.toContain('\u2028');
  });
});
