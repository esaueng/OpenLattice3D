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

function maxSphereRadialError(mesh: IndexedMesh, radius: number): number {
  let maxError = 0;
  const samples = [
    [1 / 3, 1 / 3, 1 / 3],
    [0.5, 0.5, 0],
    [0.5, 0, 0.5],
    [0, 0.5, 0.5],
  ];
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    const a = mesh.indices[triangle * 3];
    const b = mesh.indices[triangle * 3 + 1];
    const c = mesh.indices[triangle * 3 + 2];
    for (const [wa, wb, wc] of samples) {
      const x = wa * mesh.positions[a * 3]
        + wb * mesh.positions[b * 3]
        + wc * mesh.positions[c * 3];
      const y = wa * mesh.positions[a * 3 + 1]
        + wb * mesh.positions[b * 3 + 1]
        + wc * mesh.positions[c * 3 + 1];
      const z = wa * mesh.positions[a * 3 + 2]
        + wb * mesh.positions[b * 3 + 2]
        + wc * mesh.positions[c * 3 + 2];
      maxError = Math.max(maxError, Math.abs(Math.hypot(x, y, z) - radius));
    }
  }
  return maxError;
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

  it.each([0.2, 0.05])(
    'keeps sampled sphere deviation within the %fmm source-plane bound',
    (maxError) => {
      const baseline = maxSphereRadialError(source, 25);
      const result = decimateMesh(source, { targetRatio: 0.05, maxError });
      const simplified = maxSphereRadialError(result.mesh, 25);

      expect(result.rejectedError).toBeGreaterThan(0);
      expect(simplified - baseline).toBeLessThanOrEqual(maxError);
    },
  );

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
