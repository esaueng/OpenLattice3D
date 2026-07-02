// BVH acceleration for nearest-triangle queries on triangle soups.
//
// The BVH is stored in flat typed arrays instead of recursive object nodes:
// - nodeMin/nodeMax: 3 floats per node for AABB bounds
// - leftFirst: internal node -> left child index, leaf -> first triangle slot
// - count: internal node -> 0, leaf -> number of triangles
// - triIndices: triangle indices grouped by leaf ranges
import type { Vec3 } from './vec3';

export interface ClosestResult {
  distance: number;
  point: Vec3;
  triIndex: number;
}

const LEAF_SIZE = 4;

function expandBounds(
  positions: Float32Array,
  triIndex: number,
  min: Float64Array,
  max: Float64Array
): void {
  const o = triIndex * 9;
  for (let i = 0; i < 9; i += 3) {
    const x = positions[o + i];
    const y = positions[o + i + 1];
    const z = positions[o + i + 2];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
}

function aabbDistSq(
  px: number,
  py: number,
  pz: number,
  nodeIndex: number,
  nodeMin: Float32Array,
  nodeMax: Float32Array
): number {
  const o = nodeIndex * 3;
  let dSq = 0;
  if (px < nodeMin[o]) {
    const d = nodeMin[o] - px;
    dSq += d * d;
  } else if (px > nodeMax[o]) {
    const d = px - nodeMax[o];
    dSq += d * d;
  }
  if (py < nodeMin[o + 1]) {
    const d = nodeMin[o + 1] - py;
    dSq += d * d;
  } else if (py > nodeMax[o + 1]) {
    const d = py - nodeMax[o + 1];
    dSq += d * d;
  }
  if (pz < nodeMin[o + 2]) {
    const d = nodeMin[o + 2] - pz;
    dSq += d * d;
  } else if (pz > nodeMax[o + 2]) {
    const d = pz - nodeMax[o + 2];
    dSq += d * d;
  }
  return dSq;
}

function closestPointOnTriangleSq(
  px: number,
  py: number,
  pz: number,
  triIndex: number,
  triA: Float32Array,
  triAB: Float32Array,
  triAC: Float32Array,
  triBC: Float32Array,
  out: Float64Array
): number {
  const o = triIndex * 3;
  const ax = triA[o];
  const ay = triA[o + 1];
  const az = triA[o + 2];
  const abx = triAB[o];
  const aby = triAB[o + 1];
  const abz = triAB[o + 2];
  const acx = triAC[o];
  const acy = triAC[o + 1];
  const acz = triAC[o + 2];
  const bx = ax + abx;
  const by = ay + aby;
  const bz = az + abz;
  const cx = ax + acx;
  const cy = ay + acy;
  const cz = az + acz;

  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx: number;
  let qy: number;
  let qz: number;

  if (d1 <= 0 && d2 <= 0) {
    qx = ax;
    qy = ay;
    qz = az;
  } else {
    const bpx = px - bx;
    const bpy = py - by;
    const bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;

    if (d3 >= 0 && d4 <= d3) {
      qx = bx;
      qy = by;
      qz = bz;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx;
        qy = ay + v * aby;
        qz = az + v * abz;
      } else {
        const cpx = px - cx;
        const cpy = py - cy;
        const cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;

        if (d6 >= 0 && d5 <= d6) {
          qx = cx;
          qy = cy;
          qz = cz;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx;
            qy = ay + w * acy;
            qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + d5 - d6);
              const bcx = triBC[o];
              const bcy = triBC[o + 1];
              const bcz = triBC[o + 2];
              qx = bx + w * bcx;
              qy = by + w * bcy;
              qz = bz + w * bcz;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w;
              qy = ay + aby * v + acy * w;
              qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }

  out[0] = qx;
  out[1] = qy;
  out[2] = qz;
  const dx = px - qx;
  const dy = py - qy;
  const dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

export class MeshBVH {
  private positions: Float32Array;
  private normals: Float32Array;
  public triCount: number;

  private nodeMin: Float32Array;
  private nodeMax: Float32Array;
  private leftFirst: Int32Array;
  private count: Int32Array;
  private triIndices: Uint32Array;
  private triA: Float32Array;
  private triAB: Float32Array;
  private triAC: Float32Array;
  private triBC: Float32Array;
  private stack: Int32Array;
  private closestScratch = new Float64Array(3);

  constructor(positions: Float32Array, normals: Float32Array, triCount: number) {
    if (!Number.isInteger(triCount) || triCount <= 0) {
      throw new Error(`MeshBVH requires at least one triangle (got ${triCount})`);
    }
    if (positions.length < triCount * 9 || normals.length < triCount * 3) {
      throw new Error('MeshBVH: position/normal buffers are smaller than triCount requires');
    }
    this.positions = positions;
    this.normals = normals;
    this.triCount = triCount;
    this.triIndices = new Uint32Array(triCount);
    this.triA = new Float32Array(triCount * 3);
    this.triAB = new Float32Array(triCount * 3);
    this.triAC = new Float32Array(triCount * 3);
    this.triBC = new Float32Array(triCount * 3);

    const centroids = new Float32Array(triCount * 3);
    for (let i = 0; i < triCount; i++) {
      this.triIndices[i] = i;
      const po = i * 9;
      const to = i * 3;
      const ax = positions[po];
      const ay = positions[po + 1];
      const az = positions[po + 2];
      const bx = positions[po + 3];
      const by = positions[po + 4];
      const bz = positions[po + 5];
      const cx = positions[po + 6];
      const cy = positions[po + 7];
      const cz = positions[po + 8];
      this.triA[to] = ax;
      this.triA[to + 1] = ay;
      this.triA[to + 2] = az;
      this.triAB[to] = bx - ax;
      this.triAB[to + 1] = by - ay;
      this.triAB[to + 2] = bz - az;
      this.triAC[to] = cx - ax;
      this.triAC[to + 1] = cy - ay;
      this.triAC[to + 2] = cz - az;
      this.triBC[to] = cx - bx;
      this.triBC[to + 1] = cy - by;
      this.triBC[to + 2] = cz - bz;
      centroids[to] = (ax + bx + cx) / 3;
      centroids[to + 1] = (ay + by + cy) / 3;
      centroids[to + 2] = (az + bz + cz) / 3;
    }

    const nodeMin: number[] = [];
    const nodeMax: number[] = [];
    const leftFirst: number[] = [];
    const count: number[] = [];
    this.allocateNode(nodeMin, nodeMax, leftFirst, count);
    this.buildNodeAt(0, 0, triCount, centroids, nodeMin, nodeMax, leftFirst, count);
    this.nodeMin = new Float32Array(nodeMin);
    this.nodeMax = new Float32Array(nodeMax);
    this.leftFirst = new Int32Array(leftFirst);
    this.count = new Int32Array(count);
    this.stack = new Int32Array(Math.max(1, this.count.length));
  }

  private allocateNode(nodeMin: number[], nodeMax: number[], leftFirst: number[], count: number[]): number {
    const nodeIndex = count.length;
    nodeMin.push(0, 0, 0);
    nodeMax.push(0, 0, 0);
    leftFirst.push(0);
    count.push(0);
    return nodeIndex;
  }

  private buildNodeAt(
    nodeIndex: number,
    first: number,
    triCount: number,
    centroids: Float32Array,
    nodeMin: number[],
    nodeMax: number[],
    leftFirst: number[],
    count: number[]
  ): void {
    const min = new Float64Array([Infinity, Infinity, Infinity]);
    const max = new Float64Array([-Infinity, -Infinity, -Infinity]);
    const cmin = new Float64Array([Infinity, Infinity, Infinity]);
    const cmax = new Float64Array([-Infinity, -Infinity, -Infinity]);

    for (let i = first; i < first + triCount; i++) {
      const triIndex = this.triIndices[i];
      expandBounds(this.positions, triIndex, min, max);
      const co = triIndex * 3;
      const cx = centroids[co];
      const cy = centroids[co + 1];
      const cz = centroids[co + 2];
      if (cx < cmin[0]) cmin[0] = cx;
      if (cy < cmin[1]) cmin[1] = cy;
      if (cz < cmin[2]) cmin[2] = cz;
      if (cx > cmax[0]) cmax[0] = cx;
      if (cy > cmax[1]) cmax[1] = cy;
      if (cz > cmax[2]) cmax[2] = cz;
    }

    const no = nodeIndex * 3;
    nodeMin[no] = min[0];
    nodeMin[no + 1] = min[1];
    nodeMin[no + 2] = min[2];
    nodeMax[no] = max[0];
    nodeMax[no + 1] = max[1];
    nodeMax[no + 2] = max[2];
    leftFirst[nodeIndex] = first;
    count[nodeIndex] = triCount;

    if (triCount <= LEAF_SIZE) return;

    const ex = cmax[0] - cmin[0];
    const ey = cmax[1] - cmin[1];
    const ez = cmax[2] - cmin[2];
    let axis = 0;
    if (ey > ex) axis = 1;
    if ((axis === 0 ? ez > ex : ez > ey)) axis = 2;
    const split = (cmin[axis] + cmax[axis]) * 0.5;

    let i = first;
    let j = first + triCount - 1;
    while (i <= j) {
      const ci = centroids[this.triIndices[i] * 3 + axis];
      if (ci < split) {
        i++;
      } else {
        const tmp = this.triIndices[i];
        this.triIndices[i] = this.triIndices[j];
        this.triIndices[j] = tmp;
        j--;
      }
    }

    let leftCount = i - first;
    if (leftCount === 0 || leftCount === triCount) {
      leftCount = triCount >> 1;
      this.sortRangeByCentroid(first, triCount, axis, centroids);
    }

    const leftIndex = this.allocateNode(nodeMin, nodeMax, leftFirst, count);
    const rightIndex = this.allocateNode(nodeMin, nodeMax, leftFirst, count);
    leftFirst[nodeIndex] = leftIndex;
    count[nodeIndex] = 0;
    this.buildNodeAt(leftIndex, first, leftCount, centroids, nodeMin, nodeMax, leftFirst, count);
    this.buildNodeAt(rightIndex, first + leftCount, triCount - leftCount, centroids, nodeMin, nodeMax, leftFirst, count);
  }

  private sortRangeByCentroid(first: number, triCount: number, axis: number, centroids: Float32Array): void {
    const tmp = Array.from(this.triIndices.slice(first, first + triCount));
    tmp.sort((a, b) => centroids[a * 3 + axis] - centroids[b * 3 + axis]);
    for (let i = 0; i < tmp.length; i++) this.triIndices[first + i] = tmp[i];
  }

  closestPoint(p: Vec3): ClosestResult {
    const px = p[0];
    const py = p[1];
    const pz = p[2];
    let bestDistSq = Infinity;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;
    let bestTri = -1;
    let stackSize = 0;
    this.stack[stackSize++] = 0;

    while (stackSize > 0) {
      const node = this.stack[--stackSize];
      if (aabbDistSq(px, py, pz, node, this.nodeMin, this.nodeMax) >= bestDistSq) continue;

      const leafCount = this.count[node];
      const first = this.leftFirst[node];
      if (leafCount > 0) {
        for (let i = first; i < first + leafCount; i++) {
          const triIndex = this.triIndices[i];
          const dSq = closestPointOnTriangleSq(
            px,
            py,
            pz,
            triIndex,
            this.triA,
            this.triAB,
            this.triAC,
            this.triBC,
            this.closestScratch
          );
          if (dSq < bestDistSq) {
            bestDistSq = dSq;
            bestX = this.closestScratch[0];
            bestY = this.closestScratch[1];
            bestZ = this.closestScratch[2];
            bestTri = triIndex;
          }
        }
      } else {
        const left = first;
        const right = first + 1;
        const leftDist = aabbDistSq(px, py, pz, left, this.nodeMin, this.nodeMax);
        const rightDist = aabbDistSq(px, py, pz, right, this.nodeMin, this.nodeMax);
        if (leftDist < rightDist) {
          if (rightDist < bestDistSq) this.stack[stackSize++] = right;
          if (leftDist < bestDistSq) this.stack[stackSize++] = left;
        } else {
          if (leftDist < bestDistSq) this.stack[stackSize++] = left;
          if (rightDist < bestDistSq) this.stack[stackSize++] = right;
        }
      }
    }

    return { distance: Math.sqrt(bestDistSq), point: [bestX, bestY, bestZ], triIndex: bestTri };
  }

  /** Signed distance: negative inside, positive outside.
   *  Sign determined by the closest triangle face normal, matching the previous behavior. */
  signedDistance(p: Vec3): number {
    const res = this.closestPoint(p);
    const ni = res.triIndex * 3;
    const nx = this.normals[ni];
    const ny = this.normals[ni + 1];
    const nz = this.normals[ni + 2];
    const dx = p[0] - res.point[0];
    const dy = p[1] - res.point[1];
    const dz = p[2] - res.point[2];
    const sign = dx * nx + dy * ny + dz * nz >= 0 ? 1 : -1;
    return sign * res.distance;
  }
}
