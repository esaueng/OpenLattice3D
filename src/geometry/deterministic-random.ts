export const GENERATION_SEED_VERSION = 1 as const;
export const GENERATION_PRNG = 'mulberry32-fnv1a-v1';
export const DEFAULT_GENERATION_SEED = 0;

export type RandomSource = () => number;
export type SeedStreamPart = string | number;

export function isGenerationSeed(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

export function normalizeGenerationSeed(value: unknown): number {
  return isGenerationSeed(value) ? value : DEFAULT_GENERATION_SEED;
}

export function formatGenerationSeed(seed: number): string {
  return `v${GENERATION_SEED_VERSION}:0x${normalizeGenerationSeed(seed).toString(16).padStart(8, '0')}`;
}

function mixByte(hash: number, value: number): number {
  return Math.imul((hash ^ value) >>> 0, 16777619) >>> 0;
}

/** Derive a stable logical stream without depending on execution order. */
export function deriveGenerationSeed(rootSeed: number, ...parts: SeedStreamPart[]): number {
  let hash = 2166136261;
  const normalizedRoot = normalizeGenerationSeed(rootSeed);
  for (let shift = 0; shift < 32; shift += 8) hash = mixByte(hash, normalizedRoot >>> shift);

  for (const part of parts) {
    const text = typeof part === 'number' ? `n:${part}` : `s:${part}`;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      hash = mixByte(hash, code & 0xff);
      hash = mixByte(hash, code >>> 8);
    }
    hash = mixByte(hash, 0xff);
  }
  return hash >>> 0;
}

/** Mulberry32: a compact, fully specified 32-bit deterministic PRNG. */
export function createDeterministicRandom(rootSeed: number, ...parts: SeedStreamPart[]): RandomSource {
  let state = deriveGenerationSeed(rootSeed, ...parts);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/** Produce a different seed only when the user explicitly requests a reseed. */
export function createReseedValue(
  currentSeed: number,
  fill: (target: Uint32Array) => Uint32Array = (target) => crypto.getRandomValues(target),
): number {
  let next: number;
  try {
    next = fill(new Uint32Array(1))[0] >>> 0;
  } catch {
    next = (normalizeGenerationSeed(currentSeed) + 0x9e3779b9) >>> 0;
  }
  if (next === normalizeGenerationSeed(currentSeed)) next = (next + 0x9e3779b9) >>> 0;
  return next;
}
