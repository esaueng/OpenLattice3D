import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../marching-cubes';
import { buildSphereLattice } from '../lattice';
import { checkTopology } from '../validation';
import { DEFAULT_PARAMS } from '../../types/project';
import { SOLIDS, analyzeTopology } from './helpers';

/**
 * The reported non-manifold count on lattice output grew with resolution, which
 * pointed at the extractor. These compare exact-identity topology against what
 * validation.ts reports, to establish which of the two is actually wrong before
 * anything is rewritten.
 */
describe('topology measurement basis', () => {
  const R = 25;
  const bounds = { min: [-29, -29, -29] as [number, number, number],
                   max: [29, 29, 29] as [number, number, number] };

  it.each([48, 96, 168])('reports lattice topology consistently at resolution %i', (res) => {
    const sdf = buildSphereLattice(R, { ...DEFAULT_PARAMS, escapeHoles: false });
    const mesh = marchingCubes(sdf, bounds, res, 0);

    const exact = analyzeTopology(mesh);
    const reported = checkTopology(mesh);

    // Surfaced on failure so the two bases can be compared directly.
    expect({
      res,
      exactBoundary: exact.boundaryEdges,
      exactNonManifold: exact.nonManifoldEdges,
      degenerates: exact.degenerateTriangles,
      reported: reported.manifold.details,
    }).toBeTruthy();

    expect(exact.boundaryEdges, `boundary edges at res ${res}`).toBe(0);
    expect(exact.nonManifoldEdges, `non-manifold edges at res ${res}`).toBe(0);
  });

  it.each([48, 96, 168])('reports the same edge counts as exact identity at resolution %i', (res) => {
    const sdf = buildSphereLattice(R, { ...DEFAULT_PARAMS, escapeHoles: false });
    const mesh = marchingCubes(sdf, bounds, res, 0);
    const exact = analyzeTopology(mesh);
    const reported = checkTopology(mesh);

    const counts = /Non-manifold edges: (\d+), boundary edges: (\d+)/.exec(reported.manifold.details);
    // A clean mesh reports a plain message rather than counts.
    const reportedNonManifold = counts ? Number(counts[1]) : 0;
    const reportedBoundary = counts ? Number(counts[2]) : 0;

    expect(reportedNonManifold, `non-manifold at res ${res}`).toBe(exact.nonManifoldEdges);
    expect(reportedBoundary, `boundary at res ${res}`).toBe(exact.boundaryEdges);
    expect(reported.manifold.passed, `passed at res ${res}`)
      .toBe(exact.nonManifoldEdges === 0 && exact.boundaryEdges === 0);
  });

  it('keeps a plain solid manifold at every resolution', () => {
    const solid = SOLIDS.sphere(25);
    for (const res of [48, 96, 168]) {
      const topo = analyzeTopology(marchingCubes(solid.sdf, solid.bounds, res, 0));
      expect(topo.boundaryEdges, `boundary at res ${res}`).toBe(0);
      expect(topo.nonManifoldEdges, `non-manifold at res ${res}`).toBe(0);
    }
  });
});
