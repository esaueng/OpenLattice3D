// Turning triangle soup into shared vertices plus an index buffer.
//
// Marching cubes writes three independent vertices per triangle, but derives
// each from the two field values on one grid edge — so the same edge visited
// from adjacent cubes yields bit-identical coordinates. Welding on exact bits
// is therefore both correct and complete; a positional tolerance could only
// over-merge distinct vertices.
import type { MarchingCubesResult } from './marching-cubes';

export interface IndexedMesh {
  /** Unique vertices, 3 floats each. */
  positions: Float32Array;
  /** Three indices per triangle, in the source winding. */
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
}

function normalizeZeroBits(bits: number): number {
  return bits === 0x80000000 ? 0 : bits;
}

/**
 * Weld by exact position and drop degenerate triangles.
 *
 * Degenerates carry no surface and are rejected outright by 3MF consumers, so
 * they are removed here rather than exported and repaired downstream.
 */
export function buildIndexedMesh(result: MarchingCubesResult): IndexedMesh {
  const { positions, triCount } = result;
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);

  const lookup = new Map<string, number>();
  const uniqueX: number[] = [];
  const uniqueY: number[] = [];
  const uniqueZ: number[] = [];
  const indices: number[] = [];

  const idAt = (corner: number): number => {
    const o = corner * 3;
    const key = `${normalizeZeroBits(bits[o])},${normalizeZeroBits(bits[o + 1])},${normalizeZeroBits(bits[o + 2])}`;
    const existing = lookup.get(key);
    if (existing !== undefined) return existing;
    const id = uniqueX.length;
    lookup.set(key, id);
    uniqueX.push(positions[o]);
    uniqueY.push(positions[o + 1]);
    uniqueZ.push(positions[o + 2]);
    return id;
  };

  for (let i = 0; i < triCount; i++) {
    const a = idAt(i * 3);
    const b = idAt(i * 3 + 1);
    const c = idAt(i * 3 + 2);
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }

  const out = new Float32Array(uniqueX.length * 3);
  for (let i = 0; i < uniqueX.length; i++) {
    out[i * 3] = uniqueX[i];
    out[i * 3 + 1] = uniqueY[i];
    out[i * 3 + 2] = uniqueZ[i];
  }

  return {
    positions: out,
    indices: Uint32Array.from(indices),
    vertexCount: uniqueX.length,
    triangleCount: indices.length / 3,
  };
}
