import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { exportBinarySTL, parseSTL } from './stl-parser';
import { DEFAULT_IMPORT_LIMITS, MAX_MESH_TRIANGLES, MAX_STL_FILE_BYTES, type ImportLimits } from './mesh-limits';

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

  it('rejects binary meshes with unreasonable coordinates', () => {
    expect(() => parseSTL(makeBinarySTL([[[0, 0, 0], [1e20, 0, 0], [0, 1, 0]]]))).toThrow(/coordinate/);
  });

  it('parses a binary STL whose header begins with "solid"', () => {
    const buffer = makeBinarySTL([UNIT_TRI]);
    new Uint8Array(buffer, 0, 5).set(new TextEncoder().encode('solid'));
    const mesh = parseSTL(buffer);
    expect(mesh.triCount).toBe(1);
  });
});

describe('parseSTL import limits', () => {
  // Small budgets keep the boundary cases fast; the defaults have their own
  // oversized-declaration and byte-cap coverage below.
  const tinyLimits: ImportLimits = { maxStlBytes: 1024, maxTriangles: 2, maxEmbeddedStlBytes: 1024, maxProjectBytes: 1024 };

  it('accepts a binary file at the byte budget and rejects one byte over', () => {
    const buffer = makeBinarySTL([UNIT_TRI]);
    expect(buffer.byteLength).toBe(134);
    const atBudget: ImportLimits = { ...tinyLimits, maxStlBytes: 134 };
    expect(parseSTL(buffer, atBudget).triCount).toBe(1);
    expect(() => parseSTL(buffer, { ...tinyLimits, maxStlBytes: 133 })).toThrow(/134 B, exceeding the 133 B import limit/);
  });

  it('rejects a file over the default byte budget before scanning it', () => {
    expect(() => parseSTL(new ArrayBuffer(MAX_STL_FILE_BYTES + 1))).toThrow(/exceeding the 128 MiB import limit/);
  });

  it('accepts a binary file at the triangle budget and rejects one triangle over', () => {
    const buffer = makeBinarySTL([UNIT_TRI, UNIT_TRI], 2);
    expect(parseSTL(buffer, tinyLimits).triCount).toBe(2);
    expect(() => parseSTL(buffer, { ...tinyLimits, maxTriangles: 1 })).toThrow(/declares 2 triangles, exceeding the supported limit of 1/);
  });

  it('rejects oversized declarations before sizing allocations, even with ample file bytes', () => {
    // Declared count above the default cap with a matching (sparse) byte
    // length must hit the triangle limit, not allocation or the byte check.
    expect(() => parseSTL(makeBinarySTL([UNIT_TRI], MAX_MESH_TRIANGLES + 1), tinyLimits))
      .toThrow(/declares 5000001 triangles, exceeding the supported limit of 2/);
    expect(() => parseSTL(makeBinarySTL([UNIT_TRI], MAX_MESH_TRIANGLES + 1)))
      .toThrow(/exceeding the supported limit of 5000000/);
  });

  it('stops ASCII parsing at the facet budget instead of growing unbounded arrays', () => {
    const facet = 'facet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\n';
    const ascii = `solid t\n${facet}${facet}${facet}endsolid t`;
    const buffer = new TextEncoder().encode(ascii).buffer as ArrayBuffer;
    expect(() => parseSTL(buffer, tinyLimits)).toThrow(/triangle count exceeds the supported limit of 2/);
    const twoFacets = `solid t\n${facet}${facet}endsolid t`;
    const okBuffer = new TextEncoder().encode(twoFacets).buffer as ArrayBuffer;
    expect(parseSTL(okBuffer, tinyLimits).triCount).toBe(2);
  });

  it('keeps the documented default budgets coherent', () => {
    expect(DEFAULT_IMPORT_LIMITS.maxStlBytes).toBe(MAX_STL_FILE_BYTES);
    expect(DEFAULT_IMPORT_LIMITS.maxTriangles).toBe(MAX_MESH_TRIANGLES);
  });

  it('rejects ASCII input above the default byte budget before decoding text', () => {
    // A >128 MiB ASCII document never reaches the facet loop: the entry byte
    // cap fires first, so oversized text is neither decoded nor scanned.
    const buffer = new ArrayBuffer(MAX_STL_FILE_BYTES + 1);
    new Uint8Array(buffer, 0, 5).set(new TextEncoder().encode('solid'));
    expect(() => parseSTL(buffer)).toThrow(/exceeding the 128 MiB import limit/);
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

  it('reports malformed facets with a useful location', () => {
    const malformed = `solid broken\nfacet normal 0 nope 1\nouter loop\nendsolid broken`;
    const buffer = new TextEncoder().encode(malformed).buffer as ArrayBuffer;
    expect(() => parseSTL(buffer)).toThrow(/line 2: invalid normal y/);
  });

  it('accepts arbitrary whitespace without a whole-file facet expression', () => {
    const compact = 'solid t facet normal 0 0 1 outer loop vertex 0 0 0 vertex 2 0 0 vertex 0 2 0 endloop endfacet endsolid t';
    const mesh = parseSTL(new TextEncoder().encode(compact).buffer as ArrayBuffer);
    expect(mesh.triCount).toBe(1);
    expect(Array.from(mesh.positions)).toEqual([0, 0, 0, 2, 0, 0, 0, 2, 0]);
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

  it('accepts a bounded reproducibility header', () => {
    const buffer = exportBinarySTL(
      new Float32Array([0, 0, 0, 2, 0, 0, 0, 3, 0]),
      new Float32Array([0, 0, 1]),
      1,
      'OpenLattice3D seed-v1:0x1234abcd',
    );
    const header = new TextDecoder().decode(new Uint8Array(buffer, 0, 80));
    expect(header).toContain('seed-v1:0x1234abcd');
  });

  it.each(['sphere-25mm.stl', 'cube-30mm.stl'])('round-trips the shipped %s asset', (assetName) => {
    const source = readFileSync(new URL(`../../public/assets/${assetName}`, import.meta.url));
    const sourceBuffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    const parsed = parseSTL(sourceBuffer);
    const reparsed = parseSTL(exportBinarySTL(parsed.positions, parsed.normals, parsed.triCount));
    expect(reparsed.triCount).toBe(parsed.triCount);
    expect(reparsed.positions).toEqual(parsed.positions);
    expect(reparsed.normals).toEqual(parsed.normals);
  });
});
