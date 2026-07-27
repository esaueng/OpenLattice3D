import { describe, expect, it } from 'vitest';
import { escapeHoleCenters, withEscapeHoles, type SampledSdf } from './escape-holes';
import { DEFAULT_PARAMS } from '../types/project';

describe('escape-hole channels', () => {
  it('cuts continuous channels through both scalar and optimized sampled fields', () => {
    const bounds = {
      min: [-10, -10, -10] as [number, number, number],
      max: [10, 10, 10] as [number, number, number],
    };
    const params = {
      ...DEFAULT_PARAMS,
      escapeHoles: true,
      escapeHoleAxis: 'z' as const,
      escapeHoleCount: 2,
      escapeHoleDiameter: 4,
    };
    const solid: SampledSdf = () => -1;
    solid.sampleField = (_bounds, resolution, output) => {
      output.fill(-1, 0, (resolution + 1) ** 3);
    };
    const cut = withEscapeHoles(solid, params, bounds);
    const centers = escapeHoleCenters(bounds, params.escapeHoleAxis, params.escapeHoleCount);

    for (const center of centers) {
      for (const z of [-10, -5, 0, 5, 10]) {
        expect(cut(center[0], center[1], z)).toBeGreaterThan(0);
      }
      expect(cut(center[0] + params.escapeHoleDiameter, center[1], 0)).toBeLessThan(0);
    }

    const resolution = 10;
    const field = new Float32Array((resolution + 1) ** 3);
    cut.sampleField!(bounds, resolution, field);
    const count = resolution + 1;
    const center = centers[0];
    const x = Math.round((center[0] - bounds.min[0]) / 2);
    const y = Math.round((center[1] - bounds.min[1]) / 2);
    for (let z = 0; z <= resolution; z++) {
      expect(field[x + y * count + z * count * count]).toBeGreaterThan(0);
    }
  });
});
