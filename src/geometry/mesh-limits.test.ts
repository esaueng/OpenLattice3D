import { describe, expect, it } from 'vitest';
import {
  addMeshTriangleArea,
  assertFileSizeWithinBudget,
  DEFAULT_IMPORT_LIMITS,
  estimateDecodedBase64Bytes,
  formatByteCount,
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
});

describe('import byte budgets', () => {
  it('pins the documented browser-memory budgets', () => {
    expect(DEFAULT_IMPORT_LIMITS).toEqual({
      maxStlBytes: 128 * 1024 * 1024,
      maxTriangles: 5_000_000,
      maxEmbeddedStlBytes: 128 * 1024 * 1024,
      maxProjectBytes: 256 * 1024 * 1024,
    });
  });

  it('accepts a file at the budget and rejects one byte over', () => {
    expect(() => assertFileSizeWithinBudget(1024, 1024, 'STL file part.stl')).not.toThrow();
    expect(() => assertFileSizeWithinBudget(1025, 1024, 'STL file part.stl')).toThrow(/exceeding the 1 KiB import limit/);
  });

  it('names the label, actual size, and budget in the error', () => {
    expect(() => assertFileSizeWithinBudget(3 * 1024 * 1024, 2 * 1024 * 1024, 'Project file p.json'))
      .toThrow(/^Project file p\.json is 3 MiB, exceeding the 2 MiB import limit$/);
  });

  it('formats bytes, KiB, and MiB without fractional noise', () => {
    expect(formatByteCount(512)).toBe('512 B');
    expect(formatByteCount(1536)).toBe('1.5 KiB');
    expect(formatByteCount(128 * 1024 * 1024)).toBe('128 MiB');
  });

  it('upper-bounds the decoded size of a base64 payload', () => {
    expect(estimateDecodedBase64Bytes(8)).toBe(6);
    // Unpadded partial groups still decode, so the estimate rounds up.
    expect(estimateDecodedBase64Bytes(3)).toBe(3);
  });
});
