import { describe, expect, it } from 'vitest';
import {
  createDeterministicRandom,
  createReseedValue,
  deriveGenerationSeed,
  normalizeGenerationSeed,
} from './deterministic-random';

describe('deterministic generation random streams', () => {
  it('repeats a stream exactly for the same seed and path', () => {
    const first = createDeterministicRandom(1234, 'surface', 'mesh', 7);
    const second = createDeterministicRandom(1234, 'surface', 'mesh', 7);
    expect(Array.from({ length: 16 }, first)).toEqual(Array.from({ length: 16 }, second));
  });

  it('keeps logical substreams independent of scheduling order', () => {
    const scheduled = [3, 0, 2, 1].map((job) => [
      job,
      Array.from({ length: 4 }, createDeterministicRandom(99, 'worker-job', job)),
    ] as const).sort((a, b) => a[0] - b[0]);
    const serial = [0, 1, 2, 3].map((job) => [
      job,
      Array.from({ length: 4 }, createDeterministicRandom(99, 'worker-job', job)),
    ] as const);
    expect(scheduled).toEqual(serial);
    expect(deriveGenerationSeed(99, 'tile', 0)).not.toBe(deriveGenerationSeed(99, 'tile', 1));
  });

  it('normalizes legacy or malformed seeds safely', () => {
    expect(normalizeGenerationSeed(undefined)).toBe(0);
    expect(normalizeGenerationSeed(-1)).toBe(0);
    expect(normalizeGenerationSeed(0xffff_ffff)).toBe(0xffff_ffff);
  });

  it('forces an explicit reseed to change the value', () => {
    expect(createReseedValue(42, (target) => {
      target[0] = 42;
      return target;
    })).not.toBe(42);
  });
});
