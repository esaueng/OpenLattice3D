import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../marching-cubes';
import { exportBinarySTL, parseSTL } from '../stl-parser';
import { computeSignedVolume } from '../mesh-analysis';
import { SOLIDS } from './helpers';

/**
 * Both STL and 3MF expect triangles wound counter-clockwise seen from outside,
 * which makes the signed volume of a closed solid positive. Marching cubes here
 * emits the opposite winding, so exporters have to account for it.
 */
describe('exported orientation', () => {
  it('round-trips a solid through binary STL with outward winding', () => {
    const solid = SOLIDS.sphere(25);
    const mesh = marchingCubes(solid.sdf, solid.bounds, 64, 0);

    const buffer = exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount);
    const reimported = parseSTL(buffer);

    expect(reimported.triCount).toBe(mesh.triCount);
    const volume = computeSignedVolume(reimported);
    expect(volume, 'exported STL should enclose positive volume').toBeGreaterThan(0);
    expect(Math.abs(volume) / solid.volume).toBeGreaterThan(0.97);
  });
});
