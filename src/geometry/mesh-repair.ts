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
import type { MarchingCubesResult } from './marching-cubes';

export interface RepairReport {
  /** Loops found and filled. */
  loopsClosed: number;
  trianglesAdded: number;
  /** Loops abandoned — a branching boundary, which fan-filling cannot resolve. */
  loopsUnresolved: number;
}

function normalizeZeroBits(bits: number): number {
  return bits === 0x80000000 ? 0 : bits;
}

/**
 * Weld by exact float bits. Marching cubes derives each vertex from the two
 * field values on one grid edge, so the same edge seen from adjacent cubes
 * produces bit-identical coordinates.
 */
function buildVertexIds(positions: Float32Array, triCount: number): Int32Array {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const ids = new Int32Array(triCount * 3);
  const lookup = new Map<string, number>();

  for (let i = 0; i < triCount * 3; i++) {
    const o = i * 3;
    const key = `${normalizeZeroBits(bits[o])},${normalizeZeroBits(bits[o + 1])},${normalizeZeroBits(bits[o + 2])}`;
    let id = lookup.get(key);
    if (id === undefined) {
      id = lookup.size;
      lookup.set(key, id);
    }
    ids[i] = id;
  }

  return ids;
}

/**
 * Fill unmatched edge loops so the surface is closed.
 *
 * Fill triangles are wound opposite to the edges they close against, which is
 * what makes the patch face the same way as the surface around it.
 */
export function closeBoundaryLoops(
  result: MarchingCubesResult
): { result: MarchingCubesResult; report: RepairReport } {
  const { positions, normals, triCount } = result;
  const ids = buildVertexIds(positions, triCount);

  // Count edge use, ignoring degenerate triangles which have no edges to match.
  const use = new Map<number, number>();
  const edgeKey = (a: number, b: number) => (a < b ? a * 2147483648 + b : b * 2147483648 + a);
  for (let i = 0; i < triCount; i++) {
    const a = ids[i * 3], b = ids[i * 3 + 1], c = ids[i * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = edgeKey(u, v);
      use.set(k, (use.get(k) ?? 0) + 1);
    }
  }

  // Directed unmatched edges, in the orientation their owning triangle used.
  const next = new Map<number, number>();
  for (let i = 0; i < triCount; i++) {
    const a = ids[i * 3], b = ids[i * 3 + 1], c = ids[i * 3 + 2];
    if (a === b || b === c || a === c) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (use.get(edgeKey(u, v)) === 1) next.set(u, v);
    }
  }

  const report: RepairReport = { loopsClosed: 0, trianglesAdded: 0, loopsUnresolved: 0 };
  if (next.size === 0) return { result, report };

  // Position lookup for emitting fill triangles.
  const vertexPos = new Map<number, [number, number, number]>();
  for (let i = 0; i < triCount * 3; i++) {
    const id = ids[i];
    if (!vertexPos.has(id)) {
      vertexPos.set(id, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]]);
    }
  }

  const visited = new Set<number>();
  const fills: number[][] = [];

  for (const start of next.keys()) {
    if (visited.has(start)) continue;

    const loop: number[] = [];
    let current = start;
    let ok = false;
    // Bounded so a branching boundary cannot spin forever.
    for (let step = 0; step <= next.size; step++) {
      if (visited.has(current)) break;
      visited.add(current);
      loop.push(current);
      const following = next.get(current);
      if (following === undefined) break;
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

  if (report.trianglesAdded === 0) return { result, report };

  const total = triCount + report.trianglesAdded;
  const outPositions = new Float32Array(total * 9);
  const outNormals = new Float32Array(total * 3);
  outPositions.set(positions.subarray(0, triCount * 9));
  outNormals.set(normals.subarray(0, triCount * 3));

  let tri = triCount;
  for (const loop of fills) {
    const anchor = vertexPos.get(loop[0])!;
    // Reversed fan: the loop runs along edges the surface already owns, so the
    // patch must wind the other way to face outward with them.
    for (let i = loop.length - 1; i >= 2; i--) {
      const b = vertexPos.get(loop[i])!;
      const c = vertexPos.get(loop[i - 1])!;
      const o = tri * 9;
      outPositions[o] = anchor[0]; outPositions[o + 1] = anchor[1]; outPositions[o + 2] = anchor[2];
      outPositions[o + 3] = b[0]; outPositions[o + 4] = b[1]; outPositions[o + 5] = b[2];
      outPositions[o + 6] = c[0]; outPositions[o + 7] = c[1]; outPositions[o + 8] = c[2];

      const e1x = b[0] - anchor[0], e1y = b[1] - anchor[1], e1z = b[2] - anchor[2];
      const e2x = c[0] - anchor[0], e2y = c[1] - anchor[1], e2z = c[2] - anchor[2];
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
