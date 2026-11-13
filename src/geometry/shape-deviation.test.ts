import { describe, expect, it } from 'vitest';
import { marchingCubes, type MarchingCubesResult } from './marching-cubes';
import { SAMPLE_SHAPE_DIMENSIONS, sampleShapeObjectSdf, type ObjectSdf } from './sample-shapes';
import { checkAnalyticOuterDeviation } from './shape-deviation';
import { checkSphereDeviation } from './validation';
import type { SampleShape } from '../types/project';
import type { Vec3 } from './vec3';

const SHAPES: SampleShape[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule'];
const TOLERANCE = 0.2;
const SPHERE_RADIUS = 25;

function shapeBounds(shape: SampleShape): { min: Vec3; max: Vec3 } {
  const pad = 2;
  switch (shape) {
    case 'sphere': {
      const e = SPHERE_RADIUS + pad;
      return { min: [-e, -e, -e], max: [e, e, e] };
    }
    case 'cube': {
      const e = SAMPLE_SHAPE_DIMENSIONS.cube.halfSize + pad;
      return { min: [-e, -e, -e], max: [e, e, e] };
    }
    case 'cylinder': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.cylinder;
      return { min: [-radius - pad, -radius - pad, -halfHeight - pad], max: [radius + pad, radius + pad, halfHeight + pad] };
    }
    case 'torus': {
      const { majorRadius, tubeRadius } = SAMPLE_SHAPE_DIMENSIONS.torus;
      const xy = majorRadius + tubeRadius + pad;
      return { min: [-xy, -xy, -tubeRadius - pad], max: [xy, xy, tubeRadius + pad] };
    }
    case 'capsule': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.capsule;
      const ext = radius + halfHeight + pad;
      return { min: [-radius - pad, -radius - pad, -ext], max: [radius + pad, radius + pad, ext] };
    }
  }
}

/** Unit gradient of the field by central differences. */
function gradient(sdf: ObjectSdf, x: number, y: number, z: number): Vec3 {
  const h = 1e-4;
  const g: Vec3 = [
    sdf(x + h, y, z) - sdf(x - h, y, z),
    sdf(x, y + h, z) - sdf(x, y - h, z),
    sdf(x, y, z + h) - sdf(x, y, z - h),
  ];
  const n = Math.hypot(g[0], g[1], g[2]) || 1;
  return [g[0] / n, g[1] / n, g[2] / n];
}

/** Move every vertex along the field normal by `distance` mm (positive = outward). */
function offsetMesh(mesh: MarchingCubesResult, sdf: ObjectSdf, distance: number): MarchingCubesResult {
  const positions = new Float32Array(mesh.positions.length);
  for (let i = 0; i < mesh.triCount * 3; i++) {
    const o = i * 3;
    const x = mesh.positions[o], y = mesh.positions[o + 1], z = mesh.positions[o + 2];
    const n = gradient(sdf, x, y, z);
    positions[o] = x + n[0] * distance;
    positions[o + 1] = y + n[1] * distance;
    positions[o + 2] = z + n[2] * distance;
  }
  return { positions, normals: mesh.normals, triCount: mesh.triCount };
}

function concat(a: MarchingCubesResult, b: MarchingCubesResult): MarchingCubesResult {
  const positions = new Float32Array(a.positions.length + b.positions.length);
  positions.set(a.positions);
  positions.set(b.positions, a.positions.length);
  const normals = new Float32Array(a.normals.length + b.normals.length);
  normals.set(a.normals);
  normals.set(b.normals, a.normals.length);
  return { positions, normals, triCount: a.triCount + b.triCount };
}

const surfaces = new Map<SampleShape, MarchingCubesResult>();
function shapeSurface(shape: SampleShape): MarchingCubesResult {
  let mesh = surfaces.get(shape);
  if (!mesh) {
    mesh = marchingCubes(sampleShapeObjectSdf(shape, SPHERE_RADIUS), shapeBounds(shape), 64);
    surfaces.set(shape, mesh);
  }
  return mesh;
}

describe('sample shape object SDFs', () => {
  const cases: Array<[SampleShape, Vec3, number]> = [
    ['sphere', [25, 0, 0], 0],
    ['sphere', [0, 0, 27], 2],
    ['sphere', [0, 0, 0], -25],
    ['cube', [15, 3, -4], 0],
    ['cube', [17, 0, 0], 2],
    ['cube', [18, 19, 15], 5],
    ['cube', [0, 0, 0], -15],
    ['cylinder', [15, 0, 5], 0],
    ['cylinder', [0, 0, 22], 2],
    ['cylinder', [0, 18, 0], 3],
    ['torus', [28, 0, 0], 0],
    ['torus', [0, 12, 0], 0],
    ['torus', [20, 0, 10], 2],
    ['torus', [0, 0, 0], 12],
    ['capsule', [0, 0, 27], 0],
    ['capsule', [12, 0, 10], 0],
    ['capsule', [14, 0, 0], 2],
    ['capsule', [0, 0, 30], 3],
  ];
  it.each(cases)('%s at %j is %f mm', (shape, [x, y, z], expected) => {
    expect(sampleShapeObjectSdf(shape, SPHERE_RADIUS)(x, y, z)).toBeCloseTo(expected, 9);
  });

  it('falls back to the default sphere radius when unset', () => {
    expect(sampleShapeObjectSdf('sphere', 0)(25, 0, 0)).toBeCloseTo(0, 9);
  });
});

describe('checkAnalyticOuterDeviation', () => {
  it.each(SHAPES)('%s: a mesh on the object surface passes', (shape) => {
    const sdf = sampleShapeObjectSdf(shape, SPHERE_RADIUS);
    const result = checkAnalyticOuterDeviation(shapeSurface(shape), sdf, TOLERANCE);
    expect(result.sampled).toBeGreaterThan(0);
    expect(result.passed).toBe(true);
    expect(result.maxDeviation).toBeLessThan(TOLERANCE / 4);
  });

  it.each(SHAPES)('%s: a mesh offset outward by 2x the tolerance fails', (shape) => {
    const sdf = sampleShapeObjectSdf(shape, SPHERE_RADIUS);
    const result = checkAnalyticOuterDeviation(offsetMesh(shapeSurface(shape), sdf, 2 * TOLERANCE), sdf, TOLERANCE);
    expect(result.sampled).toBeGreaterThan(0);
    expect(result.passed).toBe(false);
    expect(result.maxDeviation).toBeGreaterThan(1.75 * TOLERANCE);
    expect(result.maxDeviation).toBeLessThan(2.25 * TOLERANCE);
  });

  it.each(SHAPES)('%s: interior lattice walls do not count as deviation', (shape) => {
    const sdf = sampleShapeObjectSdf(shape, SPHERE_RADIUS);
    const surface = shapeSurface(shape);
    // An inner wall 3 mm below the skin stands in for the lattice core.
    const result = checkAnalyticOuterDeviation(concat(surface, offsetMesh(surface, sdf, -3)), sdf, TOLERANCE);
    expect(result.passed).toBe(true);
    expect(result.maxDeviation).toBeLessThan(TOLERANCE / 4);
  });

  it('measures only material outside the envelope (one-sided, like the sphere and mesh checks)', () => {
    const sdf = sampleShapeObjectSdf('cube', SPHERE_RADIUS);
    const result = checkAnalyticOuterDeviation(offsetMesh(shapeSurface('cube'), sdf, -2 * TOLERANCE), sdf, TOLERANCE);
    expect(result).toMatchObject({ passed: true, maxDeviation: 0 });
    expect(result.sampled).toBeGreaterThan(0);
  });

  it('matches the sphere fast path on the sphere', () => {
    const sdf = sampleShapeObjectSdf('sphere', SPHERE_RADIUS);
    const mesh = offsetMesh(shapeSurface('sphere'), sdf, 2 * TOLERANCE);
    const generic = checkAnalyticOuterDeviation(mesh, sdf, TOLERANCE);
    const sphere = checkSphereDeviation(mesh, SPHERE_RADIUS, TOLERANCE);
    expect(generic.passed).toBe(sphere.passed);
    expect(generic.maxDeviation).toBeCloseTo(sphere.maxDeviation, 9);
  });

  it('reports an empty mesh as not measured instead of a 0 mm pass', () => {
    const sdf = sampleShapeObjectSdf('cube', SPHERE_RADIUS);
    const empty = { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 };
    expect(checkAnalyticOuterDeviation(empty, sdf, TOLERANCE)).toEqual({ passed: false, maxDeviation: 0, sampled: 0 });
  });

  it('reports a field with no finite samples as not measured', () => {
    const result = checkAnalyticOuterDeviation(shapeSurface('cube'), () => Number.NaN, TOLERANCE);
    expect(result).toEqual({ passed: false, maxDeviation: 0, sampled: 0 });
  });

  it('never reads past the position buffer when triCount overstates it', () => {
    const sdf = sampleShapeObjectSdf('cube', SPHERE_RADIUS);
    const surface = shapeSurface('cube');
    const truncated = { ...surface, triCount: surface.triCount + 10 };
    const result = checkAnalyticOuterDeviation(truncated, sdf, TOLERANCE, Number.POSITIVE_INFINITY);
    expect(result.sampled).toBe(surface.triCount);
    expect(result.passed).toBe(true);
  });
});
