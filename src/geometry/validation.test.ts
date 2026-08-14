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

  it('fails when one measured ray is thinner than the requirement', () => {
    const thicknesses = [0.1, ...Array.from({ length: 99 }, () => 1)];
    const positions = new Float32Array(thicknesses.length * 9);
    for (let index = 0; index < thicknesses.length; index++) {
      const x = thicknesses[index] * 0.5;
      const y = index === 0 ? -2 : 2;
      positions.set([x, y, -1, x, y + 0.5, -1, x, y + 0.25, 1], index * 9);
    }
    const result: MarchingCubesResult = {
      positions,
      normals: new Float32Array(thicknesses.length * 3),
      triCount: thicknesses.length,
    };
    const sdf = (x: number, y: number) => Math.abs(x) - (y < 0 ? 0.05 : 0.5);

    const measured = checkMinThickness(sdf, result, 0.8, thicknesses.length);
    expect(measured.minMeasured).toBeCloseTo(1, 5);
    expect(measured.absoluteMin).toBeCloseTo(0.1, 5);
    expect(measured.passed).toBe(false);
  });
});
