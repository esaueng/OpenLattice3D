// Shared triangle-soup topology: exact vertex welding, edge→triangle
// lists, and connected components. Used by validation checks and by
// disconnected-fragment cleanup after marching cubes.

export interface EdgeTopology {
  /** For each unique edge, the indices of triangles sharing it. */
  edgeTriangleLists: number[][];
  triCount: number;
}

function vertexBucketKey(qx: number, qy: number, qz: number): number {
  let h = 2166136261;
  h = Math.imul(h ^ qx, 16777619);
  h = Math.imul(h ^ qy, 16777619);
  h = Math.imul(h ^ qz, 16777619);
  return h >>> 0;
}

function normalizeZeroBits(bits: number): number {
  return bits === 0x80000000 ? 0 : bits;
}

function getExactVertexId(
  buckets: Map<number, number[]>,
  bxById: number[],
  byById: number[],
  bzById: number[],
  bx: number,
  by: number,
  bz: number
): number {
  const bucketKey = vertexBucketKey(bx, by, bz);
  let bucket = buckets.get(bucketKey);
  if (bucket) {
    for (let i = 0; i < bucket.length; i++) {
      const id = bucket[i];
      if (bxById[id] === bx && byById[id] === by && bzById[id] === bz) return id;
    }
  } else {
    bucket = [];
    buckets.set(bucketKey, bucket);
  }

  const id = bxById.length;
  bxById.push(bx);
  byById.push(by);
  bzById.push(bz);
  bucket.push(id);
  return id;
}

/** Build edge→triangle topology from a flat triangle soup.
 *  Vertex identity is the exact float bits. Marching cubes derives the same
 *  shared-edge vertex bit-for-bit in adjacent cubes; rounding distinct nearby
 *  vertices together invents non-manifold edges as resolution increases.
 *  Edge keys are exact for any vertex count (nested maps, no number packing). */
export function buildEdgeTopology(positions: Float32Array, triCount: number): EdgeTopology {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const buckets = new Map<number, number[]>();
  const bxById: number[] = [];
  const byById: number[] = [];
  const bzById: number[] = [];
  const edgesByLo = new Map<number, Map<number, number[]>>();
  const edgeTriangleLists: number[][] = [];

  const vertexId = (offset: number) => getExactVertexId(
    buckets,
    bxById,
    byById,
    bzById,
    normalizeZeroBits(bits[offset]),
    normalizeZeroBits(bits[offset + 1]),
    normalizeZeroBits(bits[offset + 2])
  );

  const addEdge = (a: number, b: number, triIndex: number) => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    let inner = edgesByLo.get(lo);
    if (!inner) {
      inner = new Map();
      edgesByLo.set(lo, inner);
    }
    let list = inner.get(hi);
    if (!list) {
      list = [];
      inner.set(hi, list);
      edgeTriangleLists.push(list);
    }
    list.push(triIndex);
  };

  for (let i = 0; i < triCount; i++) {
    const base = i * 9;
    const v0 = vertexId(base);
    const v1 = vertexId(base + 3);
    const v2 = vertexId(base + 6);
    if (v0 === v1 || v1 === v2 || v0 === v2) continue;
    addEdge(v0, v1, i);
    addEdge(v1, v2, i);
    addEdge(v2, v0, i);
  }

  return { edgeTriangleLists, triCount };
}

/** Count boundary (1 triangle) and non-manifold (>2 triangles) edges. */
export function countEdgeDefects(topology: EdgeTopology): { boundaryEdges: number; nonManifoldEdges: number } {
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  for (const tris of topology.edgeTriangleLists) {
    if (tris.length === 1) boundaryEdges++;
    else if (tris.length > 2) nonManifoldEdges++;
  }
  return { boundaryEdges, nonManifoldEdges };
}

/** Edge-connected components as lists of triangle indices. */
export function findConnectedComponents(topology: EdgeTopology): number[][] {
  const { edgeTriangleLists, triCount } = topology;
  if (triCount === 0) return [];

  const adj: number[][] = Array.from({ length: triCount }, () => []);
  for (const tris of edgeTriangleLists) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].push(tris[j]);
        adj[tris[j]].push(tris[i]);
      }
    }
  }

  const visited = new Uint8Array(triCount);
  const components: number[][] = [];
  for (let i = 0; i < triCount; i++) {
    if (visited[i]) continue;
    const component: number[] = [];
    const stack = [i];
    while (stack.length > 0) {
      const t = stack.pop()!;
      if (visited[t]) continue;
      visited[t] = 1;
      component.push(t);
      for (const nb of adj[t]) {
        if (!visited[nb]) stack.push(nb);
      }
    }
    components.push(component);
  }
  return components;
}
