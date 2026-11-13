import { describe, expect, it } from 'vitest';
import {
  checkMinThickness,
  checkSphereDeviation,
  FDM_OPEN_LATTICE_WARNING,
  NO_DEVIATION_REFERENCE_WARNING,
  OUTER_DEVIATION_UNMEASURED_WARNING,
  runValidation,
  THICKNESS_UNMEASURED_WARNING,
  topologyWarnings,
} from './validation';
import { DEFAULT_PARAMS } from '../types/project';
import type { MarchingCubesResult } from './marching-cubes';

function planarSurface(x: number): MarchingCubesResult {
  return {
    positions: new Float32Array([
      x, -1, -1,
      x, 1, -1,
      x, 0, 2,
    ]),
    // Deliberately wrong: thickness must come from the field gradient.
    normals: new Float32Array([-1, 0, 0]),
    triCount: 1,
  };
}

function slabMesh(thickness: number, side = 20): MarchingCubesResult {
  const x = thickness * 0.5;
  const halfSide = side * 0.5;
  const vertices = [
    [-x, -halfSide, -halfSide], [x, -halfSide, -halfSide], [x, halfSide, -halfSide], [-x, halfSide, -halfSide],
    [-x, -halfSide, halfSide], [x, -halfSide, halfSide], [x, halfSide, halfSide], [-x, halfSide, halfSide],
  ];
  const faces = [
    [0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2],
    [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5],
  ];
  return {
    positions: new Float32Array(faces.flatMap((face) => face.flatMap((vertex) => vertices[vertex]))),
    normals: new Float32Array(faces.length * 3),
    triCount: faces.length,
  };
}

describe('minimum-thickness validation against known solids', () => {
  it.each([0.3, 0.6, 1, 1.5, 2, 3])('measures a %fmm slab continuously', (thickness) => {
    const sdf = (x: number) => Math.abs(x) - thickness * 0.5;
    const result = checkMinThickness(sdf, planarSurface(thickness * 0.5), 0.8, 1);
    expect(result.minMeasured).toBeCloseTo(thickness, 5);
    expect(result.absoluteMin).toBeCloseTo(thickness, 5);
    expect(result.sampled).toBe(1);
    expect(result.passed).toBe(thickness >= 0.8 - 1e-3);
  });

  it('measures the same geometry independently of the requested threshold', () => {
    const thickness = 1;
    const sdf = (x: number) => Math.abs(x) - thickness * 0.5;
    for (const required of [0.5, 0.8, 1, 1.5]) {
      const result = checkMinThickness(sdf, planarSurface(thickness * 0.5), required, 1);
      expect(result.minMeasured).toBeCloseTo(thickness, 5);
      expect(result.passed).toBe(thickness >= required - 1e-3);
    }
  });

  it.each([4, 10])('measures a closed %fmm slab beyond four times the minimum', (thickness) => {
    const sdf = (x: number, y: number, z: number) => Math.max(Math.abs(x) - thickness * 0.5, Math.abs(y) - 10, Math.abs(z) - 10);
    const mesh = slabMesh(thickness);
    for (const required of [0.2, 0.8, 1]) {
      const result = checkMinThickness(sdf, mesh, required, mesh.triCount);
      expect(result.sampled).toBe(mesh.triCount);
      expect(result.minMeasured).toBeCloseTo(thickness, 5);
      expect(result.absoluteMin).toBeCloseTo(thickness, 5);
      expect(result.passed).toBe(true);
    }
  });

  it('fails when one measured ray is thinner than the requirement', () => {
    const thicknesses = [0.1, ...Array.from({ length: 99 }, () => 1)];
    const positions = new Float32Array(thicknesses.length * 9);
    for (let index = 0; index < thicknesses.length; index++) {
      const x = thicknesses[index] * 0.5;
      const y = index === 0 ? -2 : 2;
      positions.set([x, y, -1, x, y + 0.5, -1, x, y + 0.25, 1], index * 9);
    }
    const result: MarchingCubesResult = {
      positions,
      normals: new Float32Array(thicknesses.length * 3),
      triCount: thicknesses.length,
    };
    const sdf = (x: number, y: number) => Math.abs(x) - (y < 0 ? 0.05 : 0.5);

    const measured = checkMinThickness(sdf, result, 0.8, thicknesses.length);
    expect(measured.minMeasured).toBeCloseTo(1, 5);
    expect(measured.absoluteMin).toBeCloseTo(0.1, 5);
    expect(measured.passed).toBe(false);
  });
});

describe('unmeasurable thickness', () => {
  it('fails topology, connectivity, and overall validation for an empty mesh', () => {
    const result = runValidation(
      { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 },
      () => 1, DEFAULT_PARAMS, null, 25,
    );
    expect(result.passed).toBe(false);
    expect(result.manifold.passed).toBe(false);
    expect(result.manifold.details).toMatch(/empty/);
    expect(result.disconnected).toEqual({ passed: false, fragmentCount: 0, voidCount: 0, sliverCount: 0 });
    expect(result.minThickness.passed).toBe(false);
    expect(result.warnings).toContain('Minimum thickness could not be measured');
    expect(result.warningDetails).toContainEqual({ code: 'thickness-unmeasured', message: THICKNESS_UNMEASURED_WARNING });
  });

  it('fails without inventing thickness when no usable ray is found', () => {
    const result = checkMinThickness(() => 1, planarSurface(0), 0.8);
    expect(result).toEqual({ passed: false, minMeasured: 0, absoluteMin: 0, sampled: 0, thinPoints: [] });
  });

  it('bounds work on a large solid and leaves exhausted rays unmeasured', () => {
    const mesh = slabMesh(1000, 1000);
    let fieldCalls = 0;
    const result = checkMinThickness((x, y, z) => {
      fieldCalls++;
      return Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) - 500;
    }, mesh, 0.8, mesh.triCount);
    expect(result).toEqual({ passed: false, minMeasured: 0, absoluteMin: 0, sampled: 0, thinPoints: [] });
    expect(fieldCalls).toBeLessThan(mesh.triCount * 10_000);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MIN_VALUE])('fails closed for an unusable minimum %s', (required) => {
    const result = checkMinThickness((x) => Math.abs(x) - 1, planarSurface(1), required);
    expect(result).toEqual({ passed: false, minMeasured: 0, absoluteMin: 0, sampled: 0, thinPoints: [] });
  });

  it('does not turn a nonfinite field interval into a measured crossing', () => {
    const result = checkMinThickness((x) => x < -1 ? Number.NaN : Math.abs(x) - 2, slabMesh(4), 0.8);
    expect(result.sampled).toBe(0);
    expect(result.passed).toBe(false);
  });
});

describe('thin feature reporting', () => {
  it('records where thin rays started and reports sampling progress', () => {
    const progress: number[] = [];
    const slab = planarSurface(0.05);
    const measured = checkMinThickness((x) => Math.abs(x) - 0.05, slab, 0.8, 1, (f) => progress.push(f));
    expect(measured.passed).toBe(false);
    expect(measured.thinPoints.length).toBeGreaterThan(0);
    expect(measured.thinPoints.length % 3).toBe(0);
    expect(measured.thinPoints.length).toBeLessThanOrEqual(400 * 3);
    if (slab.triCount >= 64) expect(progress.length).toBeGreaterThan(0);
  });
});

describe('outer deviation without a usable reference', () => {
  const slabSdf = (x: number) => Math.abs(x) - 1;

  it('reports a missing reference as not measured, never as a 0 mm pass', () => {
    const result = runValidation(slabMesh(2), slabSdf, DEFAULT_PARAMS, null, null);
    expect(result.outerDeviation).toEqual({
      passed: false,
      maxDeviation: 0,
      sampled: 0,
      tolerance: DEFAULT_PARAMS.toleranceMm,
    });
    expect(result.passed).toBe(false);
    expect(result.warnings).toContain(NO_DEVIATION_REFERENCE_WARNING);
    expect(result.warnings).not.toContain(OUTER_DEVIATION_UNMEASURED_WARNING);
    expect(result.warningDetails).toContainEqual({ code: 'no-deviation-reference', message: NO_DEVIATION_REFERENCE_WARNING });
    expect(result.warningDetails?.map((warning) => warning.code)).not.toContain('deviation-unmeasured');
  });

  it('reports an empty result measured against a sphere as unmeasured', () => {
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 };
    const result = runValidation(empty, () => 1, DEFAULT_PARAMS, null, 25);
    expect(result.outerDeviation).toMatchObject({ passed: false, maxDeviation: 0, sampled: 0 });
    expect(result.warnings).toContain(OUTER_DEVIATION_UNMEASURED_WARNING);
    expect(result.warnings).not.toContain(NO_DEVIATION_REFERENCE_WARNING);
    expect(result.warningDetails).toContainEqual({ code: 'deviation-unmeasured', message: OUTER_DEVIATION_UNMEASURED_WARNING });
    expect(result.warningDetails?.map((warning) => warning.code)).not.toContain('no-deviation-reference');
  });

  it('counts the samples a sphere deviation check measured', () => {
    // Every centroid of the 2 mm slab lies within 25 mm of the origin.
    const measured = checkSphereDeviation(slabMesh(2), 25, 0.1);
    expect(measured).toEqual({ passed: true, maxDeviation: 0, sampled: 12 });
    const outside = checkSphereDeviation(slabMesh(2), 1, 0.1);
    expect(outside.sampled).toBe(12);
    expect(outside.passed).toBe(false);
    expect(outside.maxDeviation).toBeGreaterThan(1);
  });
});

describe('coded validation warnings', () => {
  const counts = (fragmentCount: number, voidCount: number, sliverCount: number) => ({ fragmentCount, voidCount, sliverCount });

  it('codes each topology warning', () => {
    expect(topologyWarnings(counts(3, 0, 0), DEFAULT_PARAMS)).toEqual([
      { code: 'multiple-bodies', message: '3 separate solid bodies detected' },
    ]);
    expect(topologyWarnings(counts(1, 2, 0), DEFAULT_PARAMS)).toEqual([
      { code: 'trapped-voids', message: '2 enclosed void networks and no escape holes: trapped powder/resin likely' },
    ]);
    expect(topologyWarnings(counts(1, 2, 0), { ...DEFAULT_PARAMS, escapeHoles: true })).toEqual([]);
    expect(topologyWarnings(counts(1, 0, 1), DEFAULT_PARAMS)).toEqual([
      { code: 'zero-volume-slivers', message: '1 zero-volume sliver (negligible, but present in the export)' },
    ]);
  });

  it('codes the FDM open-lattice warning', () => {
    const fdm = { ...DEFAULT_PARAMS, processPreset: 'FDM' as const, variant: 'implicit_conformal' as const };
    const result = runValidation(slabMesh(2), (x) => Math.abs(x) - 1, fdm, null, 25);
    expect(result.warningDetails).toContainEqual({ code: 'fdm-open-lattice', message: FDM_OPEN_LATTICE_WARNING });
  });

  it('keeps the plain warnings identical to the coded messages, in order', () => {
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 };
    const fdm = { ...DEFAULT_PARAMS, processPreset: 'FDM' as const, variant: 'implicit_conformal' as const };
    const result = runValidation(empty, () => 1, fdm, null, null);
    expect(result.warningDetails?.map((warning) => warning.code)).toEqual([
      'no-deviation-reference',
      'thickness-unmeasured',
      'fdm-open-lattice',
    ]);
    expect(result.warnings).toEqual(result.warningDetails?.map((warning) => warning.message));
  });
});
