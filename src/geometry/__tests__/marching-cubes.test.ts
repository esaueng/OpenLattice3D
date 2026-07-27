import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../marching-cubes';
import { SOLIDS, analyzeTopology, signedVolume } from './helpers';

const RESOLUTIONS = [48, 96, 168];

describe('marching cubes geometry', () => {
  it.each([
    ['sphere r=25', SOLIDS.sphere(25), 0.2],
    ['cube h=15', SOLIDS.cube(15), 0.2],
    ['torus 20/8', SOLIDS.torus(20, 8), 3.5],
  ])('recovers the volume of %s', (_label, solid, tolerancePct) => {
    const mesh = marchingCubes(solid.sdf, solid.bounds, 128, 0);
    // Sign depends on the emitted winding, which is an implementation detail;
    // magnitude is the geometric claim.
    const measured = Math.abs(signedVolume(mesh));
    const errorPct = Math.abs(100 * (measured - solid.volume) / solid.volume);
    expect(errorPct).toBeLessThan(tolerancePct);
  });

  it('converges toward the analytic volume as resolution rises', () => {
    const solid = SOLIDS.sphere(25);
    const errors = RESOLUTIONS.map((res) => {
      const mesh = marchingCubes(solid.sdf, solid.bounds, res, 0);
      return Math.abs(Math.abs(signedVolume(mesh)) - solid.volume) / solid.volume;
    });
    for (let i = 1; i < errors.length; i++) {
      expect(errors[i]).toBeLessThanOrEqual(errors[i - 1]);
    }
  });

  it('produces consistent winding, so the signed volume never straddles zero', () => {
    for (const solid of [SOLIDS.sphere(25), SOLIDS.cube(15), SOLIDS.torus(20, 8)]) {
      const mesh = marchingCubes(solid.sdf, solid.bounds, 96, 0);
      expect(Math.abs(signedVolume(mesh))).toBeGreaterThan(solid.volume * 0.9);
    }
  });
});

describe('marching cubes topology', () => {
  it.each([
    ['sphere', SOLIDS.sphere(25)],
    ['cube', SOLIDS.cube(15)],
    ['torus', SOLIDS.torus(20, 8)],
  ])('closes the surface of a %s — no boundary edges', (_label, solid) => {
    const mesh = marchingCubes(solid.sdf, solid.bounds, 96, 0);
    expect(analyzeTopology(mesh).boundaryEdges).toBe(0);
  });

  it.each([
    ['sphere', SOLIDS.sphere(25)],
    ['cube', SOLIDS.cube(15)],
    ['torus', SOLIDS.torus(20, 8)],
  ])('keeps the surface of a %s manifold', (_label, solid) => {
    const mesh = marchingCubes(solid.sdf, solid.bounds, 96, 0);
    expect(analyzeTopology(mesh).nonManifoldEdges).toBe(0);
  });

  it('does not degrade topology as resolution rises', () => {
    const solid = SOLIDS.sphere(25);
    for (const res of RESOLUTIONS) {
      const topo = analyzeTopology(marchingCubes(solid.sdf, solid.bounds, res, 0));
      expect(topo.boundaryEdges, `boundary edges at res ${res}`).toBe(0);
      expect(topo.nonManifoldEdges, `non-manifold edges at res ${res}`).toBe(0);
    }
  });

  it('shares vertices between adjacent triangles instead of duplicating them', () => {
    const solid = SOLIDS.sphere(25);
    const mesh = marchingCubes(solid.sdf, solid.bounds, 96, 0);
    const topo = analyzeTopology(mesh);
    // A welded closed surface has roughly triCount/2 vertices; unwelded soup
    // has exactly triCount * 3.
    expect(topo.vertexCount).toBeLessThan(mesh.triCount * 0.6);
  });

  it('gives a closed genus-0 surface an Euler characteristic of 2', () => {
    const solid = SOLIDS.sphere(25);
    const topo = analyzeTopology(marchingCubes(solid.sdf, solid.bounds, 96, 0));
    expect(topo.eulerCharacteristic).toBe(2);
  });

  it('gives a torus an Euler characteristic of 0', () => {
    const solid = SOLIDS.torus(20, 8);
    const topo = analyzeTopology(marchingCubes(solid.sdf, solid.bounds, 96, 0));
    expect(topo.eulerCharacteristic).toBe(0);
  });

  it('seals surfaces that reach the sampling boundary', () => {
    // Bounds deliberately clip the sphere, so the iso-surface runs into the
    // walls of the sampling volume on every side.
    const solid = SOLIDS.sphere(25);
    const clipped = { min: [-20, -20, -20] as [number, number, number],
                      max: [20, 20, 20] as [number, number, number] };
    const topo = analyzeTopology(marchingCubes(solid.sdf, clipped, 96, 0));
    expect(topo.boundaryEdges).toBe(0);
  });
});
