// STL import/export: supports binary and ASCII STL
import type { Vec3 } from './vec3';

export interface TriangleMesh {
  positions: Float32Array;  // flat xyz, 3 floats per vertex, 9 per triangle
  normals: Float32Array;    // per-face normal, 3 floats per triangle
  triCount: number;
}

const BINARY_HEADER_BYTES = 84;
const BINARY_TRIANGLE_BYTES = 50;

/** Parse binary or ASCII STL from ArrayBuffer.
 *  Throws on truncated, empty, or unrecognizable input. */
export function parseSTL(buffer: ArrayBuffer): TriangleMesh {
  const header = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  const headerStr = String.fromCharCode(...header);

  if (headerStr.startsWith('solid')) {
    // Could be ASCII, or binary with a "solid" header - check expected binary size
    if (buffer.byteLength >= BINARY_HEADER_BYTES) {
      const view = new DataView(buffer);
      const triCount = view.getUint32(80, true);
      const expectedBinarySize = BINARY_HEADER_BYTES + triCount * BINARY_TRIANGLE_BYTES;
      if (Math.abs(expectedBinarySize - buffer.byteLength) <= 1) {
        return parseBinarySTL(buffer);
      }
    }
    const ascii = parseASCIISTL(buffer);
    if (ascii.triCount > 0) return ascii;
    if (buffer.byteLength >= BINARY_HEADER_BYTES) return parseBinarySTL(buffer);
    throw new Error('STL parse failed: no facets found in ASCII STL');
  }
  return parseBinarySTL(buffer);
}

function parseBinarySTL(buffer: ArrayBuffer): TriangleMesh {
  if (buffer.byteLength < BINARY_HEADER_BYTES) {
    throw new Error(`STL parse failed: file too small for binary STL (${buffer.byteLength} bytes)`);
  }
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  if (triCount === 0) {
    throw new Error('STL parse failed: file contains no triangles');
  }
  const requiredBytes = BINARY_HEADER_BYTES + triCount * BINARY_TRIANGLE_BYTES;
  if (requiredBytes > buffer.byteLength) {
    throw new Error(
      `STL parse failed: header declares ${triCount} triangles (${requiredBytes} bytes) but file is ${buffer.byteLength} bytes`
    );
  }
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const offset = BINARY_HEADER_BYTES + i * BINARY_TRIANGLE_BYTES;
    normals[i * 3]     = view.getFloat32(offset, true);
    normals[i * 3 + 1] = view.getFloat32(offset + 4, true);
    normals[i * 3 + 2] = view.getFloat32(offset + 8, true);
    for (let v = 0; v < 3; v++) {
      const vOff = offset + 12 + v * 12;
      positions[i * 9 + v * 3]     = view.getFloat32(vOff, true);
      positions[i * 9 + v * 3 + 1] = view.getFloat32(vOff + 4, true);
      positions[i * 9 + v * 3 + 2] = view.getFloat32(vOff + 8, true);
    }
  }
  return { positions, normals, triCount };
}

function parseASCIISTL(buffer: ArrayBuffer): TriangleMesh {
  const text = new TextDecoder().decode(buffer);
  let offset = 0;
  let line = 1;

  // A manual token scanner keeps parsing linear and avoids one backtracking
  // regular expression plus a second object representation of every facet.
  const nextToken = (): { value: string; line: number } | null => {
    while (offset < text.length) {
      const code = text.charCodeAt(offset);
      if (code === 10) line++;
      if (code > 32) break;
      offset++;
    }
    if (offset >= text.length) return null;
    const tokenLine = line;
    const start = offset;
    while (offset < text.length && text.charCodeAt(offset) > 32) offset++;
    return { value: text.slice(start, offset), line: tokenLine };
  };

  const requireToken = (expected: string, context: string) => {
    const token = nextToken();
    if (!token || token.value.toLowerCase() !== expected) {
      const actual = token?.value ?? 'end of file';
      throw new Error(`STL parse failed at line ${token?.line ?? line}: expected ${expected} ${context}, found ${actual}`);
    }
  };

  const readNumber = (context: string): number => {
    const token = nextToken();
    const value = token ? Number(token.value) : Number.NaN;
    if (!Number.isFinite(value)) {
      throw new Error(`STL parse failed at line ${token?.line ?? line}: invalid ${context}`);
    }
    return value;
  };

  const positionValues: number[] = [];
  const normalValues: number[] = [];
  let token: { value: string; line: number } | null;
  while ((token = nextToken()) !== null) {
    const keyword = token.value.toLowerCase();
    if (keyword === 'endsolid') break;
    if (keyword !== 'facet') continue;

    requireToken('normal', 'after facet');
    const normal: Vec3 = [readNumber('normal x'), readNumber('normal y'), readNumber('normal z')];
    requireToken('outer', 'after facet normal');
    requireToken('loop', 'after outer');
    const vertices: [Vec3, Vec3, Vec3] = [
      [0, 0, 0],
      [0, 0, 0],
      [0, 0, 0],
    ];
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      requireToken('vertex', `for vertex ${vertexIndex + 1}`);
      vertices[vertexIndex] = [
        readNumber(`vertex ${vertexIndex + 1} x`),
        readNumber(`vertex ${vertexIndex + 1} y`),
        readNumber(`vertex ${vertexIndex + 1} z`),
      ];
    }
    requireToken('endloop', 'after three vertices');
    requireToken('endfacet', 'after endloop');
    normalValues.push(normal[0], normal[1], normal[2]);
    for (const vertex of vertices) positionValues.push(vertex[0], vertex[1], vertex[2]);
  }

  const triCount = normalValues.length / 3;
  return {
    positions: Float32Array.from(positionValues),
    normals: Float32Array.from(normalValues),
    triCount,
  };
}

/** Export binary STL from flat position + normal arrays */
export function exportBinarySTL(positions: Float32Array, normals: Float32Array, triCount: number): ArrayBuffer {
  const bufSize = BINARY_HEADER_BYTES + triCount * BINARY_TRIANGLE_BYTES;
  const buffer = new ArrayBuffer(bufSize);
  const view = new DataView(buffer);
  // header - 80 bytes
  const headerBytes = new TextEncoder().encode('OpenLattice3D Export');
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);
  view.setUint32(80, triCount, true);

  for (let i = 0; i < triCount; i++) {
    const offset = BINARY_HEADER_BYTES + i * BINARY_TRIANGLE_BYTES;
    view.setFloat32(offset, normals[i * 3], true);
    view.setFloat32(offset + 4, normals[i * 3 + 1], true);
    view.setFloat32(offset + 8, normals[i * 3 + 2], true);
    for (let v = 0; v < 3; v++) {
      const vOff = offset + 12 + v * 12;
      view.setFloat32(vOff, positions[i * 9 + v * 3], true);
      view.setFloat32(vOff + 4, positions[i * 9 + v * 3 + 1], true);
      view.setFloat32(vOff + 8, positions[i * 9 + v * 3 + 2], true);
    }
    view.setUint16(offset + 48, 0, true); // attribute byte count
  }
  return buffer;
}
