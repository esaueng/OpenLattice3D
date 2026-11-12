import { describe, expect, it } from 'vitest';
import { LATTICE_PREVIEW_RESOLUTION, latticeSlice, sliceCoverage, sliceSolidFraction } from './lattice-preview';
import type { LatticeType } from '../types/project';

const ALL_TYPES: readonly LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp',
  'bcc', 'octet', 'diamond', 'hexagon', 'triangle',
  'voronoi', 'spinodal',
];

describe('latticeSlice', () => {
  it('returns a square grid of the requested resolution with finite values', () => {
    for (const type of ALL_TYPES) {
      const slice = latticeSlice(type);
      expect(slice.size).toBe(LATTICE_PREVIEW_RESOLUTION);
      expect(slice.values).toHaveLength(LATTICE_PREVIEW_RESOLUTION * LATTICE_PREVIEW_RESOLUTION);
      expect(slice.pixelMm).toBeGreaterThan(0);
      expect(slice.values.every(Number.isFinite)).toBe(true);
    }
    expect(latticeSlice('gyroid', 12).values).toHaveLength(144);
  });

  it('shows both material and void, so every thumbnail has a pattern', () => {
    for (const type of ALL_TYPES) {
      const fraction = sliceSolidFraction(latticeSlice(type));
      expect(fraction, type).toBeGreaterThan(0.05);
      expect(fraction, type).toBeLessThan(0.9);
    }
  });

  it('uses the SDF sign convention: negative inside material', () => {
    // Schwarz P sheet: the slice centre of each cell is far from the surface
    // (open void) while the sheet itself is solid.
    const slice = latticeSlice('schwarzP', 48);
    const min = Math.min(...slice.values);
    const max = Math.max(...slice.values);
    expect(min).toBeLessThan(0);
    expect(max).toBeGreaterThan(0);
    // Sheet walls are thin: the deepest point inside is about half the wall.
    expect(min).toBeGreaterThan(-1.4);
  });

  it('is deterministic, including the stochastic types', () => {
    for (const type of ['voronoi', 'spinodal', 'gyroid'] as const) {
      expect(Array.from(latticeSlice(type, 16).values)).toEqual(Array.from(latticeSlice(type, 16).values));
    }
  });
});

describe('sliceCoverage', () => {
  it('maps inside to opaque, outside to clear, and the surface to half coverage', () => {
    const coverage = sliceCoverage({ size: 2, pixelMm: 1, values: Float32Array.from([-2, 2, 0, -0.25]) });
    expect(Array.from(coverage)).toEqual([255, 0, 128, 191]);
  });
});
