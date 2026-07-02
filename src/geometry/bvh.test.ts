import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import { generateCubeMesh, generateSphereMesh } from './mesh-analysis';

describe('MeshBVH', () => {
  it('rejects empty meshes', () => {
    expect(() => new MeshBVH(new Float32Array(0), new Float32Array(0), 0)).toThrow(/at least one triangle/);
  });

  it('rejects buffers smaller than triCount requires', () => {
    expect(() => new MeshBVH(new Float32Array(9), new Float32Array(3), 2)).toThrow(/smaller than triCount/);
  });

  it('computes closest points on a cube', () => {
    const cube = generateCubeMesh(20); // half size 10
    const bvh = new MeshBVH(cube.positions, cube.normals, cube.triCount);

    const onFace = bvh.closestPoint([15, 0, 0]);
    expect(onFace.distance).toBeCloseTo(5, 5);
    expect(onFace.point[0]).toBeCloseTo(10, 5);

    const inside = bvh.closestPoint([0, 0, 0]);
    expect(inside.distance).toBeCloseTo(10, 5);
  });

  it('computes signed distance with correct sign', () => {
    const cube = generateCubeMesh(20);
    const bvh = new MeshBVH(cube.positions, cube.normals, cube.triCount);

    expect(bvh.signedDistance([15, 0, 0])).toBeCloseTo(5, 5);
    expect(bvh.signedDistance([0, 0, 0])).toBeCloseTo(-10, 5);
    expect(bvh.signedDistance([0, 0, -12])).toBeCloseTo(2, 5);
  });

  it('approximates the analytic sphere SDF', () => {
    const sphere = generateSphereMesh(25, 48);
    const bvh = new MeshBVH(sphere.positions, sphere.normals, sphere.triCount);

    // Sample several directions; tessellation error at 48 segments is small.
    const dirs: [number, number, number][] = [
      [1, 0, 0], [0, 1, 0], [0, 0, 1], [0.577, 0.577, 0.577], [-0.707, 0.707, 0],
    ];
    for (const [dx, dy, dz] of dirs) {
      expect(bvh.signedDistance([dx * 30, dy * 30, dz * 30])).toBeCloseTo(5, 1);
      expect(bvh.signedDistance([dx * 20, dy * 20, dz * 20])).toBeCloseTo(-5, 1);
    }
  });
});
