import { describe, expect, it } from 'vitest';
import { checkMinThickness } from './validation';
import type { MarchingCubesResult } from './marching-cubes';

function planarSurface(x: number): MarchingCubesResult {
  return {
    positions: new Float32Array([
      x, -1, -1,
      x, 1, -1,
      x, 0, 2,
    ]),
    // Deliberately wrong: thickness must come from the field gradient.
    normals: new Float32Array([-1, 0, 0]),
    triCount: 1,
  };
}

describe('minimum-thickness validation against known solids', () => {
  it.each([0.3, 0.6, 1, 1.5, 2, 3])('measures a %fmm slab continuously', (thickness) => {
    const sdf = (x: number) => Math.abs(x) - thickness * 0.5;
    const result = checkMinThickness(sdf, planarSurface(thickness * 0.5), 0.8, 1);
    expect(result.minMeasured).toBeCloseTo(thickness, 5);
    expect(result.absoluteMin).toBeCloseTo(thickness, 5);
    expect(result.sampled).toBe(1);
    expect(result.passed).toBe(thickness >= 0.8 - 1e-3);
  });

  it('measures the same geometry independently of the requested threshold', () => {
    const thickness = 1;
    const sdf = (x: number) => Math.abs(x) - thickness * 0.5;
    for (const required of [0.5, 0.8, 1, 1.5]) {
      const result = checkMinThickness(sdf, planarSurface(thickness * 0.5), required, 1);
      expect(result.minMeasured).toBeCloseTo(thickness, 5);
      expect(result.passed).toBe(thickness >= required - 1e-3);
    }
  });
});
