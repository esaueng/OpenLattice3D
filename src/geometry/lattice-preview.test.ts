import { describe, expect, it } from 'vitest';
import { LATTICE_PREVIEW_RESOLUTION, latticeSlice, sliceCoverage, sliceSolidFraction, type LatticeSlice } from './lattice-preview';
import type { LatticeType } from '../types/project';

const ALL_TYPES: readonly LatticeType[] = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp',
  'bcc', 'octet', 'diamond', 'hexagon', 'triangle',
  'voronoi', 'spinodal',
];

/** 8-connected components of the samples matching `include`: their sizes, and
 *  how many touch no edge of the slice. */
function components(slice: LatticeSlice, include: (value: number) => boolean) {
  const { size, values } = slice;
  const label = new Int32Array(values.length).fill(-1);
  const sizes: number[] = [];
  let enclosed = 0;
  for (let start = 0; start < values.length; start++) {
    if (label[start] >= 0 || !include(values[start])) continue;
    const id = sizes.length;
    const stack = [start];
    label[start] = id;
    let count = 0;
    let touchesEdge = false;
    while (stack.length > 0) {
      const index = stack.pop()!;
      count++;
      const row = Math.floor(index / size);
      const col = index % size;
      if (row === 0 || col === 0 || row === size - 1 || col === size - 1) touchesEdge = true;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const r = row + dr;
          const c = col + dc;
          if (r < 0 || c < 0 || r >= size || c >= size) continue;
          const next = r * size + c;
          if (label[next] >= 0 || !include(values[next])) continue;
          label[next] = id;
          stack.push(next);
        }
      }
    }
    sizes.push(count);
    if (!touchesEdge) enclosed++;
  }
  return { sizes, enclosed };
}

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

  it('shows the diamond lattice as one connected network of struts around closed cells', () => {
    // An axis or (110) slice of the diamond lattice falls apart into dots or
    // separate zigzag bands; the (111) slice is a single strut network.
    const slice = latticeSlice('diamond');
    const solid = components(slice, (value) => value < 0);
    const solidCount = solid.sizes.reduce((sum, size) => sum + size, 0);
    expect(Math.max(...solid.sizes) / solidCount).toBeGreaterThan(0.95);
    // Several voids are enclosed entirely by struts (honeycomb cells).
    const voids = components(slice, (value) => value >= 0);
    expect(voids.enclosed).toBeGreaterThanOrEqual(3);
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
