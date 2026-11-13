import { describe, expect, it } from 'vitest';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { formatFraction, relativeDensity, sourceSolidVolumeMm3 } from './part-statistics';

describe('part statistics', () => {
  it('uses the procedural volume for sample shapes', () => {
    expect(sourceSolidVolumeMm3({ sampleShape: 'cube', sphereRadius: 25, originalMesh: null, meshInfo: null })).toBe(27_000);
  });

  it('measures a closed imported mesh and refuses an open one', () => {
    const cube = generateCubeMesh(10);
    expect(sourceSolidVolumeMm3({ sampleShape: null, sphereRadius: 25, originalMesh: cube, meshInfo: { isWatertight: true } }))
      .toBeCloseTo(1000, 6);
    expect(sourceSolidVolumeMm3({ sampleShape: null, sphereRadius: 25, originalMesh: cube, meshInfo: { isWatertight: false } })).toBeNull();
    expect(sourceSolidVolumeMm3({ sampleShape: null, sphereRadius: 25, originalMesh: null, meshInfo: null })).toBeNull();
  });

  it('only states a relative density when both volumes are meaningful', () => {
    expect(relativeDensity(250, 1000)).toBeCloseTo(0.25, 12);
    expect(relativeDensity(250, null)).toBeNull();
    expect(relativeDensity(250, 0)).toBeNull();
    expect(relativeDensity(Number.NaN, 1000)).toBeNull();
  });

  it('formats a fraction as a percent', () => {
    expect(formatFraction(0.4583)).toBe('45.8%');
    expect(formatFraction(0.4583, 0)).toBe('46%');
  });
});
