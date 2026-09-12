import { describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS } from '../types/project';
import { modelExtents } from './model-summary';
import { buildPreflight, formatPreflight, gridForResolution } from './preflight';

describe('preflight', () => {
  it('reports grid, voxel size and a one-line summary for the sample sphere', () => {
    const p = buildPreflight(DEFAULT_PARAMS, modelExtents(null, 'sphere', 25), null);
    expect(p.grid).toBe(96);
    expect(gridForResolution(10)).toBe(264);
    expect(p.voxelMm).toBeCloseTo(58 / 96, 6);
    // The shipped defaults are under-resolved on the sphere: a 1.0 mm wall in 0.60 mm voxels.
    expect(p.warnings.map((w) => w.level)).toEqual(['warn']);
    expect(p.warnings[0].message).toMatch(/^Wall thickness 1\.00 mm is under two 0\.60 mm voxels/);
    expect(formatPreflight(p)).toMatch(/^96³ grid · 0\.60 mm voxels · ~406 k triangles · ~\d+s · ~\d+ MB$/);

    const finer = buildPreflight({ ...DEFAULT_PARAMS, exportResolution: 4 }, modelExtents(null, 'sphere', 25), null);
    expect(finer.warnings).toEqual([]);
  });

  it('blocks a cell size that does not fit the part and a shell that fills it', () => {
    const tiny = analyzeMesh(generateCubeMesh(1));
    const p = buildPreflight(DEFAULT_PARAMS, modelExtents(tiny, null, 25), tiny);
    const messages = p.warnings.map((w) => `${w.level}:${w.message}`);
    expect(messages.some((m) => m.startsWith('block:Cell size 8 mm is not smaller'))).toBe(true);
    expect(messages.some((m) => m.startsWith('block:Shell thickness 1.5 mm'))).toBe(true);
  });

  it('blocks open meshes and warns about under-resolved walls', () => {
    const cube = generateCubeMesh(30);
    const open = analyzeMesh({
      positions: cube.positions.slice(0, 10 * 9),
      normals: cube.normals.slice(0, 10 * 3),
      triCount: 10,
    });
    const p = buildPreflight(
      { ...DEFAULT_PARAMS, wallThickness: 0.3, exportResolution: 1 },
      modelExtents(open, null, 25),
      open,
    );
    expect(p.warnings[0]).toMatchObject({ level: 'block' });
    expect(p.warnings[0].message).toContain('4 boundary edges');
    expect(p.warnings.some((w) => w.message.startsWith('Wall thickness 0.30 mm is under two'))).toBe(true);
  });

  it('warns when the triangle estimate gets heavy', () => {
    const p = buildPreflight({ ...DEFAULT_PARAMS, exportResolution: 10 }, modelExtents(null, 'cube', 25), null);
    expect(p.estimatedTriangles).toBeGreaterThan(2_000_000);
    expect(p.warnings.some((w) => w.message.includes('M triangles'))).toBe(true);
  });
});
