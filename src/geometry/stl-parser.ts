// STL import/export: supports binary and ASCII STL
import type { Vec3 } from './vec3';

export interface TriangleMesh {
  positions: Float32Array;  // flat xyz, 3 floats per vertex, 9 per triangle
  normals: Float32Array;    // per-face normal, 3 floats per triangle
  triCount: number;
}

/** Parse binary or ASCII STL from ArrayBuffer */
export function parseSTL(buffer: ArrayBuffer): TriangleMesh {
  const view = new DataView(buffer);
  // Check if ASCII: starts with "solid" and doesn't look binary
  const header = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  const headerStr = String.fromCharCode(...header);
  if (headerStr.startsWith('solid') && buffer.byteLength > 84) {
    // Could be ASCII or binary with "solid" header - check expected binary size
    const triCount = view.getUint32(80, true);
    const expectedBinarySize = 84 + triCount * 50;
    if (Math.abs(expectedBinarySize - buffer.byteLength) <= 1) {
      return parseBinarySTL(buffer);
    }
    // Try ASCII
    try {
      return parseASCIISTL(buffer);
    } catch {
      return parseBinarySTL(buffer);
    }
  }
  return parseBinarySTL(buffer);
}

function parseBinarySTL(buffer: ArrayBuffer): TriangleMesh {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);

  for (let i = 0; i < triCount; i++) {
    const offset = 84 + i * 50;
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
  const facetRe = /facet\s+normal\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+outer\s+loop\s+vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+vertex\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+endloop\s+endfacet/gi;
  const tris: { n: Vec3; v: [Vec3, Vec3, Vec3] }[] = [];
  let m: RegExpExecArray | null;
  while ((m = facetRe.exec(text)) !== null) {
    tris.push({
      n: [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])],
      v: [
        [parseFloat(m[4]), parseFloat(m[5]), parseFloat(m[6])],
        [parseFloat(m[7]), parseFloat(m[8]), parseFloat(m[9])],
        [parseFloat(m[10]), parseFloat(m[11]), parseFloat(m[12])],
      ],
    });
  }
  const triCount = tris.length;
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
  for (let i = 0; i < triCount; i++) {
    normals[i * 3] = tris[i].n[0];
    normals[i * 3 + 1] = tris[i].n[1];
    normals[i * 3 + 2] = tris[i].n[2];
    for (let v = 0; v < 3; v++) {
      positions[i * 9 + v * 3] = tris[i].v[v][0];
      positions[i * 9 + v * 3 + 1] = tris[i].v[v][1];
      positions[i * 9 + v * 3 + 2] = tris[i].v[v][2];
    }
  }
  return { positions, normals, triCount };
}

/** Export binary STL from flat position + normal arrays */
export function exportBinarySTL(positions: Float32Array, normals: Float32Array, triCount: number): ArrayBuffer {
  const bufSize = 84 + triCount * 50;
  const buffer = new ArrayBuffer(bufSize);
  const view = new DataView(buffer);
  // header - 80 bytes
  const headerBytes = new TextEncoder().encode('OpenLattice3D Export');
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);
  view.setUint32(80, triCount, true);

  for (let i = 0; i < triCount; i++) {
    const offset = 84 + i * 50;
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
