import { describe, expect, it } from 'vitest';
import { analyzeMesh, generateCubeMesh } from '../geometry/mesh-analysis';
import { DEFAULT_PARAMS } from '../types/project';
import { modelExtents } from './model-summary';
import { buildPreflight, formatPreflight, gridForResolution, minimumResolutionForFeature, minimumResolutionForVoxel } from './preflight';

describe('preflight', () => {
  it('reports grid, voxel size and a one-line summary for the sample sphere', () => {
    const p = buildPreflight(DEFAULT_PARAMS, modelExtents(null, 'sphere', 25), null);
    expect(p.grid).toBe(120);
    expect(gridForResolution(10)).toBe(264);
    expect(p.voxelMm).toBeCloseTo(58 / 120, 6);
    // The shipped defaults put two voxels across the 1.0 mm wall on the sample sphere.
    expect(p.warnings).toEqual([]);
    expect(formatPreflight(p)).toMatch(/^120³ grid · 0\.48 mm voxels · ~634 k triangles · ~\d+s · ~\d+ MB$/);
  });

  it('offers the lowest resolution that resolves an under-resolved wall', () => {
    const coarse = buildPreflight({ ...DEFAULT_PARAMS, exportResolution: 3 }, modelExtents(null, 'sphere', 25), null);
    expect(coarse.warnings.map((w) => w.level)).toEqual(['warn']);
    expect(coarse.warnings[0].message).toMatch(/^Wall thickness 1\.00 mm is under two 0\.60 mm voxels/);
    expect(coarse.warnings[0].fix).toEqual({ label: 'Raise resolution to 4', params: { exportResolution: 4 } });
    const fixed = buildPreflight({ ...DEFAULT_PARAMS, ...coarse.warnings[0].fix!.params }, modelExtents(null, 'sphere', 25), null);
    expect(fixed.warnings).toEqual([]);

    // The torus spans 64 mm with padding, so it needs one level more.
    const torus = buildPreflight(DEFAULT_PARAMS, modelExtents(null, 'torus', 25), null);
    expect(torus.warnings[0].fix?.params).toEqual({ exportResolution: 5 });
  });

  it('offers no fix when even the finest level cannot resolve the wall', () => {
    const p = buildPreflight({ ...DEFAULT_PARAMS, wallThickness: 0.1 }, modelExtents(null, 'sphere', 25), null);
    expect(p.warnings[0].message).toMatch(/^Wall thickness 0\.10 mm/);
    expect(p.warnings[0].fix).toBeUndefined();
    expect(minimumResolutionForFeature({ ...DEFAULT_PARAMS, wallThickness: 0.1 }, modelExtents(null, 'sphere', 25))).toBeNull();
  });

  it('uses the strut diameter for strut lattices and the thin-feature threshold for removal', () => {
    const strut = { ...DEFAULT_PARAMS, latticeType: 'bcc' as const, strutDiameter: 0.9, exportResolution: 3 };
    expect(minimumResolutionForFeature(strut, modelExtents(null, 'sphere', 25))).toBe(5);
    const p = buildPreflight({ ...DEFAULT_PARAMS, thinSectionFilter: 0.8 }, modelExtents(null, 'sphere', 25), null);
    const removal = p.warnings.find((w) => w.message.startsWith('Thin-feature removal under 0.8 mm'));
    expect(removal?.fix).toEqual({ label: 'Raise resolution to 6', params: { exportResolution: 6 } });
  });

  it('finds the lowest level for a voxel size and rejects nonsense', () => {
    expect(minimumResolutionForVoxel(58, 0.5)).toBe(4);
    expect(minimumResolutionForVoxel(58, 10)).toBe(1);
    expect(minimumResolutionForVoxel(58, 0.01)).toBeNull();
    expect(minimumResolutionForVoxel(0, 0.5)).toBeNull();
    expect(minimumResolutionForVoxel(58, Number.NaN)).toBeNull();
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

  it('blocks closed but non-manifold meshes without calling them open', () => {
    const cube = analyzeMesh(generateCubeMesh(30));
    const finned = { ...cube, isWatertight: false, isManifold: false, nonManifoldEdges: 3, volumeMm3: null };
    const p = buildPreflight(DEFAULT_PARAMS, modelExtents(finned, null, 25), finned);
    expect(p.warnings[0]).toMatchObject({ level: 'block' });
    expect(p.warnings[0].message).toContain('3 non-manifold edges');
    expect(p.warnings[0].message).not.toContain('open');
  });

  it('warns when the triangle estimate gets heavy', () => {
    const p = buildPreflight({ ...DEFAULT_PARAMS, exportResolution: 10 }, modelExtents(null, 'cube', 25), null);
    expect(p.estimatedTriangles).toBeGreaterThan(2_000_000);
    expect(p.warnings.some((w) => w.message.includes('M triangles'))).toBe(true);
  });
});
