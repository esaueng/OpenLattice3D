// BVH acceleration for nearest-triangle queries on triangle soups
import type { Vec3 } from './vec3';
import { sub, dot, cross, length, add, scale } from './vec3';

interface AABB {
  min: Vec3;
  max: Vec3;
}

interface BVHNode {
  aabb: AABB;
  left: BVHNode | null;
  right: BVHNode | null;
  triIndices: number[];  // leaf only
}

export interface ClosestResult {
  distance: number;
  point: Vec3;
  triIndex: number;
}

/** Point-triangle closest point */
function closestPointOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const ap = sub(p, a);

  const d1 = dot(ab, ap);
  const d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;

  const bp = sub(p, b);
  const d3 = dot(ab, bp);
  const d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;

  const cp = sub(p, c);
  const d5 = dot(ab, cp);
  const d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return add(a, scale(ab, v));
  }

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return add(a, scale(ac, w));
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return add(b, scale(sub(c, b), w));
  }

  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return add(a, add(scale(ab, v), scale(ac, w)));
}

function aabbFromTriangles(positions: Float32Array, indices: number[]): AABB {
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const i of indices) {
    for (let v = 0; v < 3; v++) {
      const off = i * 9 + v * 3;
      for (let d = 0; d < 3; d++) {
        const val = positions[off + d];
        if (val < mn[d]) mn[d] = val;
        if (val > mx[d]) mx[d] = val;
      }
    }
  }
  return { min: mn, max: mx };
}

function aabbDistSq(p: Vec3, aabb: AABB): number {
  let dSq = 0;
  for (let d = 0; d < 3; d++) {
    if (p[d] < aabb.min[d]) { const dd = aabb.min[d] - p[d]; dSq += dd * dd; }
    else if (p[d] > aabb.max[d]) { const dd = p[d] - aabb.max[d]; dSq += dd * dd; }
  }
  return dSq;
}

function buildNode(positions: Float32Array, indices: number[], depth: number): BVHNode {
  const aabb = aabbFromTriangles(positions, indices);
  if (indices.length <= 4) {
    return { aabb, left: null, right: null, triIndices: indices };
  }
  // Split along longest axis
  const ext: Vec3 = [aabb.max[0] - aabb.min[0], aabb.max[1] - aabb.min[1], aabb.max[2] - aabb.min[2]];
  let axis = 0;
  if (ext[1] > ext[axis]) axis = 1;
  if (ext[2] > ext[axis]) axis = 2;
  const mid = (aabb.min[axis] + aabb.max[axis]) / 2;
  const left: number[] = [];
  const right: number[] = [];
  for (const i of indices) {
    const cx = (positions[i * 9 + axis] + positions[i * 9 + 3 + axis] + positions[i * 9 + 6 + axis]) / 3;
    if (cx < mid) left.push(i); else right.push(i);
  }
  if (left.length === 0 || right.length === 0) {
    // Can't split further
    return { aabb, left: null, right: null, triIndices: indices };
  }
  return {
    aabb,
    left: buildNode(positions, left, depth + 1),
    right: buildNode(positions, right, depth + 1),
    triIndices: [],
  };
}

export class MeshBVH {
  private root: BVHNode;
  private positions: Float32Array;
  private normals: Float32Array;
  public triCount: number;

  constructor(positions: Float32Array, normals: Float32Array, triCount: number) {
    this.positions = positions;
    this.normals = normals;
    this.triCount = triCount;
    const indices = Array.from({ length: triCount }, (_, i) => i);
    this.root = buildNode(positions, indices, 0);
  }

  private getTriVerts(i: number): [Vec3, Vec3, Vec3] {
    const o = i * 9;
    return [
      [this.positions[o], this.positions[o + 1], this.positions[o + 2]],
      [this.positions[o + 3], this.positions[o + 4], this.positions[o + 5]],
      [this.positions[o + 6], this.positions[o + 7], this.positions[o + 8]],
    ];
  }

  closestPoint(p: Vec3): ClosestResult {
    let bestDist = Infinity;
    let bestPoint: Vec3 = [0, 0, 0];
    let bestTri = -1;

    const stack: BVHNode[] = [this.root];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (aabbDistSq(p, node.aabb) >= bestDist * bestDist) continue;
      if (node.triIndices.length > 0) {
        for (const ti of node.triIndices) {
          const [a, b, c] = this.getTriVerts(ti);
          const cp = closestPointOnTriangle(p, a, b, c);
          const d = length(sub(p, cp));
          if (d < bestDist) {
            bestDist = d;
            bestPoint = cp;
            bestTri = ti;
          }
        }
      } else {
        if (node.left) stack.push(node.left);
        if (node.right) stack.push(node.right);
      }
    }
    return { distance: bestDist, point: bestPoint, triIndex: bestTri };
  }

  /** Signed distance: negative inside, positive outside.
   *  Sign determined by angle-weighted pseudonormal. */
  signedDistance(p: Vec3): number {
    const res = this.closestPoint(p);
    // Use face normal at closest triangle for sign
    const ni = res.triIndex * 3;
    const n: Vec3 = [this.normals[ni], this.normals[ni + 1], this.normals[ni + 2]];
    const toP = sub(p, res.point);
    const sign = dot(toP, n) >= 0 ? 1 : -1;
    return sign * res.distance;
  }

  /** Ray cast for sign determination (backup) - casts +X ray */
  isInsideRayCast(p: Vec3): boolean {
    let intersections = 0;
    for (let i = 0; i < this.triCount; i++) {
      const [a, b, c] = this.getTriVerts(i);
      // Ray in +X direction from p
      if (rayTriangleIntersect(p, [1, 0, 0], a, b, c)) {
        intersections++;
      }
    }
    return (intersections % 2) === 1;
  }
}

function rayTriangleIntersect(origin: Vec3, dir: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const edge1 = sub(b, a);
  const edge2 = sub(c, a);
  const h = cross(dir, edge2);
  const det = dot(edge1, h);
  if (Math.abs(det) < 1e-10) return false;
  const f = 1 / det;
  const s = sub(origin, a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, edge1);
  const v = f * dot(dir, q);
  if (v < 0 || u + v > 1) return false;
  const t = f * dot(edge2, q);
  return t > 1e-6;
}
