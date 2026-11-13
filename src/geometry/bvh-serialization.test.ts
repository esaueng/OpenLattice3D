import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import {
  clonePackedMeshBVH,
  packSerializedMeshBVH,
  unpackSerializedMeshBVH,
} from './bvh-serialization';
import { createDeterministicRandom } from './deterministic-random';
import { generateCubeMesh } from './mesh-analysis';
import { parseSTL } from './stl-parser';
import type { Vec3 } from './vec3';

function loadStlBvh(name: string): MeshBVH {
  const source = readFileSync(new URL(`../../public/assets/${name}`, import.meta.url));
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  const mesh = parseSTL(buffer);
  return new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
}

/** Query points around and inside the mesh, plus points exactly on its vertices and edges. */
function queryPoints(bvh: MeshBVH, count: number): Vec3[] {
  const random = createDeterministicRandom(7, 'bvh-serialization-test');
  const { min, max } = bvh.getBounds();
  const points: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    points.push([0, 1, 2].map((axis) => {
      const span = max[axis] - min[axis];
      return min[axis] - span * 0.3 + random() * span * 1.6;
    }) as Vec3);
  }
  const positions = bvh.serialize().positions;
  for (let i = 0; i + 8 < Math.min(positions.length, 9 * 64); i += 9) {
    points.push([positions[i], positions[i + 1], positions[i + 2]]);
    points.push([
      (positions[i] + positions[i + 3]) / 2,
      (positions[i + 1] + positions[i + 4]) / 2,
      (positions[i + 2] + positions[i + 5]) / 2,
    ]);
  }
  return points;
}

function expectBitIdentical(source: MeshBVH, restored: MeshBVH, points: Vec3[]): void {
  for (const p of points) {
    const a = source.signedDistance(p);
    const b = restored.signedDistance(p);
    if (!Object.is(a, b)) expect.fail(`signedDistance differs at ${p}: ${a} vs ${b}`);
    const ca = source.closestPoint(p);
    const cb = restored.closestPoint(p);
    if (
      !Object.is(ca.distance, cb.distance)
      || ca.triIndex !== cb.triIndex
      || !ca.point.every((value, axis) => Object.is(value, cb.point[axis]))
    ) {
      expect.fail(`closestPoint differs at ${p}`);
    }
    if (!Object.is(source.closestDistance(p[0], p[1], p[2]), restored.closestDistance(p[0], p[1], p[2]))) {
      expect.fail(`closestDistance differs at ${p}`);
    }
  }
}

describe('MeshBVH serialization', () => {
  it.each(['sphere-25mm.stl', 'cube-30mm.stl'])(
    'restores %s with bit-identical queries over shared and transferred buffers',
    (name) => {
      const source = loadStlBvh(name);
      const points = queryPoints(source, 4000);
      for (const shared of [true, false]) {
        const packed = packSerializedMeshBVH(source.serialize(), shared);
        expect(packed.buffer instanceof SharedArrayBuffer).toBe(shared);
        const restored = MeshBVH.fromSerialized(unpackSerializedMeshBVH(packed));
        expect(restored.triCount).toBe(source.triCount);
        expect(restored.getBounds()).toEqual(source.getBounds());
        expectBitIdentical(source, restored, points);
      }
    },
  );

  it('builds pseudonormals eagerly so a restored copy never recomputes them', () => {
    const cube = generateCubeMesh(20);
    const source = new MeshBVH(cube.positions, cube.normals, cube.triCount);
    // No signed query has run yet; serialize must still carry the tables.
    const data = source.serialize();
    expect(data.triVertex.length).toBe(cube.triCount * 3);
    expect(data.vertexNormals.length).toBe(8 * 3);
    expect(data.edgeNormals.length).toBe(18 * 3);
    const restored = MeshBVH.fromSerialized(unpackSerializedMeshBVH(
      clonePackedMeshBVH(packSerializedMeshBVH(data, false)),
    ));
    expectBitIdentical(source, restored, queryPoints(source, 500));
  });

  it('restored subsets match subsets of the source', () => {
    const source = loadStlBvh('sphere-25mm.stl');
    const restored = MeshBVH.fromSerialized(unpackSerializedMeshBVH(packSerializedMeshBVH(source.serialize(), true)));
    const picked = Array.from({ length: 200 }, (_, i) => i * 7);
    const a = source.subset(picked)!;
    const b = restored.subset(picked)!;
    for (const p of queryPoints(source, 300)) {
      expect(Object.is(a.closestDistance(p[0], p[1], p[2]), b.closestDistance(p[0], p[1], p[2]))).toBe(true);
    }
  });

  it('rejects packed buffers that do not match their layout', () => {
    const packed = packSerializedMeshBVH(loadStlBvh('cube-30mm.stl').serialize(), false);
    expect(() => unpackSerializedMeshBVH({ ...packed, lengths: packed.lengths.slice(1) })).toThrow(/layout/);
    const lengths = [...packed.lengths];
    lengths[0] += 3;
    expect(() => unpackSerializedMeshBVH({ ...packed, lengths })).toThrow(/does not match/);
    const truncated = [...packed.lengths];
    truncated[2] -= 3; // nodeMin shorter than the node count implies
    truncated[3] += 3;
    expect(() => MeshBVH.fromSerialized(unpackSerializedMeshBVH({ ...packed, lengths: truncated }))).toThrow(/do not match/);
  });
});
