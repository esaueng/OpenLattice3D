import { describe, expect, it } from 'vitest';
import { exportBinarySTL, parseSTL } from './stl-parser';

function makeBinarySTL(triangles: number[][][], declaredCount?: number): ArrayBuffer {
  const triCount = triangles.length;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, declaredCount ?? triCount, true);
  for (let i = 0; i < triCount; i++) {
    const offset = 84 + i * 50;
    for (let v = 0; v < 3; v++) {
      const vert = triangles[i][v];
      view.setFloat32(offset + 12 + v * 12, vert[0], true);
      view.setFloat32(offset + 12 + v * 12 + 4, vert[1], true);
      view.setFloat32(offset + 12 + v * 12 + 8, vert[2], true);
    }
  }
  return buffer;
}

const UNIT_TRI = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];

describe('parseSTL binary', () => {
  it('parses a single-triangle binary STL', () => {
    const mesh = parseSTL(makeBinarySTL([UNIT_TRI]));
    expect(mesh.triCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('rejects files smaller than the binary header', () => {
    expect(() => parseSTL(new ArrayBuffer(10))).toThrow(/too small/);
  });

  it('rejects truncated binary files with an oversized declared count', () => {
    // Declares 1,000,000 triangles but contains one: must throw, not allocate.
    expect(() => parseSTL(makeBinarySTL([UNIT_TRI], 1_000_000))).toThrow(/declares 1000000 triangles/);
  });

  it('rejects binary files declaring zero triangles', () => {
    expect(() => parseSTL(makeBinarySTL([], 0))).toThrow(/no triangles/);
  });

  it('parses a binary STL whose header begins with "solid"', () => {
    const buffer = makeBinarySTL([UNIT_TRI]);
    new Uint8Array(buffer, 0, 5).set(new TextEncoder().encode('solid'));
    const mesh = parseSTL(buffer);
    expect(mesh.triCount).toBe(1);
  });
});

describe('parseSTL ascii', () => {
  const ascii = `solid test
  facet normal 0 0 1
    outer loop
      vertex 0 0 0
      vertex 1 0 0
      vertex 0 1 0
    endloop
  endfacet
endsolid test`;

  it('parses an ASCII STL', () => {
    const mesh = parseSTL(new TextEncoder().encode(ascii).buffer as ArrayBuffer);
    expect(mesh.triCount).toBe(1);
    expect(mesh.normals[2]).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('parses an ASCII STL smaller than the 84-byte binary header', () => {
    const tiny = 'solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid';
    const mesh = parseSTL(new TextEncoder().encode(tiny).buffer as ArrayBuffer);
    expect(mesh.triCount).toBe(1);
  });

  it('rejects a "solid"-prefixed file with no facets and no binary payload', () => {
    const empty = new TextEncoder().encode('solid nothing here endsolid').buffer as ArrayBuffer;
    expect(() => parseSTL(empty)).toThrow(/no facets/);
  });
});

describe('export round trip', () => {
  it('round-trips positions, normals, and triCount through binary export', () => {
    const positions = new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0, 1, 1, 1, 2, 1, 1, 1, 2, 1]);
    const normals = new Float32Array([0, 0, 1, 0, 0, -1]);
    const buffer = exportBinarySTL(positions, normals, 2);
    const mesh = parseSTL(buffer);
    expect(mesh.triCount).toBe(2);
    expect(Array.from(mesh.positions)).toEqual(Array.from(positions));
    expect(Array.from(mesh.normals)).toEqual(Array.from(normals));
  });
});
