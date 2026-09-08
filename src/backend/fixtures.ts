// Deterministic fixtures for the backend parity benchmark and GPU promotion
// gate. Shapes, parameters, seeds, and resolutions are fixed so runs are
// byte-reproducible across machines. See docs/performance/parity-gates.md.
import {
  buildCapsuleLattice,
  buildCubeLattice,
  buildCylinderLattice,
  buildSphereLattice,
  buildTorusLattice,
} from '../geometry/lattice';
import { DEFAULT_PARAMS, type LatticeParams, type SampleShape } from '../types/project';
import type { BackendFixture } from './types';

// Same shape constants as lattice-tile-worker.ts, so parity fixtures exercise
// exactly the fields production generates.
export function buildShapeSdf(
  shape: SampleShape,
  sphereRadius: number,
  params: LatticeParams,
  generationSeed: number,
): (x: number, y: number, z: number) => number {
  switch (shape) {
    case 'sphere': return buildSphereLattice(sphereRadius || 25, params, generationSeed);
    case 'cube': return buildCubeLattice(15, params, generationSeed);
    case 'cylinder': return buildCylinderLattice(15, 20, params, generationSeed);
    case 'torus': return buildTorusLattice(20, 8, params, generationSeed);
    case 'capsule': return buildCapsuleLattice(12, 15, params, generationSeed);
  }
}

export function buildFixtureSdf(fixture: BackendFixture): (x: number, y: number, z: number) => number {
  return buildShapeSdf(fixture.shape, fixture.sphereRadius, fixture.params, fixture.generationSeed);
}

function fixtureParams(latticeType: LatticeParams['latticeType']): LatticeParams {
  return {
    ...DEFAULT_PARAMS,
    latticeType,
    // Pure lattice without a shell keeps the iso-surface TPMS-dominated, and
    // the thin-section filter must stay off because production disables
    // tiling while the whole-volume morphological opening is active.
    noShell: true,
    shellThickness: 0,
    thinSectionFilter: 0,
    escapeHoles: false,
  };
}

const DEFAULT_SEED = 0x5eed0001;

/**
 * Parity fixtures cover the cases called out by the WebGPU design document:
 * representative shapes with TPMS fields, an empty field, and a surface that
 * crosses tile boundaries (resolution above the 32-cell tile size).
 */
export const PARITY_FIXTURES: readonly BackendFixture[] = [
  {
    name: 'sphere-gyroid',
    description: 'Sphere with gyroid sheet; the reference TPMS case',
    shape: 'sphere',
    sphereRadius: 25,
    params: fixtureParams('gyroid'),
    generationSeed: DEFAULT_SEED,
    bounds: { min: [-29, -29, -29], max: [29, 29, 29] },
    resolution: 64,
  },
  {
    name: 'cube-gyroid',
    description: 'Cube with gyroid sheet; flat faces and sharp edges',
    shape: 'cube',
    sphereRadius: 25,
    params: fixtureParams('gyroid'),
    generationSeed: DEFAULT_SEED,
    bounds: { min: [-20, -20, -20], max: [20, 20, 20] },
    resolution: 64,
  },
  {
    name: 'sphere-schwarzP',
    description: 'Sphere with Schwarz P sheet; second TPMS formula family',
    shape: 'sphere',
    sphereRadius: 25,
    params: fixtureParams('schwarzP'),
    generationSeed: DEFAULT_SEED,
    bounds: { min: [-29, -29, -29], max: [29, 29, 29] },
    resolution: 64,
  },
  {
    name: 'cylinder-iwp-tile-crossing',
    description: 'Cylinder with IWP sheet at 3 tiles per axis; the surface crosses every internal tile seam',
    shape: 'cylinder',
    sphereRadius: 25,
    params: fixtureParams('iwp'),
    generationSeed: DEFAULT_SEED,
    bounds: { min: [-24, -24, -24], max: [24, 24, 24] },
    resolution: 96,
  },
  {
    name: 'empty-field',
    description: 'Sampling volume far from the shape; every backend must emit zero triangles',
    shape: 'sphere',
    sphereRadius: 25,
    params: fixtureParams('gyroid'),
    generationSeed: DEFAULT_SEED,
    bounds: { min: [60, 60, 60], max: [84, 84, 84] },
    resolution: 48,
  },
];

/** Representative parts for warm-run benchmarking (higher resolution). */
export const BENCHMARK_FIXTURES: readonly BackendFixture[] = [
  { ...PARITY_FIXTURES[0], name: 'sphere-gyroid-bench', resolution: 160 },
  { ...PARITY_FIXTURES[2], name: 'sphere-schwarzP-bench', resolution: 160 },
];
