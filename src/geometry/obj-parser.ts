// Wavefront OBJ import: geometric vertices (`v`) and faces (`f`) only.
//
// Faces may be polygons (fan-triangulated from their first corner, which is
// exact for the convex faces CAD and mesh tools write) and may use the
// v, v/vt, v//vn and v/vt/vn index forms with positive or negative (relative)
// indices. Texture coordinates, stored normals, groups, materials, lines and
// free-form geometry are ignored; normals are recomputed from winding. OBJ
// declares no unit, so coordinates are returned exactly as written.
import { alignNormalsToWinding } from './mesh-analysis';
import { DEFAULT_IMPORT_LIMITS, formatByteCount, validateMeshPositions, type ImportLimits } from './mesh-limits';
import type { TriangleMesh } from './stl-parser';

export interface ObjImport {
  mesh: TriangleMesh;
  /** Faces with more than three corners, fan-triangulated. */
  polygonFaces: number;
  /** Non-fatal observations worth logging. */
  warnings: string[];
}

const utf8 = new TextDecoder('utf-8', { fatal: false });

export function parseOBJ(input: ArrayBuffer | Uint8Array, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): ObjImport {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length > limits.maxObjBytes) {
    throw new Error(`OBJ parse failed: file is ${formatByteCount(bytes.length)}, exceeding the ${formatByteCount(limits.maxObjBytes)} import limit`);
  }
  const length = bytes.length;
  let vertexCapacity = 3 * 1024;
  let vertices = new Float64Array(vertexCapacity);
  let vertexCount = 0;
  let indexCapacity = 3 * 1024;
  let indices = new Int32Array(indexCapacity);
  let indexCount = 0;
  let polygonFaces = 0;
  let degenerate = 0;
  let line = 0;
  let i = 0;

  const fail = (message: string): never => { throw new Error(`OBJ parse failed at line ${line}: ${message}`); };
  const token = (start: number, end: number): string => {
    let ascii = true;
    for (let k = start; k < end; k++) if (bytes[k] >= 0x80) { ascii = false; break; }
    if (!ascii) return utf8.decode(bytes.subarray(start, end));
    let out = '';
    for (let k = start; k < end; k++) out += String.fromCharCode(bytes[k]);
    return out;
  };

  // Tokens of the current line; a trailing backslash continues the line.
  const starts: number[] = [];
  const ends: number[] = [];
  const corners: number[] = [];
  while (i < length) {
    line++;
    starts.length = 0;
    ends.length = 0;
    for (;;) {
      while (i < length && (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0d)) i++;
      if (i >= length) break;
      const c = bytes[i];
      if (c === 0x0a) { i++; break; }
      if (c === 0x23 /* # */) { while (i < length && bytes[i] !== 0x0a) i++; continue; }
      if (c === 0x5c /* \ */) {
        let k = i + 1;
        while (k < length && (bytes[k] === 0x20 || bytes[k] === 0x09 || bytes[k] === 0x0d)) k++;
        if (k >= length || bytes[k] === 0x0a) { i = k + 1; line++; continue; }
      }
      const start = i;
      while (i < length && bytes[i] > 0x20 && bytes[i] !== 0x23) i++;
      starts.push(start);
      ends.push(i);
    }
    if (starts.length === 0) continue;
    const keywordLength = ends[0] - starts[0];
    const k0 = bytes[starts[0]];
    if (keywordLength !== 1 || (k0 !== 0x76 /* v */ && k0 !== 0x66 /* f */)) continue;

    if (k0 === 0x76) {
      if (starts.length < 4) fail('vertex needs x, y and z');
      if (vertexCount >= limits.maxVertices) fail(`vertex count exceeds the supported limit of ${limits.maxVertices}`);
      if ((vertexCount + 1) * 3 > vertexCapacity) {
        vertexCapacity *= 2;
        const next = new Float64Array(vertexCapacity);
        next.set(vertices);
        vertices = next;
      }
      for (let axis = 0; axis < 3; axis++) {
        const text = token(starts[axis + 1], ends[axis + 1]);
        const value = Number(text);
        if (!Number.isFinite(value)) fail(`invalid vertex coordinate "${text.slice(0, 40)}"`);
        vertices[vertexCount * 3 + axis] = value;
      }
      vertexCount++;
      continue;
    }

    // Face: resolve relative indices now (they refer to vertices read so far);
    // positive indices may refer forward and are range-checked at the end.
    if (starts.length < 4) fail('face needs at least three vertices');
    corners.length = 0;
    for (let t = 1; t < starts.length; t++) {
      let end = starts[t];
      while (end < ends[t] && bytes[end] !== 0x2f /* / */) end++;
      const text = token(starts[t], end);
      const value = Number(text);
      if (text === '' || !Number.isInteger(value) || value === 0) fail(`invalid face vertex reference "${token(starts[t], ends[t]).slice(0, 40)}"`);
      if (value < 0) {
        const resolved = vertexCount + value;
        if (resolved < 0) fail(`face refers to vertex ${value}, but only ${vertexCount} vertices precede it`);
        corners.push(resolved);
      } else {
        if (value > limits.maxVertices) fail(`face refers to vertex ${value}, beyond the supported vertex limit`);
        corners.push(value - 1);
      }
    }
    if (corners.length > 3) polygonFaces++;
    for (let t = 1; t + 1 < corners.length; t++) {
      const a = corners[0], b = corners[t], c = corners[t + 1];
      if (a === b || b === c || a === c) { degenerate++; continue; }
      if (indexCount / 3 >= limits.maxTriangles) fail(`triangle count exceeds the supported limit of ${limits.maxTriangles}`);
      if (indexCount + 3 > indexCapacity) {
        indexCapacity *= 2;
        const next = new Int32Array(indexCapacity);
        next.set(indices);
        indices = next;
      }
      indices[indexCount++] = a;
      indices[indexCount++] = b;
      indices[indexCount++] = c;
    }
  }

  const triCount = indexCount / 3;
  if (triCount === 0) throw new Error('OBJ parse failed: file contains no faces');
  const positions = new Float32Array(indexCount * 3);
  for (let k = 0; k < indexCount; k++) {
    const index = indices[k];
    if (index >= vertexCount) throw new Error(`OBJ parse failed: a face refers to vertex ${index + 1}, but the file defines ${vertexCount}`);
    positions[k * 3] = vertices[index * 3];
    positions[k * 3 + 1] = vertices[index * 3 + 1];
    positions[k * 3 + 2] = vertices[index * 3 + 2];
  }
  validateMeshPositions(positions);
  const warnings: string[] = [];
  if (polygonFaces > 0) warnings.push(`Triangulated ${polygonFaces} polygon face(s) with more than three corners.`);
  if (degenerate > 0) warnings.push(`Dropped ${degenerate} triangle(s) that repeat a vertex.`);
  return {
    mesh: alignNormalsToWinding({ positions, normals: new Float32Array(0), triCount }),
    polygonFaces,
    warnings,
  };
}
