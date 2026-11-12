import { describe, expect, it } from 'vitest';
import { generateCubeMesh } from './mesh-analysis';
import { massGrams, meshVolumeMm3, proceduralSolidVolumeMm3 } from './mesh-stats';

describe('mesh statistics', () => {
  it('computes the exact volume of a closed cube in mm^3', () => {
    expect(meshVolumeMm3(generateCubeMesh(30))).toBeCloseTo(27_000, 6);
  });

  it('is independent of consistent global triangle winding', () => {
    const cube = generateCubeMesh(10);
    const reversed = new Float32Array(cube.positions);
    for (let triangle = 0; triangle < cube.triCount; triangle++) {
      const offset = triangle * 9;
      for (let component = 0; component < 3; component++) {
        const value = reversed[offset + 3 + component];
        reversed[offset + 3 + component] = reversed[offset + 6 + component];
        reversed[offset + 6 + component] = value;
      }
    }
    expect(meshVolumeMm3({ positions: reversed, triCount: cube.triCount })).toBeCloseTo(1000, 6);
  });

  it('uses explicit mm^3 to cm^3 conversion for mass', () => {
    expect(massGrams(1000, 1.24)).toBeCloseTo(1.24, 9);
  });

  it('reports analytic source volumes for procedural parts', () => {
    expect(proceduralSolidVolumeMm3('sphere', 10)).toBeCloseTo((4 / 3) * Math.PI * 1000, 9);
    expect(proceduralSolidVolumeMm3('cube', 25)).toBe(27_000);
  });

  it('derives every procedural volume from the shared shape dimensions without changing it', () => {
    // The literal formulas used before the volumes read SAMPLE_SHAPE_DIMENSIONS.
    // Exact equality on purpose: the derivation must be bit-identical.
    expect(proceduralSolidVolumeMm3('sphere', 25)).toBe((4 / 3) * Math.PI * 25 ** 3);
    expect(proceduralSolidVolumeMm3('cube', 25)).toBe(30 ** 3);
    expect(proceduralSolidVolumeMm3('cylinder', 25)).toBe(Math.PI * 15 ** 2 * 40);
    expect(proceduralSolidVolumeMm3('torus', 25)).toBe(2 * Math.PI ** 2 * 20 * 8 ** 2);
    expect(proceduralSolidVolumeMm3('capsule', 25))
      .toBe(Math.PI * 12 ** 2 * 30 + (4 / 3) * Math.PI * 12 ** 3);
  });
});
