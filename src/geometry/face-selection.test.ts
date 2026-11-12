import { describe, expect, it } from 'vitest';
import { FACE_DIRECTIONS, facesFacingDirection, type FaceDirection } from './face-selection';
import { generateCubeMesh, generateSphereMesh } from './mesh-analysis';
import type { TriangleMesh } from './stl-parser';

function triangleNormalZ(mesh: TriangleMesh, t: number): number {
  const p = mesh.positions;
  const o = t * 9;
  const e1 = [p[o + 3] - p[o], p[o + 4] - p[o + 1]];
  const e2 = [p[o + 6] - p[o], p[o + 7] - p[o + 1]];
  return e1[0] * e2[1] - e1[1] * e2[0];
}

describe('facesFacingDirection', () => {
  it('splits a cube into its six faces, two triangles each', () => {
    const cube = generateCubeMesh(20);
    const seen = new Set<number>();
    for (const key of Object.keys(FACE_DIRECTIONS) as FaceDirection[]) {
      const faces = facesFacingDirection(cube, FACE_DIRECTIONS[key].vector, 10);
      expect(faces, key).toHaveLength(2);
      for (const face of faces) {
        expect(seen.has(face)).toBe(false);
        seen.add(face);
      }
    }
    expect(seen.size).toBe(cube.triCount);
  });

  it('selects the top faces by their winding, regardless of stored normals', () => {
    const cube = generateCubeMesh(10);
    const stale: TriangleMesh = { ...cube, normals: new Float32Array(cube.normals.length) };
    const top = facesFacingDirection(stale, [0, 0, 1], 5);
    expect(top).toHaveLength(2);
    for (const t of top) expect(triangleNormalZ(stale, t)).toBeGreaterThan(0);
  });

  it('grows with the angle tolerance on a curved surface', () => {
    const sphere = generateSphereMesh(25, 32);
    const narrow = facesFacingDirection(sphere, [0, 0, 1], 15);
    const wide = facesFacingDirection(sphere, [0, 0, 1], 45);
    expect(narrow.length).toBeGreaterThan(0);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(wide.length).toBeLessThan(sphere.triCount / 2);
    // A hemisphere's worth at 90°, never the faces pointing away.
    const half = facesFacingDirection(sphere, [0, 0, 1], 90);
    const bottom = facesFacingDirection(sphere, [0, 0, -1], 30);
    expect(bottom.some((t) => half.includes(t))).toBe(false);
  });

  it('ignores degenerate triangles and invalid directions', () => {
    const mesh: TriangleMesh = {
      positions: Float32Array.from([0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array(6),
      triCount: 2,
    };
    expect(facesFacingDirection(mesh, [0, 0, 1], 10)).toEqual([1]);
    expect(facesFacingDirection(mesh, [0, 0, 0], 10)).toEqual([]);
    expect(facesFacingDirection(mesh, [0, 0, 1], Number.NaN)).toEqual([]);
  });

  it('is unit-independent: scaling the mesh selects the same faces', () => {
    const small = generateSphereMesh(0.5, 16);
    const large = generateSphereMesh(500, 16);
    expect(facesFacingDirection(small, [1, 0, 0], 30)).toEqual(facesFacingDirection(large, [1, 0, 0], 30));
  });
});
