import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import { computeSignedVolume, flipMeshOrientation, generateCubeMesh, generateSphereMesh } from './mesh-analysis';
import type { TriangleMesh } from './stl-parser';

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
    expect(bvh.closestDistance(15, 0, 0)).toBeCloseTo(5, 5);
  });

  it('builds a distance-query BVH for selected triangles only', () => {
    const cube = generateCubeMesh(20);
    const bvh = new MeshBVH(cube.positions, cube.normals, cube.triCount);
    expect(bvh.subset([])).toBeNull();
    const subset = bvh.subset([0]);
    expect(subset).not.toBeNull();
    expect(subset!.triCount).toBe(1);
    expect(subset!.closestDistance(
      cube.positions[0],
      cube.positions[1],
      cube.positions[2],
    )).toBeCloseTo(0, 6);
  });

  it('computes signed distance with correct sign', () => {
    const cube = generateCubeMesh(20);
    const bvh = new MeshBVH(cube.positions, cube.normals, cube.triCount);

    expect(bvh.signedDistance([15, 0, 0])).toBeCloseTo(5, 5);
    expect(bvh.signedDistance([0, 0, 0])).toBeCloseTo(-10, 5);
    expect(bvh.signedDistance([0, 0, -12])).toBeCloseTo(2, 5);
  });

  it('approximates the analytic sphere SDF', () => {
    // The procedural sphere is wound inward (with outward stored normals). The
    // sign now follows winding only, so orient it as STL intake would.
    const generated = generateSphereMesh(25, 48);
    expect(computeSignedVolume(generated)).toBeLessThan(0);
    const sphere = flipMeshOrientation(generated);
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

type P3 = [number, number, number];
type Tri = [P3, P3, P3];

/** Triangle soup with stored normals derived from winding (as a clean STL carries). */
function meshFrom(tris: Tri[]): TriangleMesh {
  const positions = new Float32Array(tris.length * 9);
  const normals = new Float32Array(tris.length * 3);
  tris.forEach((tri, t) => {
    tri.forEach((p, k) => positions.set(p, t * 9 + k * 3));
    const [a, b, c] = tri;
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    normals.set([n[0] / length, n[1] / length, n[2] / length], t * 3);
  });
  return { positions, normals, triCount: tris.length };
}

/** Extrude a counter-clockwise polygon (with its cap triangulation) from z = 0 to z = height. */
function extrude(polygon: [number, number][], capTris: [number, number, number][], height: number): Tri[] {
  const bottom = (i: number): P3 => [polygon[i][0], polygon[i][1], 0];
  const top = (i: number): P3 => [polygon[i][0], polygon[i][1], height];
  const tris: Tri[] = [];
  for (const [a, b, c] of capTris) {
    tris.push([top(a), top(b), top(c)]);
    tris.push([bottom(a), bottom(c), bottom(b)]);
  }
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    tris.push([bottom(i), bottom(j), top(j)]);
    tris.push([bottom(i), top(j), top(i)]);
  }
  return tris;
}

/** Generalized winding number: an inside/outside oracle independent of the BVH. */
function isInside(mesh: TriangleMesh, p: P3): boolean {
  let solidAngle = 0;
  const pos = mesh.positions;
  for (let t = 0; t < mesh.triCount; t++) {
    const o = t * 9;
    const a = [pos[o] - p[0], pos[o + 1] - p[1], pos[o + 2] - p[2]];
    const b = [pos[o + 3] - p[0], pos[o + 4] - p[1], pos[o + 5] - p[2]];
    const c = [pos[o + 6] - p[0], pos[o + 7] - p[1], pos[o + 8] - p[2]];
    const la = Math.hypot(a[0], a[1], a[2]);
    const lb = Math.hypot(b[0], b[1], b[2]);
    const lc = Math.hypot(c[0], c[1], c[2]);
    const det = a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
    const ab = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const ac = a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
    const bc = b[0] * c[0] + b[1] * c[1] + b[2] * c[2];
    solidAngle += 2 * Math.atan2(det, la * lb * lc + ab * lc + ac * lb + bc * la);
  }
  return solidAngle / (4 * Math.PI) > 0.5;
}

/** A grid over the padded bounds (hitting face-plane extensions exactly) plus
 *  probes in 26 directions around every vertex and along every edge. */
function probePoints(mesh: TriangleMesh, step: number, radii: number[]): P3[] {
  const pos = mesh.positions;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], pos[i + axis]);
      max[axis] = Math.max(max[axis], pos[i + axis]);
    }
  }
  const points: P3[] = [];
  for (let x = min[0] - 1; x <= max[0] + 1; x += step) {
    for (let y = min[1] - 1; y <= max[1] + 1; y += step) {
      for (let z = min[2] - 1; z <= max[2] + 1; z += step) points.push([x, y, z]);
    }
  }
  const directions: P3[] = [];
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
    if (dx === 0 && dy === 0 && dz === 0) continue;
    const length = Math.hypot(dx, dy, dz);
    directions.push([dx / length, dy / length, dz / length]);
  }
  for (let t = 0; t < mesh.triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const a = t * 9 + k * 3;
      const b = t * 9 + ((k + 1) % 3) * 3;
      for (const f of [0, 0.25, 0.5]) {
        const anchor = [0, 1, 2].map(axis => pos[a + axis] + f * (pos[b + axis] - pos[a + axis]));
        for (const d of directions) {
          for (const r of radii) points.push([anchor[0] + r * d[0], anchor[1] + r * d[1], anchor[2] + r * d[2]]);
        }
      }
    }
  }
  return points;
}

/** Points whose computed sign (or magnitude) disagrees with the oracle. */
function signMismatches(mesh: TriangleMesh, bvh: MeshBVH, points: P3[]): string[] {
  const failures: string[] = [];
  for (const p of points) {
    const unsigned = bvh.closestDistance(p[0], p[1], p[2]);
    if (unsigned < 1e-4) continue; // On the surface: the sign is immaterial.
    const signed = bvh.signedDistance(p);
    const label = `[${p.map(v => v.toFixed(3)).join(', ')}] -> ${signed.toFixed(4)}`;
    if (Math.abs(Math.abs(signed) - unsigned) > 1e-9) failures.push(`magnitude ${label}`);
    if ((signed < 0) !== isInside(mesh, p)) failures.push(`sign ${label}`);
  }
  return failures;
}

function expectCorrectSigns(mesh: TriangleMesh, bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount)): void {
  const failures = signMismatches(mesh, bvh, probePoints(mesh, 0.5, [0.01, 0.2]));
  expect(failures.slice(0, 10)).toEqual([]);
}

/** Point at `distance` from `origin` along the xy-plane direction at `angle` radians. */
function polar(origin: P3, angle: number, distance: number): P3 {
  return [origin[0] + distance * Math.cos(angle), origin[1] + distance * Math.sin(angle), origin[2]];
}

const L_POLYGON: [number, number][] = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
const L_CAPS: [number, number, number][] = [[3, 4, 5], [3, 5, 0], [3, 0, 1], [3, 1, 2]];
const WEDGE_POLYGON: [number, number][] = [[0, 0], [10, 0], [10, 2]];
/** Direction pointing out of the wedge's 11.3 degree knife edge at the origin. */
const WEDGE_OUTWARD = Math.PI + Math.atan2(2, 10) / 2;
const DEG = Math.PI / 180;

describe('MeshBVH signed distance near sharp features (angle-weighted pseudonormals)', () => {
  it('signs points around every edge and vertex of a cube', () => {
    expectCorrectSigns(generateCubeMesh(20));
  });

  it('signs points just outside the sharp convex edges of a tetrahedron', () => {
    // Regular tetrahedron: 70.5 degree dihedrals, so just outside an edge near
    // one face's side, the other face's normal points away from the query.
    const v: P3[] = [[5, 5, 5], [5, -5, -5], [-5, 5, -5], [-5, -5, 5]];
    const mesh = meshFrom([[v[0], v[1], v[2]], [v[0], v[3], v[1]], [v[0], v[2], v[3]], [v[1], v[3], v[2]]]);
    expectCorrectSigns(mesh);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    // Edge v0-v1 (midpoint [5, 0, 0]) joins faces with normals (1, 1, -1) and (1, -1, 1).
    for (const mix of [0.05, 0.5, 0.95]) {
      const d = [1, 1 - 2 * mix, -1 + 2 * mix];
      const length = Math.hypot(d[0], d[1], d[2]);
      const p: P3 = [5 + (0.01 * d[0]) / length, (0.01 * d[1]) / length, (0.01 * d[2]) / length];
      expect(bvh.signedDistance(p)).toBeCloseTo(0.01, 6);
    }
  });

  it('signs points around the knife edge of a thin wedge prism', () => {
    const mesh = meshFrom(extrude(WEDGE_POLYGON, [[0, 1, 2]], 5));
    expectCorrectSigns(mesh);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    for (const angle of [-80, -60, -30, 0, 30, 60, 80]) {
      expect(bvh.signedDistance(polar([0, 0, 2.5], WEDGE_OUTWARD + angle * DEG, 0.05))).toBeCloseTo(0.05, 6);
    }
    expect(bvh.signedDistance([0.5, 0.05, 2.5])).toBeLessThan(0);
  });

  it('signs points just inside the concave edge and corner of an L-shaped prism', () => {
    const mesh = meshFrom(extrude(L_POLYGON, L_CAPS, 6));
    expectCorrectSigns(mesh);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    // On a face plane's extension through the reentrant edge (4, 4, z): the closest
    // point is on the edge and one adjacent face normal is perpendicular to p - q.
    expect(bvh.signedDistance([3.9, 4, 3])).toBeCloseTo(-0.1, 6);
    expect(bvh.signedDistance([4, 3.9, 3])).toBeCloseTo(-0.1, 6);
    expect(bvh.signedDistance([3.9, 3.9, 3])).toBeCloseTo(-Math.SQRT2 * 0.1, 6);
    // Just inside the concave corner where the reentrant edge meets the top.
    expect(bvh.signedDistance([3.9, 4, 5.9])).toBeCloseTo(-0.1, 6);
    expect(bvh.signedDistance([3.95, 3.95, 5.95])).toBeLessThan(0);
    // Just outside, in the notch and above the corner.
    expect(bvh.signedDistance([4.1, 4.1, 3])).toBeCloseTo(0.1, 6);
    expect(bvh.signedDistance([4.1, 4.1, 6.1])).toBeGreaterThan(0);
  });

  it('signs points inside a sharp V-groove', () => {
    // A 7 degree notch cut down to (5, 2): material surrounds its tip.
    const polygon: [number, number][] = [[0, 0], [10, 0], [10, 10], [5.5, 10], [5, 2], [4.5, 10], [0, 10]];
    const mesh = meshFrom(extrude(polygon, [[4, 5, 6], [4, 6, 0], [4, 0, 1], [4, 1, 2], [4, 2, 3]], 4));
    expectCorrectSigns(mesh);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    for (const angle of [-80, -60, 0, 60, 80]) {
      expect(bvh.signedDistance(polar([5, 2, 2], -Math.PI / 2 + angle * DEG, 0.05))).toBeCloseTo(-0.05, 6);
    }
  });

  it('bridges a zero-area sliver lying along a sharp edge', () => {
    // The wedge's knife edge is split at its midpoint on one face only, and a
    // collinear sliver closes the T-junction, as CAD exporters often emit.
    const b0: P3 = [0, 0, 0];
    const t0: P3 = [0, 0, 5];
    const m: P3 = [0, 0, 2.5];
    const b1: P3 = [10, 0, 0];
    const t1: P3 = [10, 0, 5];
    const b2: P3 = [10, 2, 0];
    const t2: P3 = [10, 2, 5];
    const mesh = meshFrom([
      [t0, t1, t2], [b0, b2, b1], // caps
      [b0, b1, m], [m, b1, t1], [m, t1, t0], // y = 0 face, split at m
      [b1, b2, t2], [b1, t2, t1], // x = 10 face
      [b2, b0, t0], [b2, t0, t2], // slanted face
      [b0, m, t0], // sliver
    ]);
    expectCorrectSigns(mesh);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    for (const z of [1.25, 2.5, 3.75]) {
      for (const angle of [-80, 0, 80]) {
        expect(bvh.signedDistance(polar([0, 0, z], WEDGE_OUTWARD + angle * DEG, 0.05))).toBeCloseTo(0.05, 6);
      }
    }
  });

  it('ignores stored normals: a minority flipped or zeroed still signs correctly', () => {
    const cube = generateCubeMesh(20);
    const flipped = new Float32Array(cube.normals);
    for (const t of [0, 5, 9]) for (let axis = 0; axis < 3; axis++) flipped[t * 3 + axis] *= -1;
    const bvh = new MeshBVH(cube.positions, flipped, cube.triCount);
    expect(bvh.signedDistance([2, -2, 9.5])).toBeCloseTo(-0.5, 5); // beneath flipped triangle 0
    expect(bvh.signedDistance([2, -2, 10.5])).toBeCloseTo(0.5, 5);
    expectCorrectSigns(cube, bvh);
    expectCorrectSigns(cube, new MeshBVH(cube.positions, new Float32Array(cube.normals.length), cube.triCount));
  });

  it('gives the same signs for a reordered subset of the same triangles', () => {
    const mesh = meshFrom(extrude(L_POLYGON, L_CAPS, 6));
    const order = Array.from({ length: mesh.triCount }, (_, i) => (i * 7) % mesh.triCount);
    const bvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    const reordered = bvh.subset(order)!;
    for (const p of probePoints(mesh, 1, [0.1])) {
      if (bvh.closestDistance(p[0], p[1], p[2]) < 1e-4) continue;
      expect(reordered.signedDistance(p) < 0).toBe(bvh.signedDistance(p) < 0);
    }
  });
});
