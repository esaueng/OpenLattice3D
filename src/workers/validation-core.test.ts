import { describe, expect, it } from 'vitest';
import { marchingCubes, type MarchingCubesResult } from '../geometry/marching-cubes';
import { SAMPLE_SHAPE_DIMENSIONS } from '../geometry/sample-shapes';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import type { Vec3 } from '../geometry/vec3';
import { DEFAULT_PARAMS, type SampleShape } from '../types/project';
import {
  sampleShapeFields,
  unpackSurfaceSamples,
  validateGeneratedResult,
  type ValidationWorkerMessage,
} from './validation-core';

const SHAPES: SampleShape[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule'];
const SEED = 7;
const params = DEFAULT_PARAMS;

function bounds(shape: SampleShape): { min: Vec3; max: Vec3 } {
  const pad = params.cellSize * 0.5;
  switch (shape) {
    case 'sphere': return { min: [-25 - pad, -25 - pad, -25 - pad], max: [25 + pad, 25 + pad, 25 + pad] };
    case 'cube': {
      const e = SAMPLE_SHAPE_DIMENSIONS.cube.halfSize + pad;
      return { min: [-e, -e, -e], max: [e, e, e] };
    }
    case 'cylinder': return { min: [-15 - pad, -15 - pad, -20 - pad], max: [15 + pad, 15 + pad, 20 + pad] };
    case 'torus': return { min: [-28 - pad, -28 - pad, -8 - pad], max: [28 + pad, 28 + pad, 8 + pad] };
    case 'capsule': return { min: [-12 - pad, -12 - pad, -27 - pad], max: [12 + pad, 12 + pad, 27 + pad] };
  }
}

const meshes = new Map<SampleShape, MarchingCubesResult>();
function generated(shape: SampleShape): MarchingCubesResult {
  let mesh = meshes.get(shape);
  if (!mesh) {
    mesh = marchingCubes(sampleShapeFields(shape, 25, SEED).latticeSdf(params), bounds(shape), 48);
    meshes.set(shape, mesh);
  }
  return mesh;
}

function message(shape: SampleShape | null, mesh: MarchingCubesResult, overrides: Partial<ValidationWorkerMessage> = {}): ValidationWorkerMessage {
  return {
    type: 'validate',
    positions: mesh.positions,
    normals: mesh.normals,
    triCount: mesh.triCount,
    params,
    generationSeed: SEED,
    sphereMode: false,
    sphereRadius: 25,
    sampleShape: shape,
    ...overrides,
  };
}

function translated(mesh: MarchingCubesResult, offset: Vec3): MarchingCubesResult {
  const positions = mesh.positions.slice();
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] += offset[0];
    positions[i + 1] += offset[1];
    positions[i + 2] += offset[2];
  }
  return { ...mesh, positions };
}

describe('procedural validation measures outer deviation for every sample shape', () => {
  it.each(SHAPES)('%s: the generated lattice is measured and within tolerance', (shape) => {
    const validation = validateGeneratedResult(message(shape, generated(shape)));
    expect(validation.outerDeviation.sampled).toBeGreaterThan(0);
    expect(validation.outerDeviation.passed).toBe(true);
    expect(validation.outerDeviation.maxDeviation).toBeLessThanOrEqual(params.toleranceMm);
    expect(validation.outerDeviation.tolerance).toBe(params.toleranceMm);
  });

  it.each(SHAPES)('%s: a result poking 2x the tolerance outside the object fails', (shape) => {
    // Shift along +x: the +x extreme of every shape moves out by the full offset.
    const shift = 2 * params.toleranceMm;
    const validation = validateGeneratedResult(message(shape, translated(generated(shape), [shift, 0, 0])));
    expect(validation.outerDeviation.passed).toBe(false);
    expect(validation.outerDeviation.maxDeviation).toBeGreaterThan(params.toleranceMm);
    expect(validation.passed).toBe(false);
  });

  it('keeps legacy sphere mode (no sample shape) on the sphere envelope', () => {
    const mesh = generated('sphere');
    const legacy = validateGeneratedResult(message(null, mesh, { sphereMode: true }));
    const current = validateGeneratedResult(message('sphere', mesh));
    expect(legacy.outerDeviation).toEqual(current.outerDeviation);
  });

  it('reports an empty result as unmeasured with a warning, not a 0 mm pass', () => {
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 };
    const validation = validateGeneratedResult(message('torus', empty));
    expect(validation.outerDeviation).toMatchObject({ passed: false, sampled: 0 });
    expect(validation.warnings).toContain('Outer deviation could not be measured');
    expect(validation.passed).toBe(false);
  });

  it('forwards thickness progress', () => {
    const fractions: number[] = [];
    validateGeneratedResult(message('cube', generated('cube')), (fraction) => fractions.push(fraction));
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions.every((fraction) => fraction > 0 && fraction <= 1)).toBe(true);
  });

  it('measures imported meshes against the reference BVH', () => {
    const reference = generateCubeMesh(20);
    const validation = validateGeneratedResult(message(null, translated(reference, [0.5, 0, 0]), {
      meshPositions: reference.positions,
      meshNormals: reference.normals,
      meshTriCount: reference.triCount,
    }));
    expect(validation.outerDeviation.passed).toBe(false);
    expect(validation.outerDeviation.maxDeviation).toBeGreaterThan(params.toleranceMm);
    expect(validation.outerDeviation.sampled).toBeGreaterThan(0);
  });

  it('reports an empty imported-mesh result as unmeasured, like the sample-shape path', () => {
    const reference = generateCubeMesh(20);
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 };
    const imported = validateGeneratedResult(message(null, empty, {
      meshPositions: reference.positions,
      meshNormals: reference.normals,
      meshTriCount: reference.triCount,
    }));
    const procedural = validateGeneratedResult(message('cube', empty));
    expect(imported.outerDeviation).toEqual(procedural.outerDeviation);
    expect(imported.outerDeviation).toMatchObject({ passed: false, maxDeviation: 0, sampled: 0 });
    expect(imported.warnings).toContain('Outer deviation could not be measured');
    expect(imported.passed).toBe(false);
  });

  it('rejects a mesh-path request without the reference mesh', () => {
    expect(() => validateGeneratedResult(message(null, generated('cube')))).toThrow(/original mesh or a sample shape/);
  });
});

describe('unpackSurfaceSamples', () => {
  it('unpacks positions, normals and optional hole scales', () => {
    const samples = unpackSurfaceSamples(
      new Float32Array([1, 2, 3, 4, 5, 6]),
      new Float32Array([0, 0, 1, 1, 0, 0]),
      new Float32Array([0.5, 1]),
    );
    expect(samples).toEqual([
      { pos: [1, 2, 3], normal: [0, 0, 1], holeScale: 0.5 },
      { pos: [4, 5, 6], normal: [1, 0, 0], holeScale: 1 },
    ]);
    expect(unpackSurfaceSamples(undefined, new Float32Array(3))).toEqual([]);
  });
});
