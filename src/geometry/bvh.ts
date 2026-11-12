// BVH acceleration for nearest-triangle queries on triangle soups.
//
// The BVH is stored in flat typed arrays instead of recursive object nodes:
// - nodeMin/nodeMax: 3 floats per node for AABB bounds
// - leftFirst: internal node -> left child index, leaf -> first triangle slot
// - count: internal node -> 0, leaf -> number of triangles
// - triIndices: triangle indices grouped by leaf ranges
//
// Signed distance uses angle-weighted pseudonormals (Baerentzen & Aanaes,
// "Signed distance computation using the angle weighted pseudonormal", 2005):
// the sign is taken against the normal of the closest *feature* (face, edge or
// vertex) rather than the closest triangle's face normal, which is wrong near
// sharp edges and concave corners. Pseudonormals derive from triangle winding
// only; stored (e.g. STL) normals never influence the sign.
import type { Vec3 } from './vec3';

export interface ClosestResult {
  distance: number;
  point: Vec3;
  triIndex: number;
}

const LEAF_SIZE = 4;

/**
 * Relative feature-snapping tolerance for the sign test.
 *
 * A closest point closer than SNAP_REL x (longest edge of its triangle) to an
 * edge or vertex is classified as lying on that feature, and a triangle whose
 * height is below the same tolerance is treated as degenerate. Edge vectors
 * are stored as float32 differences (relative error <= 2^-24), so triangles
 * sharing a vertex can disagree about its position by ~6e-8 x edge length;
 * 1e-6 leaves a wide margin while staying far below any printable feature.
 * Snapping slightly too eagerly is harmless: a neighbouring feature's
 * pseudonormal still has a positive component along the face normal.
 */
const SNAP_REL = 1e-6;

/** Angle-weighted pseudonormals for a welded view of the triangle soup. */
interface Pseudonormals {
  /** Welded vertex id per triangle corner (3 per triangle). */
  triVertex: Uint32Array;
  /** Edge id per triangle edge, in the order AB, BC, CA (3 per triangle). */
  triEdge: Uint32Array;
  /** Per vertex: sum of incident unit face normals weighted by corner angle. */
  vertexNormals: Float32Array;
  /** Per edge: sum of incident unit face normals (equal weights of pi). */
  edgeNormals: Float32Array;
}

function normalizeZeroBits(bits: number): number {
  return bits === 0x80000000 ? 0 : bits;
}

function hashTriple(a: number, b: number, c: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ a, 16777619);
  h = Math.imul(h ^ b, 16777619);
  h = Math.imul(h ^ c, 16777619);
  return (h ^ (h >>> 15)) >>> 0;
}

function tableSizeFor(entries: number): number {
  let size = 16;
  while (size < entries * 2) size *= 2;
  return size;
}

/**
 * Open-addressed table assigning dense ids to unique keys. A key is identified
 * by a probe index (a corner or edge slot); `sameKey` compares two probes. The
 * table grows at 50% load, so its size tracks the number of unique keys
 * (vertices or edges), not the number of probes scanned.
 */
class IdTable {
  private slots: Int32Array;
  private hashes: Uint32Array;
  private mask: number;
  /** Representative probe per id. */
  readonly reps: Uint32Array;
  private sameKey: (a: number, b: number) => boolean;
  count = 0;

  constructor(expected: number, capacity: number, sameKey: (a: number, b: number) => boolean) {
    this.sameKey = sameKey;
    const size = tableSizeFor(expected);
    this.slots = new Int32Array(size).fill(-1);
    this.hashes = new Uint32Array(size);
    this.mask = size - 1;
    this.reps = new Uint32Array(capacity);
  }

  idFor(hash: number, probe: number): number {
    let slot = hash & this.mask;
    for (;;) {
      const id = this.slots[slot];
      if (id < 0) break;
      if (this.hashes[slot] === hash && this.sameKey(this.reps[id], probe)) return id;
      slot = (slot + 1) & this.mask;
    }
    const id = this.count++;
    this.slots[slot] = id;
    this.hashes[slot] = hash;
    this.reps[id] = probe;
    if (this.count * 2 > this.slots.length) this.grow();
    return id;
  }

  private grow(): void {
    const oldSlots = this.slots;
    const oldHashes = this.hashes;
    const size = oldSlots.length * 2;
    this.slots = new Int32Array(size).fill(-1);
    this.hashes = new Uint32Array(size);
    this.mask = size - 1;
    for (let i = 0; i < oldSlots.length; i++) {
      const id = oldSlots[i];
      if (id < 0) continue;
      let slot = oldHashes[i] & this.mask;
      while (this.slots[slot] >= 0) slot = (slot + 1) & this.mask;
      this.slots[slot] = id;
      this.hashes[slot] = oldHashes[i];
    }
  }
}

/**
 * Weld the soup by exact float bits (as mesh-topology does; -0 equals +0) and
 * accumulate angle-weighted vertex and edge pseudonormals from the winding.
 * Stored normals are ignored. Degenerate triangles contribute nothing.
 */
function buildPseudonormals(positions: Float32Array, triCount: number): Pseudonormals {
  const cornerCount = triCount * 3;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, triCount * 9);
  const coord = (corner: number, axis: number) => normalizeZeroBits(bits[corner * 3 + axis]);

  const triVertex = new Uint32Array(cornerCount);
  const vertices = new IdTable(triCount, cornerCount, (a, b) =>
    coord(a, 0) === coord(b, 0) && coord(a, 1) === coord(b, 1) && coord(a, 2) === coord(b, 2));
  for (let corner = 0; corner < cornerCount; corner++) {
    triVertex[corner] = vertices.idFor(hashTriple(coord(corner, 0), coord(corner, 1), coord(corner, 2)), corner);
  }
  const vertexCount = vertices.count;

  // Edge slot tri * 3 + k is the edge from corner k to corner (k + 1) % 3,
  // identified by its unordered pair of welded vertex ids.
  const edgeA = (slot: number) => triVertex[slot];
  const edgeB = (slot: number) => triVertex[slot % 3 === 2 ? slot - 2 : slot + 1];
  const edgeLo = (slot: number) => Math.min(edgeA(slot), edgeB(slot));
  const edgeHi = (slot: number) => Math.max(edgeA(slot), edgeB(slot));
  const triEdge = new Uint32Array(cornerCount);
  const edges = new IdTable(triCount * 2, cornerCount, (a, b) =>
    edgeLo(a) === edgeLo(b) && edgeHi(a) === edgeHi(b));
  for (let slot = 0; slot < cornerCount; slot++) {
    triEdge[slot] = edges.idFor(hashTriple(edgeLo(slot), edgeHi(slot), 0x9e3779b9), slot);
  }
  const edgeCount = edges.count;

  const vertexAccum = new Float64Array(vertexCount * 3);
  const edgeAccum = new Float64Array(edgeCount * 3);
  const degenerate: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const po = t * 9;
    const ax = positions[po];
    const ay = positions[po + 1];
    const az = positions[po + 2];
    const abx = positions[po + 3] - ax;
    const aby = positions[po + 4] - ay;
    const abz = positions[po + 5] - az;
    const acx = positions[po + 6] - ax;
    const acy = positions[po + 7] - ay;
    const acz = positions[po + 8] - az;
    const bcx = acx - abx;
    const bcy = acy - aby;
    const bcz = acz - abz;
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const area2 = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const longestSq = Math.max(
      abx * abx + aby * aby + abz * abz,
      acx * acx + acy * acy + acz * acz,
      bcx * bcx + bcy * bcy + bcz * bcz,
    );
    // Height below SNAP_REL x longest edge: degenerate, no usable normal.
    if (!(area2 > SNAP_REL * longestSq)) {
      if (longestSq > 0) degenerate.push(t);
      continue;
    }
    const nx = cx / area2;
    const ny = cy / area2;
    const nz = cz / area2;
    // |u x v| equals twice the area at every corner, so atan2 needs only dots.
    const angleA = Math.atan2(area2, abx * acx + aby * acy + abz * acz);
    const angleB = Math.atan2(area2, -(abx * bcx + aby * bcy + abz * bcz));
    const angleC = Math.atan2(area2, acx * bcx + acy * bcy + acz * bcz);
    for (let k = 0; k < 3; k++) {
      const vo = triVertex[t * 3 + k] * 3;
      const angle = k === 0 ? angleA : k === 1 ? angleB : angleC;
      vertexAccum[vo] += angle * nx;
      vertexAccum[vo + 1] += angle * ny;
      vertexAccum[vo + 2] += angle * nz;
      const eo = triEdge[t * 3 + k] * 3;
      edgeAccum[eo] += nx;
      edgeAccum[eo + 1] += ny;
      edgeAccum[eo + 2] += nz;
    }
  }

  if (degenerate.length > 0) bridgeDegenerateTriangles(positions, degenerate, triVertex, triEdge, vertexAccum, edgeAccum);

  return {
    triVertex,
    triEdge,
    vertexNormals: Float32Array.from(vertexAccum),
    edgeNormals: Float32Array.from(edgeAccum),
  };
}

/** Longest edge of a triangle: edge index (0 = AB, 1 = BC, 2 = CA), its
 *  start and end corners, and the remaining corner. Ties prefer AB, then BC. */
function longestEdge(ab2: number, bc2: number, ca2: number, out: Int32Array): void {
  if (ab2 >= bc2 && ab2 >= ca2) {
    out[0] = 0; out[1] = 0; out[2] = 1; out[3] = 2;
  } else if (bc2 >= ca2) {
    out[0] = 1; out[1] = 1; out[2] = 2; out[3] = 0;
  } else {
    out[0] = 2; out[1] = 2; out[2] = 0; out[3] = 1;
  }
}

/** Edge index joining two distinct corners of a triangle. */
function edgeBetween(cornerA: number, cornerB: number): number {
  const sum = cornerA + cornerB;
  return sum === 1 ? 0 : sum === 3 ? 1 : 2;
}

/**
 * A zero-area sliver (s, m, e) with m on its longest edge s-e sits between the
 * face across s-e and the faces across s-m and m-e, which therefore meet along
 * those edges without sharing a welded edge. Give each side the other's
 * normals, and give m the face across s-e (angle pi), so edge and vertex
 * pseudonormals there see both sides. One level only: chains of adjacent
 * slivers are bridged pairwise.
 */
function bridgeDegenerateTriangles(
  positions: Float32Array,
  degenerate: number[],
  triVertex: Uint32Array,
  triEdge: Uint32Array,
  vertexAccum: Float64Array,
  edgeAccum: Float64Array,
): void {
  const snapshot = edgeAccum.slice();
  const corners = new Int32Array(4);
  for (const t of degenerate) {
    const po = t * 9;
    const d2 = (i: number, j: number) => {
      const dx = positions[po + j * 3] - positions[po + i * 3];
      const dy = positions[po + j * 3 + 1] - positions[po + i * 3 + 1];
      const dz = positions[po + j * 3 + 2] - positions[po + i * 3 + 2];
      return dx * dx + dy * dy + dz * dz;
    };
    longestEdge(d2(0, 1), d2(1, 2), d2(2, 0), corners);
    const [longest, start, end, middle] = corners;
    const lo = triEdge[t * 3 + longest] * 3;
    const s1 = triEdge[t * 3 + edgeBetween(start, middle)] * 3;
    const s2 = triEdge[t * 3 + edgeBetween(middle, end)] * 3;
    const mo = triVertex[t * 3 + middle] * 3;
    for (let axis = 0; axis < 3; axis++) {
      edgeAccum[lo + axis] += 0.5 * (snapshot[s1 + axis] + snapshot[s2 + axis]);
      edgeAccum[s1 + axis] += snapshot[lo + axis];
      edgeAccum[s2 + axis] += snapshot[lo + axis];
      vertexAccum[mo + axis] += Math.PI * snapshot[lo + axis];
    }
  }
}

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

/**
 * Closest point on triangle (Ericson, Real-Time Collision Detection 5.1.5).
 * Writes the point to out[0..2] and its barycentric weights for B and C to
 * out[3..4] (the weight for A is 1 - out[3] - out[4]).
 */
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
  let baryV = 0;
  let baryW = 0;

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
      baryV = 1;
    } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx;
        qy = ay + v * aby;
        qz = az + v * abz;
        baryV = v;
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
          baryW = 1;
        } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx;
            qy = ay + w * acy;
            qz = az + w * acz;
            baryW = w;
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
              baryV = 1 - w;
              baryW = w;
            } else {
              const denom = 1 / (va + vb + vc);
              const v = vb * denom;
              const w = vc * denom;
              qx = ax + abx * v + acx * w;
              qy = ay + aby * v + acy * w;
              qz = az + abz * v + acz * w;
              baryV = v;
              baryW = w;
            }
          }
        }
      }
    }
  }

  out[0] = qx;
  out[1] = qy;
  out[2] = qz;
  out[3] = baryV;
  out[4] = baryW;
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
  /** Per-candidate closest point (0..2) and barycentric v, w (3..4). */
  private closestScratch = new Float64Array(5);
  /** Best candidate of the last nearest() query, same layout. */
  private bestScratch = new Float64Array(5);
  private bestTri = -1;
  private featureNormalScratch = new Float64Array(3);
  private cornerScratch = new Int32Array(4);
  /** Built on the first signedDistance() call; unsigned queries never pay for it. */
  private pseudonormals: Pseudonormals | null = null;

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

  getBounds(): { min: Vec3; max: Vec3 } {
    return {
      min: [this.nodeMin[0], this.nodeMin[1], this.nodeMin[2]],
      max: [this.nodeMax[0], this.nodeMax[1], this.nodeMax[2]],
    };
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
    const bestDistSq = this.nearest(p[0], p[1], p[2]);
    const best = this.bestScratch;
    return { distance: Math.sqrt(bestDistSq), point: [best[0], best[1], best[2]], triIndex: this.bestTri };
  }

  /**
   * Allocation-free nearest-triangle search. Returns the squared distance and
   * leaves the closest point and its barycentrics in bestScratch and the
   * triangle in bestTri.
   */
  private nearest(px: number, py: number, pz: number): number {
    let bestDistSq = Infinity;
    let bestTri = -1;
    const best = this.bestScratch;
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
            best.set(this.closestScratch);
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

    if (bestTri < 0) best.fill(0); // Non-finite query point.
    this.bestTri = bestTri;
    return bestDistSq;
  }

  /** Allocation-free unsigned distance to the nearest triangle. */
  closestDistance(px: number, py: number, pz: number): number {
    let bestDistSq = Infinity;
    let stackSize = 0;
    this.stack[stackSize++] = 0;

    while (stackSize > 0) {
      const node = this.stack[--stackSize];
      if (aabbDistSq(px, py, pz, node, this.nodeMin, this.nodeMax) >= bestDistSq) continue;
      const leafCount = this.count[node];
      const first = this.leftFirst[node];
      if (leafCount > 0) {
        for (let i = first; i < first + leafCount; i++) {
          const distanceSquared = closestPointOnTriangleSq(
            px,
            py,
            pz,
            this.triIndices[i],
            this.triA,
            this.triAB,
            this.triAC,
            this.triBC,
            this.closestScratch,
          );
          if (distanceSquared < bestDistSq) bestDistSq = distanceSquared;
        }
      } else {
        const left = first;
        const right = first + 1;
        const leftDistance = aabbDistSq(px, py, pz, left, this.nodeMin, this.nodeMax);
        const rightDistance = aabbDistSq(px, py, pz, right, this.nodeMin, this.nodeMax);
        if (leftDistance < rightDistance) {
          if (rightDistance < bestDistSq) this.stack[stackSize++] = right;
          if (leftDistance < bestDistSq) this.stack[stackSize++] = left;
        } else {
          if (leftDistance < bestDistSq) this.stack[stackSize++] = left;
          if (rightDistance < bestDistSq) this.stack[stackSize++] = right;
        }
      }
    }

    return Math.sqrt(bestDistSq);
  }

  /** Build a queryable BVH from a selected subset of this mesh's triangles. */
  subset(triangleIndices: Iterable<number>): MeshBVH | null {
    const selected: number[] = [];
    for (const triangleIndex of triangleIndices) {
      if (triangleIndex >= 0 && triangleIndex < this.triCount) selected.push(triangleIndex);
    }
    if (selected.length === 0) return null;

    const positions = new Float32Array(selected.length * 9);
    const normals = new Float32Array(selected.length * 3);
    for (let index = 0; index < selected.length; index++) {
      const source = selected[index];
      positions.set(this.positions.subarray(source * 9, source * 9 + 9), index * 9);
      normals.set(this.normals.subarray(source * 3, source * 3 + 3), index * 3);
    }
    return new MeshBVH(positions, normals, selected.length);
  }

  /**
   * Signed distance in mm: negative inside, positive outside.
   *
   * The sign compares (p - q) against the angle-weighted pseudonormal of the
   * feature holding the closest point q: the face normal when q is interior
   * to the closest triangle, the edge or vertex pseudonormal when q lies (to
   * within SNAP_REL) on an edge or vertex. This is exact for closed,
   * consistently wound meshes, including near sharp convex edges and concave
   * corners where a single face normal can report the wrong side. Only the
   * winding is used; stored normals do not affect the sign.
   */
  signedDistance(p: Vec3): number {
    const px = p[0];
    const py = p[1];
    const pz = p[2];
    const distance = Math.sqrt(this.nearest(px, py, pz));
    if (this.bestTri < 0) return -distance; // Non-finite query point.
    const best = this.bestScratch;
    const n = this.featureNormalScratch;
    this.featureNormal(this.bestTri, best[3], best[4], best[0], best[1], best[2], n);
    const dot = (px - best[0]) * n[0] + (py - best[1]) * n[1] + (pz - best[2]) * n[2];
    return dot >= 0 ? distance : -distance;
  }

  private getPseudonormals(): Pseudonormals {
    if (!this.pseudonormals) this.pseudonormals = buildPseudonormals(this.positions, this.triCount);
    return this.pseudonormals;
  }

  /**
   * Pseudonormal (unnormalized; only its direction matters) of the feature of
   * triangle `tri` holding the closest point q with barycentrics (1-v-w, v, w).
   */
  private featureNormal(
    tri: number,
    v: number,
    w: number,
    qx: number,
    qy: number,
    qz: number,
    out: Float64Array,
  ): void {
    const pn = this.getPseudonormals();
    const o = tri * 3;
    const abx = this.triAB[o];
    const aby = this.triAB[o + 1];
    const abz = this.triAB[o + 2];
    const acx = this.triAC[o];
    const acy = this.triAC[o + 1];
    const acz = this.triAC[o + 2];
    const bcx = this.triBC[o];
    const bcy = this.triBC[o + 1];
    const bcz = this.triBC[o + 2];
    const cx = aby * acz - abz * acy;
    const cy = abz * acx - abx * acz;
    const cz = abx * acy - aby * acx;
    const area2 = Math.sqrt(cx * cx + cy * cy + cz * cz);
    const ab = Math.sqrt(abx * abx + aby * aby + abz * abz);
    const ac = Math.sqrt(acx * acx + acy * acy + acz * acz);
    const bc = Math.sqrt(bcx * bcx + bcy * bcy + bcz * bcz);
    const longest = Math.max(ab, ac, bc);
    const tol = SNAP_REL * longest;

    if (area2 > tol * longest) {
      // Distance from q to the edge opposite each vertex: barycentric x height.
      const onBC = (1 - v - w) * area2 <= tol * bc;
      const onCA = v * area2 <= tol * ac;
      const onAB = w * area2 <= tol * ab;
      if (onAB && onCA && !onBC) return this.copyNormal(pn.vertexNormals, pn.triVertex[o], out);
      if (onAB && onBC && !onCA) return this.copyNormal(pn.vertexNormals, pn.triVertex[o + 1], out);
      if (onBC && onCA && !onAB) return this.copyNormal(pn.vertexNormals, pn.triVertex[o + 2], out);
      if (!onAB && !onBC && !onCA) {
        out[0] = cx;
        out[1] = cy;
        out[2] = cz;
        return;
      }
      if (onAB && !onBC && !onCA) return this.copyNormal(pn.edgeNormals, pn.triEdge[o], out);
      if (onBC && !onAB && !onCA) return this.copyNormal(pn.edgeNormals, pn.triEdge[o + 1], out);
      if (onCA && !onAB && !onBC) return this.copyNormal(pn.edgeNormals, pn.triEdge[o + 2], out);
      // All three within tolerance: a near-degenerate sliver, handled below.
    }
    this.degenerateFeatureNormal(tri, qx, qy, qz, out);
  }

  private copyNormal(source: Float32Array, index: number, out: Float64Array): void {
    const o = index * 3;
    out[0] = source[o];
    out[1] = source[o + 1];
    out[2] = source[o + 2];
  }

  /**
   * A zero-area triangle has no face normal, but its corners are collinear,
   * so q lies on its longest edge and on one of the two short edges. Snap to
   * a corner when close; otherwise use the short edge, whose pseudonormal was
   * bridged to the face across the longest edge at build time.
   */
  private degenerateFeatureNormal(tri: number, qx: number, qy: number, qz: number, out: Float64Array): void {
    const pn = this.getPseudonormals();
    const o = tri * 3;
    const abx = this.triAB[o];
    const aby = this.triAB[o + 1];
    const abz = this.triAB[o + 2];
    const acx = this.triAC[o];
    const acy = this.triAC[o + 1];
    const acz = this.triAC[o + 2];
    const ab2 = abx * abx + aby * aby + abz * abz;
    const ac2 = acx * acx + acy * acy + acz * acz;
    const bc2 = this.triBC[o] ** 2 + this.triBC[o + 1] ** 2 + this.triBC[o + 2] ** 2;
    const corners = this.cornerScratch;
    longestEdge(ab2, bc2, ac2, corners);
    const start = corners[1];
    const end = corners[2];
    const middle = corners[3];
    // Corner offsets from A: corner 0 = 0, corner 1 = AB, corner 2 = AC.
    const sx = start === 1 ? abx : start === 2 ? acx : 0;
    const sy = start === 1 ? aby : start === 2 ? acy : 0;
    const sz = start === 1 ? abz : start === 2 ? acz : 0;
    const dx = (end === 1 ? abx : end === 2 ? acx : 0) - sx;
    const dy = (end === 1 ? aby : end === 2 ? acy : 0) - sy;
    const dz = (end === 1 ? abz : end === 2 ? acz : 0) - sz;
    const length2 = dx * dx + dy * dy + dz * dz;
    if (!(length2 > 0)) {
      // All three corners coincide: a single point.
      this.copyNormal(pn.vertexNormals, pn.triVertex[o], out);
      return;
    }
    const mx = (middle === 1 ? abx : middle === 2 ? acx : 0) - sx;
    const my = (middle === 1 ? aby : middle === 2 ? acy : 0) - sy;
    const mz = (middle === 1 ? abz : middle === 2 ? acz : 0) - sz;
    const t = ((qx - this.triA[o] - sx) * dx + (qy - this.triA[o + 1] - sy) * dy + (qz - this.triA[o + 2] - sz) * dz) / length2;
    const tm = (mx * dx + my * dy + mz * dz) / length2;
    if (t <= SNAP_REL) {
      this.copyNormal(pn.vertexNormals, pn.triVertex[o + start], out);
    } else if (t >= 1 - SNAP_REL) {
      this.copyNormal(pn.vertexNormals, pn.triVertex[o + end], out);
    } else if (Math.abs(t - tm) <= SNAP_REL) {
      this.copyNormal(pn.vertexNormals, pn.triVertex[o + middle], out);
    } else {
      const short = t < tm ? edgeBetween(start, middle) : edgeBetween(middle, end);
      this.copyNormal(pn.edgeNormals, pn.triEdge[o + short], out);
    }
  }
}
