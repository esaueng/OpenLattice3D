// Mesh simplification by quadric-error edge collapse (Garland & Heckbert).
//
// Marching cubes emits a uniform triangle density regardless of how much detail
// the surface actually carries, so a lattice exports far more triangles than
// its shape needs. Collapsing edges in order of the error they introduce trims
// the flat regions first and leaves the curvature alone.
//
// Watertightness is a hard constraint here, not a nice-to-have: the extractor
// output is manifold and closed, and simplification must not undo that. Every
// candidate collapse is therefore gated on the link condition, which is the
// exact combinatorial test for whether a collapse preserves the surface
// topology, and on a normal-flip check that rejects collapses which would fold
// geometry through itself.
import type { IndexedMesh } from './mesh-indexing';

export interface DecimateOptions {
  /** Fraction of triangles to keep, 0..1. */
  targetRatio: number;
  /**
   * Largest source-plane deviation any collapse may introduce, in mm.
   *
   * The raw quadric is a sum of squared distances to every source plane carried
   * by the two endpoint clusters. Requiring that sum to stay below
   * `maxError²` is conservative: every individual plane distance is then also
   * bounded by `maxError`. Do not average by plane count here; that turns the
   * tolerance into an RMS target and permits individual deviations above it.
   */
  maxError?: number;
}

export interface DecimateResult {
  mesh: IndexedMesh;
  collapsed: number;
  /** Collapses rejected because they would have broken the surface. */
  rejectedTopology: number;
  /** Collapses rejected because they exceeded maxError. */
  rejectedError: number;
}

/** Symmetric 4x4 quadric, stored as its 10 unique coefficients. */
type Quadric = Float64Array;

function addPlaneQuadric(q: Quadric, a: number, b: number, c: number, d: number): void {
  q[0] += a * a; q[1] += a * b; q[2] += a * c; q[3] += a * d;
  q[4] += b * b; q[5] += b * c; q[6] += b * d;
  q[7] += c * c; q[8] += c * d;
  q[9] += d * d;
}

function quadricError(q: Quadric, x: number, y: number, z: number): number {
  return q[0]*x*x + 2*q[1]*x*y + 2*q[2]*x*z + 2*q[3]*x
    + q[4]*y*y + 2*q[5]*y*z + 2*q[6]*y
    + q[7]*z*z + 2*q[8]*z
    + q[9];
}

class MinHeap {
  private cost: number[] = [];
  private payload: number[] = [];

  get size(): number { return this.cost.length; }

  push(cost: number, value: number): void {
    this.cost.push(cost);
    this.payload.push(value);
    let i = this.cost.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.cost[parent] <= this.cost[i]) break;
      this.swap(parent, i);
      i = parent;
    }
  }

  pop(): { cost: number; value: number } | null {
    if (this.cost.length === 0) return null;
    const top = { cost: this.cost[0], value: this.payload[0] };
    const lastCost = this.cost.pop()!;
    const lastValue = this.payload.pop()!;
    if (this.cost.length > 0) {
      this.cost[0] = lastCost;
      this.payload[0] = lastValue;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < this.cost.length && this.cost[l] < this.cost[smallest]) smallest = l;
        if (r < this.cost.length && this.cost[r] < this.cost[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const c = this.cost[a]; this.cost[a] = this.cost[b]; this.cost[b] = c;
    const p = this.payload[a]; this.payload[a] = this.payload[b]; this.payload[b] = p;
  }
}

/**
 * Simplify to roughly `targetRatio` of the original triangle count.
 *
 * Collapses go to one of the two endpoints rather than to a solved optimal
 * position. Solving places the new vertex off the surface, which is what makes
 * naive quadric decimators drift and self-intersect; snapping to an existing
 * vertex keeps every point of the result on the original surface, at a small
 * cost in how evenly the error is spread.
 */
export function decimateMesh(mesh: IndexedMesh, options: DecimateOptions): DecimateResult {
  const targetTriangles = Math.max(4, Math.floor(mesh.triangleCount * options.targetRatio));
  const result: DecimateResult = {
    mesh,
    collapsed: 0,
    rejectedTopology: 0,
    rejectedError: 0,
  };
  if (targetTriangles >= mesh.triangleCount) return result;

  const maxErrorSq = options.maxError !== undefined ? options.maxError * options.maxError : Infinity;
  const vertexCount = mesh.vertexCount;
  const positions = Float64Array.from(mesh.positions);
  const faces = Uint32Array.from(mesh.indices);
  const faceCount = mesh.triangleCount;
  const faceAlive = new Uint8Array(faceCount).fill(1);

  // Quadrics accumulate the squared distance to the planes of incident faces.
  const quadrics: Quadric[] = Array.from({ length: vertexCount }, () => new Float64Array(10));
  const vertexFaces: number[][] = Array.from({ length: vertexCount }, () => []);
  const ring: Set<number>[] = Array.from({ length: vertexCount }, () => new Set<number>());

  for (let f = 0; f < faceCount; f++) {
    const a = faces[f * 3], b = faces[f * 3 + 1], c = faces[f * 3 + 2];
    vertexFaces[a].push(f); vertexFaces[b].push(f); vertexFaces[c].push(f);
    ring[a].add(b); ring[a].add(c);
    ring[b].add(a); ring[b].add(c);
    ring[c].add(a); ring[c].add(b);

    const ax = positions[a*3], ay = positions[a*3+1], az = positions[a*3+2];
    const e1x = positions[b*3] - ax, e1y = positions[b*3+1] - ay, e1z = positions[b*3+2] - az;
    const e2x = positions[c*3] - ax, e2y = positions[c*3+1] - ay, e2z = positions[c*3+2] - az;
    let nx = e1y*e2z - e1z*e2y, ny = e1z*e2x - e1x*e2z, nz = e1x*e2y - e1y*e2x;
    const len = Math.sqrt(nx*nx + ny*ny + nz*nz);
    if (len < 1e-20) continue;
    nx /= len; ny /= len; nz /= len;
    const d = -(nx*ax + ny*ay + nz*az);
    for (const v of [a, b, c]) addPlaneQuadric(quadrics[v], nx, ny, nz, d);
  }

  const alive = new Uint8Array(vertexCount).fill(1);
  // Bumped whenever a vertex changes, so stale heap entries can be discarded.
  const version = new Uint32Array(vertexCount);

  const collapseCost = (u: number, v: number): { cost: number; to: number } => {
    const q = quadrics[u];
    const q2 = quadrics[v];
    const sum = new Float64Array(10);
    for (let i = 0; i < 10; i++) sum[i] = q[i] + q2[i];
    const costU = Math.abs(quadricError(sum, positions[u*3], positions[u*3+1], positions[u*3+2]));
    const costV = Math.abs(quadricError(sum, positions[v*3], positions[v*3+1], positions[v*3+2]));
    return costU <= costV
      ? { cost: costU, to: u }
      : { cost: costV, to: v };
  };

  // Edges are keyed as a single number so the heap can carry them as payload.
  const edgeId = (u: number, v: number) => (u < v ? u * vertexCount + v : v * vertexCount + u);
  const edgeEnds = (id: number): [number, number] => [Math.floor(id / vertexCount), id % vertexCount];

  const heap = new MinHeap();
  const stamp = new Map<number, number>();
  const pushEdge = (u: number, v: number) => {
    const { cost } = collapseCost(u, v);
    const id = edgeId(u, v);
    stamp.set(id, version[u] + version[v]);
    heap.push(cost, id);
  };

  for (let v = 0; v < vertexCount; v++) {
    for (const n of ring[v]) if (n > v) pushEdge(v, n);
  }

  /**
   * The link condition: collapsing (u,v) preserves a manifold surface exactly
   * when the vertices shared by both one-rings are precisely the two opposite
   * the edge. Any extra shared neighbour would become a non-manifold junction.
   */
  const linkConditionHolds = (u: number, v: number): boolean => {
    const opposites: number[] = [];
    for (const f of vertexFaces[u]) {
      if (!faceAlive[f]) continue;
      const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
      if (a !== v && b !== v && c !== v) continue;
      for (const w of [a, b, c]) if (w !== u && w !== v) opposites.push(w);
    }
    if (opposites.length !== 2) return false;   // boundary or non-manifold edge

    let shared = 0;
    for (const n of ring[u]) {
      if (!alive[n] || !ring[v].has(n)) continue;
      if (!opposites.includes(n)) return false;
      shared++;
    }
    return shared === opposites.length;
  };

  const wouldFlipNormal = (from: number, to: number): boolean => {
    for (const f of vertexFaces[from]) {
      if (!faceAlive[f]) continue;
      const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
      if (a === to || b === to || c === to) continue;   // face disappears anyway
      const pick = (v: number, axis: number) =>
        positions[(v === from ? to : v) * 3 + axis];

      const bx = positions[a*3], by = positions[a*3+1], bz = positions[a*3+2];
      let e1x = positions[b*3] - bx, e1y = positions[b*3+1] - by, e1z = positions[b*3+2] - bz;
      let e2x = positions[c*3] - bx, e2y = positions[c*3+1] - by, e2z = positions[c*3+2] - bz;
      const beforeX = e1y*e2z - e1z*e2y, beforeY = e1z*e2x - e1x*e2z, beforeZ = e1x*e2y - e1y*e2x;

      const nax = pick(a, 0), nay = pick(a, 1), naz = pick(a, 2);
      e1x = pick(b, 0) - nax; e1y = pick(b, 1) - nay; e1z = pick(b, 2) - naz;
      e2x = pick(c, 0) - nax; e2y = pick(c, 1) - nay; e2z = pick(c, 2) - naz;
      const afterX = e1y*e2z - e1z*e2y, afterY = e1z*e2x - e1x*e2z, afterZ = e1x*e2y - e1y*e2x;

      if (beforeX*afterX + beforeY*afterY + beforeZ*afterZ <= 0) return true;
    }
    return false;
  };

  let liveTriangles = faceCount;

  while (liveTriangles > targetTriangles) {
    const top = heap.pop();
    if (!top) break;

    const [u, v] = edgeEnds(top.value);
    if (!alive[u] || !alive[v]) continue;
    if (stamp.get(top.value) !== version[u] + version[v]) continue;   // stale
    if (!ring[u].has(v)) continue;

    if (top.cost > maxErrorSq) { result.rejectedError++; continue; }
    if (!linkConditionHolds(u, v)) { result.rejectedTopology++; continue; }

    const { to } = collapseCost(u, v);
    const from = to === u ? v : u;
    if (wouldFlipNormal(from, to)) { result.rejectedTopology++; continue; }

    // Retire the faces that contained the edge, then rewrite the rest.
    for (const f of vertexFaces[from]) {
      if (!faceAlive[f]) continue;
      const a = faces[f*3], b = faces[f*3+1], c = faces[f*3+2];
      if (a === to || b === to || c === to) {
        faceAlive[f] = 0;
        liveTriangles--;
        continue;
      }
      for (let k = 0; k < 3; k++) if (faces[f*3+k] === from) faces[f*3+k] = to;
      vertexFaces[to].push(f);
    }

    for (let i = 0; i < 10; i++) quadrics[to][i] += quadrics[from][i];
    for (const n of ring[from]) {
      if (n === to || !alive[n]) continue;
      ring[n].delete(from);
      ring[n].add(to);
      ring[to].add(n);
    }
    ring[to].delete(from);
    alive[from] = 0;
    version[to]++;
    result.collapsed++;

    for (const n of ring[to]) {
      if (alive[n]) { version[n]++; }
    }
    for (const n of ring[to]) {
      if (alive[n]) pushEdge(to, n);
    }
  }

  // Compact to the surviving vertices and faces.
  const remap = new Int32Array(vertexCount).fill(-1);
  const outPositions: number[] = [];
  const outIndices: number[] = [];
  for (let f = 0; f < faceCount; f++) {
    if (!faceAlive[f]) continue;
    const tri: number[] = [];
    for (let k = 0; k < 3; k++) {
      const v = faces[f*3+k];
      if (remap[v] < 0) {
        remap[v] = outPositions.length / 3;
        outPositions.push(positions[v*3], positions[v*3+1], positions[v*3+2]);
      }
      tri.push(remap[v]);
    }
    if (tri[0] === tri[1] || tri[1] === tri[2] || tri[0] === tri[2]) continue;
    outIndices.push(tri[0], tri[1], tri[2]);
  }

  result.mesh = {
    positions: Float32Array.from(outPositions),
    indices: Uint32Array.from(outIndices),
    vertexCount: outPositions.length / 3,
    triangleCount: outIndices.length / 3,
  };
  return result;
}
