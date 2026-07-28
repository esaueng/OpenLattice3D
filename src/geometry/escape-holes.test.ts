import { describe, expect, it } from 'vitest';
import {
  cutEscapeHolesInField,
  escapeHoleCenters,
  withEscapeHoles,
  type SampledSdf,
} from './escape-holes';
import { openField } from './morphology';
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

  it('cuts configured holes into a sampled field after other field operations', () => {
    const bounds = {
      min: [-2, -2, -2] as [number, number, number],
      max: [2, 2, 2] as [number, number, number],
    };
    const cells: [number, number, number] = [4, 4, 4];
    const params = {
      ...DEFAULT_PARAMS,
      variant: 'shell_core' as const,
      noShell: false,
      surfaceOnly: false,
      escapeHoles: true,
      escapeHoleAxis: 'z' as const,
      escapeHoleCount: 1,
      escapeHoleDiameter: 2,
    };
    const count = cells[0] + 1;
    const field = new Float32Array(count ** 3);
    field.fill(-1);

    cutEscapeHolesInField(field, bounds, cells, params);

    for (let z = 0; z < count; z++) {
      expect(field[2 + 2 * count + z * count * count]).toBeGreaterThan(0);
      expect(field[4 + 2 * count + z * count * count]).toBeLessThan(0);
    }
  });

  it('preserves the requested diameter when holes are cut after morphology', () => {
    const bounds = {
      min: [-10, -10, -10] as [number, number, number],
      max: [10, 10, 10] as [number, number, number],
    };
    const cells: [number, number, number] = [80, 80, 80];
    const spacing: [number, number, number] = [0.25, 0.25, 0.25];
    const count = cells[0] + 1;
    const field = new Float32Array(count ** 3);
    field.fill(-1);
    const diameter = 4;
    const params = {
      ...DEFAULT_PARAMS,
      variant: 'shell_core' as const,
      noShell: false,
      surfaceOnly: false,
      escapeHoles: true,
      escapeHoleAxis: 'z' as const,
      escapeHoleCount: 1,
      escapeHoleDiameter: diameter,
    };

    openField(field, [count, count, count], spacing, 0.5);
    cutEscapeHolesInField(field, bounds, cells, params);

    const y = cells[1] / 2;
    const z = cells[2] / 2;
    const values = Array.from({ length: count }, (_, x) =>
      field[x + y * count + z * count * count]);
    const crossings: number[] = [];
    for (let x = 0; x < cells[0]; x++) {
      if ((values[x] >= 0) === (values[x + 1] >= 0)) continue;
      const t = values[x] / (values[x] - values[x + 1]);
      crossings.push(bounds.min[0] + (x + t) * spacing[0]);
    }

    expect(crossings).toHaveLength(2);
    expect(crossings[1] - crossings[0]).toBeCloseTo(diameter, 6);
  });
});
