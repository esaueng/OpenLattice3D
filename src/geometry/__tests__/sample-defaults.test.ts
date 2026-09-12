// Every built-in sample must generate a printable single body with the
// shipped defaults: a red verdict on the tool's own demo teaches users to
// ignore the verdict.
import { describe, expect, it } from 'vitest';
import {
  buildCapsuleLattice,
  buildCubeLattice,
  buildCylinderLattice,
  buildSphereLattice,
  buildTorusLattice,
} from '../lattice';
import { marchingCubesFromField, sampleSdfField, sealFieldBoundary } from '../marching-cubes';
import { closeBoundaryLoops } from '../mesh-repair';
import { checkTopology, topologyWarnings } from '../validation';
import { DEFAULT_PARAMS, type LatticeParams, type SampleShape } from '../../types/project';
import type { Vec3 } from '../vec3';

const RESOLUTION = 24 + DEFAULT_PARAMS.exportResolution * 24;

function sampleField(shape: SampleShape, params: LatticeParams) {
  const pad = params.cellSize * 0.5;
  let sdf: (x: number, y: number, z: number) => number;
  let bounds: { min: Vec3; max: Vec3 };
  switch (shape) {
    case 'sphere': {
      const e = 25 + pad;
      bounds = { min: [-e, -e, -e], max: [e, e, e] };
      sdf = buildSphereLattice(25, params, 0);
      break;
    }
    case 'cube': {
      const e = 15 + pad;
      bounds = { min: [-e, -e, -e], max: [e, e, e] };
      sdf = buildCubeLattice(15, params, 0);
      break;
    }
    case 'cylinder': {
      bounds = { min: [-15 - pad, -15 - pad, -20 - pad], max: [15 + pad, 15 + pad, 20 + pad] };
      sdf = buildCylinderLattice(15, 20, params, 0);
      break;
    }
    case 'torus': {
      const xy = 28 + pad;
      bounds = { min: [-xy, -xy, -(8 + pad)], max: [xy, xy, 8 + pad] };
      sdf = buildTorusLattice(20, 8, params, 0);
      break;
    }
    case 'capsule': {
      const ext = 27 + pad;
      bounds = { min: [-(12 + pad), -(12 + pad), -ext], max: [12 + pad, 12 + pad, ext] };
      sdf = buildCapsuleLattice(12, 15, params, 0);
      break;
    }
  }
  const cells: Vec3 = [RESOLUTION, RESOLUTION, RESOLUTION];
  const field = sampleSdfField(sdf, bounds, cells);
  sealFieldBoundary(field, cells, 0);
  return closeBoundaryLoops(marchingCubesFromField(field, bounds, cells, 0)).result;
}

describe('sample parts with shipped defaults', () => {
  it.each<SampleShape>(['sphere', 'cube', 'cylinder', 'torus', 'capsule'])(
    '%s is one manifold solid body (voids are reported, not counted as fragments)',
    (shape) => {
      const mesh = sampleField(shape, DEFAULT_PARAMS);
      const { manifold, disconnected } = checkTopology(mesh);
      expect(manifold.passed).toBe(true);
      expect(disconnected.passed).toBe(true);
      expect(disconnected.fragmentCount).toBe(1);
      // A closed shell around a sheet gyroid encloses the lattice's void networks.
      expect(disconnected.voidCount).toBeGreaterThan(0);
      expect(topologyWarnings(disconnected, DEFAULT_PARAMS)[0]).toMatch(/enclosed void network/);
    },
  );

  it('escape holes join the voids to the outside so no void warning remains', () => {
    const params = { ...DEFAULT_PARAMS, escapeHoles: true };
    const { disconnected } = checkTopology(sampleField('sphere', params));
    expect(disconnected).toMatchObject({ passed: true, fragmentCount: 1 });
    expect(topologyWarnings(disconnected, params).some((w) => w.includes('trapped'))).toBe(false);
  });
});
