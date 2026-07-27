import { describe, expect, it } from 'vitest';
import { marchingCubes } from '../marching-cubes';
import type { MarchingCubesResult } from '../marching-cubes';
import { buildIndexedMesh } from '../mesh-indexing';
import type { IndexedMesh } from '../mesh-indexing';
import { decimateMesh } from '../decimate';
import { buildSphereLattice } from '../lattice';
import { DEFAULT_PARAMS } from '../../types/project';
import { SOLIDS, analyzeTopology, signedVolume } from './helpers';

/** Expand back to soup so the shared topology helper applies. */
function toSoup(mesh: IndexedMesh): MarchingCubesResult {
  const positions = new Float32Array(mesh.triangleCount * 9);
  for (let i = 0; i < mesh.triangleCount; i++) {
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[i * 3 + k];
      positions[i * 9 + k * 3] = mesh.positions[v * 3];
      positions[i * 9 + k * 3 + 1] = mesh.positions[v * 3 + 1];
      positions[i * 9 + k * 3 + 2] = mesh.positions[v * 3 + 2];
    }
  }
  return { positions, normals: new Float32Array(mesh.triangleCount * 3), triCount: mesh.triangleCount };
}

describe('decimation', () => {
  const solid = SOLIDS.sphere(25);
  const source = buildIndexedMesh(marchingCubes(solid.sdf, solid.bounds, 64, 0));

  it('reduces toward the requested triangle count', () => {
    for (const ratio of [0.75, 0.5, 0.25]) {
      const { mesh } = decimateMesh(source, { targetRatio: ratio });
      const achieved = mesh.triangleCount / source.triangleCount;
      expect(achieved, `ratio ${ratio}`).toBeLessThan(ratio + 0.1);
      expect(mesh.triangleCount, `ratio ${ratio}`).toBeGreaterThan(0);
    }
  });

  it('leaves the mesh alone when nothing is asked of it', () => {
    const { mesh, collapsed } = decimateMesh(source, { targetRatio: 1 });
    expect(collapsed).toBe(0);
    expect(mesh.triangleCount).toBe(source.triangleCount);
  });

  // The point of the exercise: simplification must not undo watertightness.
  it.each([0.75, 0.5, 0.25])('keeps the surface closed and manifold at ratio %f', (ratio) => {
    const { mesh } = decimateMesh(source, { targetRatio: ratio });
    const topo = analyzeTopology(toSoup(mesh));
    expect(topo.boundaryEdges, 'boundary edges').toBe(0);
    expect(topo.nonManifoldEdges, 'non-manifold edges').toBe(0);
  });

  it('preserves genus, so no handles are punched or filled', () => {
    const { mesh } = decimateMesh(source, { targetRatio: 0.4 });
    expect(analyzeTopology(toSoup(mesh)).eulerCharacteristic).toBe(2);
  });

  it('keeps the enclosed volume, and keeps it positive', () => {
    const before = signedVolume(toSoup(source));
    for (const ratio of [0.5, 0.25]) {
      const { mesh } = decimateMesh(source, { targetRatio: ratio });
      const after = signedVolume(toSoup(mesh));
      expect(after, `winding at ratio ${ratio}`).toBeGreaterThan(0);
      expect(Math.abs(after - before) / before, `volume drift at ratio ${ratio}`).toBeLessThan(0.02);
    }
  });

  it('honours the error bound instead of collapsing regardless', () => {
    const tight = decimateMesh(source, { targetRatio: 0.1, maxError: 1e-6 });
    const loose = decimateMesh(source, { targetRatio: 0.1, maxError: 1 });
    expect(tight.rejectedError).toBeGreaterThan(0);
    expect(tight.mesh.triangleCount).toBeGreaterThan(loose.mesh.triangleCount);
  });

  it('holds up on real lattice geometry, not just a smooth solid', () => {
    const sdf = buildSphereLattice(25, { ...DEFAULT_PARAMS, escapeHoles: false });
    const lattice = buildIndexedMesh(
      marchingCubes(sdf, { min: [-29, -29, -29], max: [29, 29, 29] }, 48, 0)
    );
    const { mesh } = decimateMesh(lattice, { targetRatio: 0.5 });
    const topo = analyzeTopology(toSoup(mesh));
    expect(topo.boundaryEdges, 'boundary edges').toBe(0);
    expect(topo.nonManifoldEdges, 'non-manifold edges').toBe(0);
    expect(mesh.triangleCount).toBeLessThan(lattice.triangleCount);
  });
});
