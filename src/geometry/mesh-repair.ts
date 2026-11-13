// Closing the cracks marching cubes leaves behind.
//
// The classic marching-cubes tables resolve each cube independently, so two
// neighbours sharing an ambiguous face can pick incompatible triangulations and
// leave a small gap between them. Measured on a default gyroid sphere that is
// around 190 unmatched edges — constant across resolutions 48, 96 and 168 —
// against zero non-manifold edges. The surface is otherwise sound; it just has
// pinholes.
//
// Preventing them at source means the MC33 disambiguation tables. Closing them
// afterwards is far smaller and is directly verifiable: the boundary-edge count
// is zero or it is not. It also repairs seams from tiled generation, which no
// per-cube rule could.
//
// The pinholes are few (tens of four-vertex loops on a million-triangle part)
// but finding them means welding and edge-counting the whole mesh, so the cost
// is all in the per-triangle passes, which run on flat typed arrays. See
// docs/performance/boundary-loop-cleanup.md for measurements.
import { assertGenerationOutputBudget } from './generation-limits';
import type { MarchingCubesResult } from './marching-cubes';

export interface RepairReport {
  /** Loops found and filled. */
  loopsClosed: number;
  trianglesAdded: number;
  /** Loops abandoned — a branching boundary, which fan-filling cannot resolve. */
  loopsUnresolved: number;
}

/**
 * Work done by closeBoundaryLoops, for complexity regression tests. Every
 * field grows linearly with the input while hashing behaves, so a quadratic
 * regression shows up as a ratio rather than as a wall-clock threshold.
 */
export interface RepairWorkCounters {
  /** Vertex references (three per input triangle) welded. */
  corners: number;
  /** Hash-table slots inspected while welding vertices. */
  weldProbes: number;
  /** Bucketed edge entries visited while counting edge uses. */
  edgeVisits: number;
  /** Vertices visited while walking boundary loops. */
  loopSteps: number;
}

const EMPTY = -1;
const NEGATIVE_ZERO_BITS = 0x80000000;

function tableSize(minimum: number): number {
  let size = 16;
  while (size < minimum) size *= 2;
  return size;
}

// MurmurHash3 x86_32 over the three coordinate words. Float bit patterns of
// grid-derived vertices differ mostly in low mantissa bits, so a weak mix
// clusters them in a linear-probing table.
function murmurWord(h: number, k: number): number {
  k = Math.imul(k, 0xcc9e2d51);
  k = (k << 15) | (k >>> 17);
  h ^= Math.imul(k, 0x1b873593);
  h = (h << 13) | (h >>> 19);
  return (Math.imul(h, 5) + 0xe6546b64) | 0;
}

function hashVertex(x: number, y: number, z: number): number {
  let h = murmurWord(murmurWord(murmurWord(0, x), y), z) ^ 12;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return h ^ (h >>> 16);
}

interface WeldedVertices {
  /** Vertex id per corner, assigned in first-occurrence order. */
  ids: Int32Array;
  /** First corner that produced each vertex id. */
  firstCorner: Int32Array;
  vertexCount: number;
}

/**
 * Weld by exact float bits. Marching cubes derives each vertex from the two
 * field values on one grid edge, so the same edge seen from adjacent cubes
 * produces bit-identical coordinates. Negative zero welds with positive zero.
 *
 * The interleaved [x, y, z, id] table keeps a probe on one cache line, and ids
 * follow first occurrence exactly as an insertion-ordered Map would.
 */
function weldVertices(positions: Float32Array, triCount: number, work: RepairWorkCounters): WeldedVertices {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const corners = triCount * 3;
  const ids = new Int32Array(corners);
  const firstCorner = new Int32Array(corners);
  // Closed marching-cubes surfaces carry about one vertex per six corners, so
  // this starts well under half full; a triangle soup grows it by doubling.
  let capacity = tableSize(Math.ceil(corners / 2));
  let mask = capacity - 1;
  let table = new Int32Array(capacity * 4).fill(EMPTY);
  let vertexCount = 0;
  let probes = 0;

  for (let i = 0; i < corners; i++) {
    const o = i * 3;
    const x = bits[o] === NEGATIVE_ZERO_BITS ? 0 : bits[o];
    const y = bits[o + 1] === NEGATIVE_ZERO_BITS ? 0 : bits[o + 1];
    const z = bits[o + 2] === NEGATIVE_ZERO_BITS ? 0 : bits[o + 2];
    // Int32 views of the same bits, for comparison against the Int32 table.
    const xi = x | 0, yi = y | 0, zi = z | 0;
    let slot = hashVertex(xi, yi, zi) & mask;
    let id = EMPTY;
    for (;;) {
      probes++;
      const t = slot * 4;
      const stored = table[t + 3];
      if (stored === EMPTY) break;
      if (table[t] === xi && table[t + 1] === yi && table[t + 2] === zi) {
        id = stored;
        break;
      }
      slot = (slot + 1) & mask;
    }

    if (id === EMPTY) {
      id = vertexCount++;
      firstCorner[id] = i;
      const t = slot * 4;
      table[t] = xi; table[t + 1] = yi; table[t + 2] = zi; table[t + 3] = id;

      if (vertexCount * 2 > capacity) {
        const old = table;
        capacity *= 2;
        mask = capacity - 1;
        table = new Int32Array(capacity * 4).fill(EMPTY);
        for (let s = 0; s < old.length; s += 4) {
          if (old[s + 3] === EMPTY) continue;
          let r = hashVertex(old[s], old[s + 1], old[s + 2]) & mask;
          while (table[r * 4 + 3] !== EMPTY) r = (r + 1) & mask;
          table.set(old.subarray(s, s + 4), r * 4);
        }
      }
    }
    ids[i] = id;
  }

  work.weldProbes += probes;
  return { ids, firstCorner, vertexCount };
}

/**
 * Flag each corner whose outgoing triangle edge is an undirected edge used by
 * exactly one non-degenerate triangle. Corner k of a triangle owns the edge
 * from its vertex k to vertex (k + 1) % 3.
 *
 * Edges are bucketed under their lower vertex id (a counting sort, so no
 * hashing), then uses are counted within each bucket against a per-vertex tag.
 * Vertex ids follow first occurrence, so buckets touched by nearby triangles
 * sit near each other in memory.
 */
function findUnmatchedEdges(
  ids: Int32Array,
  triCount: number,
  vertexCount: number,
  work: RepairWorkCounters,
): Uint8Array {
  const corners = triCount * 3;
  // offsets[v] ends as the first slot of bucket v; offsets[vertexCount] is the total.
  const offsets = new Int32Array(vertexCount + 1);
  for (let i = 0; i < corners; i += 3) {
    const a = ids[i], b = ids[i + 1], c = ids[i + 2];
    if (a === b || b === c || a === c) continue;
    offsets[a < b ? a : b]++;
    offsets[b < c ? b : c]++;
    offsets[c < a ? c : a]++;
  }
  let total = 0;
  for (let v = 0; v < vertexCount; v++) {
    total += offsets[v];
    offsets[v] = total;
  }
  offsets[vertexCount] = total;

  const edgeHi = new Int32Array(total);
  const edgeCorner = new Int32Array(total);
  for (let i = 0; i < corners; i += 3) {
    const a = ids[i], b = ids[i + 1], c = ids[i + 2];
    if (a === b || b === c || a === c) continue;
    let p = --offsets[a < b ? a : b];
    edgeHi[p] = a < b ? b : a; edgeCorner[p] = i;
    p = --offsets[b < c ? b : c];
    edgeHi[p] = b < c ? c : b; edgeCorner[p] = i + 1;
    p = --offsets[c < a ? c : a];
    edgeHi[p] = c < a ? a : c; edgeCorner[p] = i + 2;
  }

  // tag[hi] names the bucket that last counted hi; uses saturate at 2 since
  // only "exactly one" matters.
  const tag = new Int32Array(vertexCount).fill(EMPTY);
  const uses = new Uint8Array(vertexCount);
  const unmatched = new Uint8Array(corners);
  for (let lo = 0; lo < vertexCount; lo++) {
    const begin = offsets[lo], end = offsets[lo + 1];
    for (let p = begin; p < end; p++) {
      const hi = edgeHi[p];
      if (tag[hi] !== lo) {
        tag[hi] = lo;
        uses[hi] = 1;
      } else {
        uses[hi] = 2;
      }
    }
    for (let p = begin; p < end; p++) {
      if (uses[edgeHi[p]] === 1) unmatched[edgeCorner[p]] = 1;
    }
  }
  work.edgeVisits += total * 2;
  return unmatched;
}

/**
 * Fill unmatched edge loops so the surface is closed.
 *
 * Fill triangles are wound opposite to the edges they close against, which is
 * what makes the patch face the same way as the surface around it.
 *
 * Linear in the triangle count: vertices are welded through a typed-array
 * hash table, edges are counted by bucketing under their lower vertex, and
 * each boundary vertex is walked at most once. Pass `counters` to accumulate
 * the work done.
 */
export function closeBoundaryLoops(
  result: MarchingCubesResult,
  counters?: RepairWorkCounters,
): { result: MarchingCubesResult; report: RepairReport } {
  const { positions, normals, triCount } = result;
  const work: RepairWorkCounters = counters ?? { corners: 0, weldProbes: 0, edgeVisits: 0, loopSteps: 0 };
  work.corners += triCount * 3;
  const { ids, firstCorner, vertexCount } = weldVertices(positions, triCount, work);
  const unmatched = findUnmatchedEdges(ids, triCount, vertexCount, work);

  // Directed unmatched edges, in the orientation their owning triangle used.
  // A vertex that starts several edges keeps the last one seen, and loops are
  // tried from vertices in the order they first started an edge.
  const next = new Int32Array(vertexCount).fill(EMPTY);
  const starts: number[] = [];
  for (let k = 0; k < triCount * 3; k++) {
    if (unmatched[k] === 0) continue;
    const u = ids[k];
    const v = k % 3 === 2 ? ids[k - 2] : ids[k + 1];
    if (next[u] === EMPTY) starts.push(u);
    next[u] = v;
  }

  const report: RepairReport = { loopsClosed: 0, trianglesAdded: 0, loopsUnresolved: 0 };
  if (starts.length === 0) return { result, report };

  const visited = new Uint8Array(vertexCount);
  const fills: number[][] = [];
  let loopSteps = 0;

  for (const start of starts) {
    if (visited[start]) continue;

    const loop: number[] = [];
    let current = start;
    let ok = false;
    // Bounded so a branching boundary cannot spin forever.
    for (let step = 0; step <= starts.length; step++) {
      if (visited[current]) break;
      visited[current] = 1;
      loopSteps++;
      loop.push(current);
      const following = next[current];
      if (following === EMPTY) break;
      if (following === start) { ok = true; break; }
      current = following;
    }

    if (!ok || loop.length < 3) {
      report.loopsUnresolved++;
      continue;
    }
    fills.push(loop);
    report.loopsClosed++;
    report.trianglesAdded += loop.length - 2;
  }
  work.loopSteps += loopSteps;

  if (report.trianglesAdded === 0) return { result, report };

  const total = triCount + report.trianglesAdded;
  assertGenerationOutputBudget(total);
  const outPositions = new Float32Array(total * 9);
  const outNormals = new Float32Array(total * 3);
  outPositions.set(positions.subarray(0, triCount * 9));
  outNormals.set(normals.subarray(0, triCount * 3));

  let tri = triCount;
  for (const loop of fills) {
    // Each vertex takes the coordinates of the first corner that produced it.
    const ao = firstCorner[loop[0]] * 3;
    const ax = positions[ao], ay = positions[ao + 1], az = positions[ao + 2];
    // Reversed fan: the loop runs along edges the surface already owns, so the
    // patch must wind the other way to face outward with them.
    for (let i = loop.length - 1; i >= 2; i--) {
      const bo = firstCorner[loop[i]] * 3;
      const co = firstCorner[loop[i - 1]] * 3;
      const bx = positions[bo], by = positions[bo + 1], bz = positions[bo + 2];
      const cx = positions[co], cy = positions[co + 1], cz = positions[co + 2];
      const o = tri * 9;
      outPositions[o] = ax; outPositions[o + 1] = ay; outPositions[o + 2] = az;
      outPositions[o + 3] = bx; outPositions[o + 4] = by; outPositions[o + 5] = bz;
      outPositions[o + 6] = cx; outPositions[o + 7] = cy; outPositions[o + 8] = cz;

      const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
      const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      const n = tri * 3;
      if (len > 1e-12) {
        outNormals[n] = nx / len; outNormals[n + 1] = ny / len; outNormals[n + 2] = nz / len;
      }
      tri++;
    }
  }

  return {
    result: { positions: outPositions, normals: outNormals, triCount: total },
    report,
  };
}
