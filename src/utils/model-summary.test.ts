import { describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import {
  cellsAcrossShortestSide,
  defaultBrushRadius,
  describeMeshCondition,
  formatDimensions,
  formatVolume,
  modelExtents,
} from './model-summary';

describe('model summary', () => {
  it('reports imported mesh size and closed-mesh volume', () => {
    const info = analyzeMesh(generateCubeMesh(30));
    const extents = modelExtents(info, null, 25)!;
    expect(extents.size).toEqual([30, 30, 30]);
    expect(extents.volumeMm3).toBeCloseTo(27_000, 3);
    expect(formatDimensions(extents.size)).toBe('30.0 × 30.0 × 30.0 mm');
    expect(formatVolume(extents.volumeMm3)).toBe('27.00 cm³');
  });

  it('knows the analytic size of every sample part', () => {
    expect(modelExtents(null, 'sphere', 25)!.size).toEqual([50, 50, 50]);
    expect(modelExtents(null, 'cylinder', 25)!.size).toEqual([30, 30, 40]);
    expect(modelExtents(null, 'torus', 25)!.volumeMm3).toBeCloseTo(2 * Math.PI ** 2 * 20 * 64, 6);
    expect(modelExtents(null, null, 25)).toBeNull();
  });

  it('formats an inch-scale mistake so it cannot pass for a 30 mm part', () => {
    const tiny = analyzeMesh(generateCubeMesh(1));
    expect(formatDimensions(modelExtents(tiny, null, 25)!.size)).toBe('1.00 × 1.00 × 1.00 mm');
    expect(formatVolume(tiny.volumeMm3)).toBe('1.00 mm³');
    expect(cellsAcrossShortestSide([1, 1, 1], 8)).toBeCloseTo(0.125, 6);
    expect(cellsAcrossShortestSide([50, 50, 50], 8)).toBeCloseTo(6.25, 6);
    expect(cellsAcrossShortestSide([50, 50, 50], 0)).toBe(0);
  });

  it('sizes the default brush to the part, never below half a millimetre', () => {
    const cube = analyzeMesh(generateCubeMesh(30));
    // 4% of the 51.96 mm diagonal, rounded to a tenth.
    expect(defaultBrushRadius(cube.boundingBox)).toBe(2.1);
    expect(defaultBrushRadius(analyzeMesh(generateCubeMesh(1)).boundingBox)).toBe(0.5);
  });

  it('describes an open mesh honestly instead of calling it repaired', () => {
    const closed = analyzeMesh(generateCubeMesh(10));
    expect(describeMeshCondition(closed)).toEqual({ level: 'ok', message: 'Closed and manifold' });

    const open = { ...closed, isWatertight: false, isManifold: false, boundaryEdges: 8, repaired: true };
    const condition = describeMeshCondition(open);
    expect(condition.level).toBe('warn');
    expect(condition.message).toContain('Normals recomputed');
    expect(condition.message).toContain('still open (8 boundary edges)');
    expect(condition.message).not.toContain('repaired');
  });
});
