import { describe, expect, it, vi } from 'vitest';
import { detectMeshFormat, intakeTransfers, prepareStl, readModelFile } from './model-intake';
import { computeSignedVolume, countNormalWindingAgreement, generateCubeMesh } from '../geometry/mesh-analysis';
import { exportBinarySTL } from '../geometry/stl-parser';
import { create3MF } from '../geometry/three-mf';
import { DEFAULT_IMPORT_LIMITS, meshFileByteBudget, MESH_FILE_FORMATS } from '../geometry/mesh-limits';
import { buildObj } from '../utils/obj';
import { MeshBVH } from '../geometry/bvh';
import { createProjectFile } from '../utils/project-file';
import { DEFAULT_PARAMS } from '../types/project';

function cubeFile() {
  const mesh = generateCubeMesh(10);
  return { mesh, buffer: exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount) };
}
describe('worker model intake', () => {
  it('retains closed mesh coordinates, metadata, dimensions and orientation notices', () => {
    const { mesh, buffer } = cubeFile();
    const result = prepareStl(buffer, 'cube.stl');
    expect(result.mesh).toEqual(mesh);
    expect(result.info).toMatchObject({ triangleCount: 12, vertexCount: 8, volumeMm3: 1000, isWatertight: true, isManifold: true, repaired: false, boundingBox: { min: [-5, -5, -5], max: [5, 5, 5] } });
    expect(result.notice).toEqual({ level: 'info', message: 'Imported cube.stl: 12 triangles, 10.0 × 10.0 × 10.0 mm.', scalePrompt: false });
    // Reverse winding only; retain contradictory STL normals as a real input can.
    for (let i = 0; i < mesh.triCount; i++) for (let axis = 0; axis < 3; axis++) {
      const a = i * 9 + 3 + axis, b = a + 3;
      [mesh.positions[a], mesh.positions[b]] = [mesh.positions[b], mesh.positions[a]];
    }
    const inverted = prepareStl(exportBinarySTL(mesh.positions, mesh.normals, mesh.triCount), 'inverted.stl');
    expect(countNormalWindingAgreement(inverted.mesh)).toEqual({ agree: 12, disagree: 0, degenerate: 0 });
    expect(inverted.logs.some(log => log.message.includes('Inverted winding detected'))).toBe(true);
    mesh.normals.set(result.mesh.normals.map(value => -value));
    const normals = prepareStl(exportBinarySTL(result.mesh.positions, mesh.normals, mesh.triCount), 'normals.stl');
    expect(normals.info.volumeMm3).toBe(1000);
    expect(countNormalWindingAgreement(normals.mesh)).toEqual({ agree: 12, disagree: 0, degenerate: 0 });
    expect(normals.logs.some(log => log.message.includes('Stored normals disagreed'))).toBe(true);
  });

  it('replaces a minority of wrong stored normals with winding normals', () => {
    const { mesh } = cubeFile();
    const stored = new Float32Array(mesh.normals);
    for (const t of [1, 6]) for (let axis = 0; axis < 3; axis++) stored[t * 3 + axis] *= -1;
    stored.fill(0, 9, 12); // and one zero normal, as some exporters write
    const result = prepareStl(exportBinarySTL(mesh.positions, stored, mesh.triCount), 'mixed.stl');
    expect(countNormalWindingAgreement(result.mesh)).toEqual({ agree: 12, disagree: 0, degenerate: 0 });
    expect(result.mesh.positions).toEqual(mesh.positions);
    expect(result.logs.some(log => log.message.includes('Stored normals disagreed with winding on 3/12 faces'))).toBe(true);
    const bvh = new MeshBVH(result.mesh.positions, result.mesh.normals, result.mesh.triCount);
    expect(bvh.signedDistance([0, 0, 4.5])).toBeCloseTo(-0.5, 5);
    expect(bvh.signedDistance([0, 0, 5.5])).toBeCloseTo(0.5, 5);
  });

  it('keeps open mesh repair honest and retains the explicit unit prompt', () => {
    const { mesh } = cubeFile();
    const open = prepareStl(exportBinarySTL(mesh.positions, mesh.normals, 11), 'open.stl');
    expect(open.info).toMatchObject({ isWatertight: false, repaired: true, boundaryEdges: 3, volumeMm3: null });
    expect(open.notice.message).toContain('not closed');
    expect(open.notice.detail).toContain('Normals recomputed; mesh is still open');
    const tiny = generateCubeMesh(1);
    const prompted = prepareStl(exportBinarySTL(tiny.positions, tiny.normals, 12), 'inch.stl');
    expect(prompted.notice.scalePrompt).toBe(true);
    expect(prompted.info.boundingBox.max).toEqual([0.5, 0.5, 0.5]);
  });

  it('checks declared budgets before reading in the worker and propagates parse failures', async () => {
    for (const kind of [...MESH_FILE_FORMATS, 'json'] as const) {
      const read = vi.fn(() => Promise.reject(new Error('must not read')));
      const size = (kind === 'json' ? DEFAULT_IMPORT_LIMITS.maxProjectBytes : meshFileByteBudget(kind)) + 1;
      await expect(readModelFile({ kind, file: { name: 'large', size, arrayBuffer: read, text: read } as unknown as File })).rejects.toThrow('import limit');
      expect(read).not.toHaveBeenCalled();
    }
    await expect(readModelFile({ kind: 'stl', file: { name: 'bad.stl', size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File })).rejects.toThrow('too small');
    await expect(readModelFile({ kind: 'json', file: { name: 'bad.json', size: 4, text: async () => '{bad' } as File })).rejects.toThrow();
    await expect(readModelFile(meshFile('3mf', 'fake.3mf', new TextEncoder().encode('solid text').buffer))).rejects.toThrow(/ZIP signature/);
    await expect(readModelFile(meshFile('obj', 'empty.obj', new TextEncoder().encode('v 0 0 0\n').buffer))).rejects.toThrow(/no faces/);
  });

  it('preserves project seed, masks, schema parsing and fresh transferable geometry', async () => {
    const { mesh } = cubeFile();
    const project = createProjectFile({ params: DEFAULT_PARAMS, generationSeed: 123,
      source: { kind: 'mesh', fileName: 'cube.stl', mesh }, keepOutTris: new Set([2]), keepInTris: new Set([4]),
      validation: null, clipPlane: { axis: 'y', position: 0.4, flipped: true }, viewerBackground: '#123456' });
    const result = await readModelFile({ kind: 'json', file: { name: 'cube.json', size: 2000, text: async () => JSON.stringify(project) } as File });
    expect(result.kind).toBe('json');
    if (result.kind !== 'json' || result.parsed.kind !== 'project') throw new Error('expected project');
    expect(result.parsed).toMatchObject({ generationSeed: 123, keepOutTris: [2], keepInTris: [4], clipPlane: { axis: 'y', position: 0.4, flipped: true }, warnings: [] });
    expect(result.parsed.originalMesh).toEqual(mesh);
    const buffers = intakeTransfers(result);
    expect(buffers).toHaveLength(2);
    const delivered = structuredClone(result, { transfer: buffers });
    expect(buffers.every(buffer => buffer.byteLength === 0)).toBe(true);
    expect(mesh.positions.byteLength).toBe(12 * 9 * 4);
    expect(mesh.normals.byteLength).toBe(12 * 3 * 4);
    expect(delivered.kind === 'json' && delivered.parsed.kind === 'project' && delivered.parsed.originalMesh).toEqual(mesh);
    (project.source as Record<string, unknown>).fingerprint = 'wrong';
    const mismatch = await readModelFile({ kind: 'json', file: { name: 'mismatch.json', size: 2000, text: async () => JSON.stringify(project) } as File });
    expect(mismatch.kind === 'json' && mismatch.parsed).toMatchObject({ keepOutTris: [], keepInTris: [], warnings: [expect.stringContaining('fingerprint')] });
  });
});

function meshFile(kind: 'stl' | '3mf' | 'obj', name: string, buffer: ArrayBuffer | Uint8Array) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const copy = bytes.slice().buffer;
  return { kind, file: { name, size: bytes.byteLength, arrayBuffer: async () => copy } as File };
}

function cube3MF(size: number, unit = 'millimeter') {
  const bytes = create3MF(generateCubeMesh(size));
  // The writer always declares millimetres. Rewrite the stored model part's
  // attribute in place, padded to the same length so every ZIP offset stays
  // valid, then refresh the CRCs.
  if (unit === 'millimeter') return bytes;
  const encoder = new TextEncoder();
  const original = encoder.encode('unit="millimeter"');
  const replacement = encoder.encode((unit ? `unit="${unit}"` : '').padEnd(original.length, ' '));
  const at = bytes.findIndex((_, i) => original.every((byte, k) => bytes[i + k] === byte));
  if (at < 0) throw new Error('fixture: unit attribute not found');
  bytes.set(replacement, at);
  return patchCrc(bytes);
}

/** Recompute stored-entry CRCs after an in-place, length-preserving edit. */
function patchCrc(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const crc = (data: Uint8Array) => {
    let c = 0xffffffff;
    for (const byte of data) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return (c ^ 0xffffffff) >>> 0;
  };
  const end = bytes.length - 22;
  let offset = view.getUint32(end + 16, true);
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const local = view.getUint32(offset + 42, true);
    const size = view.getUint32(local + 18, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const value = crc(bytes.subarray(start, start + size));
    view.setUint32(local + 14, value, true);
    view.setUint32(offset + 16, value, true);
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return bytes;
}

describe('worker intake of 3MF and OBJ', () => {
  it('routes a 3MF through orientation, analysis and notice preparation without a unit prompt', async () => {
    const result = await readModelFile(meshFile('3mf', 'cube.3mf', create3MF(generateCubeMesh(10))));
    if (result.kind !== 'mesh') throw new Error('expected mesh');
    expect(result.format).toBe('3mf');
    expect(result.info).toMatchObject({ triangleCount: 12, vertexCount: 8, volumeMm3: 1000, isWatertight: true, isManifold: true });
    expect(result.notice).toEqual({ level: 'info', message: 'Imported cube.3mf: 12 triangles, 10.0 × 10.0 × 10.0 mm.', scalePrompt: false });
    expect(result.logs.map((log) => log.message)).toContain('3MF declares unit "millimeter"; no conversion needed.');
    expect(intakeTransfers(result)).toHaveLength(2);
  });

  it('converts a declared unit explicitly, logs it, and skips the unit prompt', async () => {
    // A 1-unit cube in inches would trip the small-part prompt if read as mm.
    const result = await readModelFile(meshFile('3mf', 'inch.3mf', cube3MF(1, 'inch')));
    if (result.kind !== 'mesh') throw new Error('expected mesh');
    expect(result.info.boundingBox.max.map((v) => Number(v.toFixed(4)))).toEqual([12.7, 12.7, 12.7]);
    expect(result.notice.scalePrompt).toBe(false);
    expect(result.notice.message).toContain('(converted from inches)');
    expect(result.logs).toContainEqual({ level: 'info', message: '3MF declares unit "inch": converted coordinates to millimetres (×25.4).' });
  });

  it('keeps the unit prompt for a 3MF without a declared unit and for OBJ', async () => {
    const undeclared = cube3MF(1, '');
    const threeMf = await readModelFile(meshFile('3mf', 'small.3mf', undeclared));
    if (threeMf.kind !== 'mesh') throw new Error('expected mesh');
    expect(threeMf.notice).toMatchObject({ scalePrompt: true, message: expect.stringContaining('declares no unit, so millimetres were assumed') });
    expect(threeMf.info.boundingBox.max).toEqual([0.5, 0.5, 0.5]);
    const tiny = generateCubeMesh(1);
    const obj = await readModelFile(meshFile('obj', 'small.obj', buildObj(tiny, { meshFileName: 'x', params: DEFAULT_PARAMS })));
    if (obj.kind !== 'mesh') throw new Error('expected mesh');
    expect(obj.format).toBe('obj');
    expect(obj.notice).toMatchObject({ scalePrompt: true, message: expect.stringContaining('OBJ files carry no units') });
    expect(obj.info.boundingBox.max).toEqual([0.5, 0.5, 0.5]);
  });

  it('flips an inside-out OBJ to outward winding like an STL', async () => {
    const mesh = generateCubeMesh(10);
    const reversed = new Float32Array(mesh.positions);
    for (let t = 0; t < mesh.triCount; t++) for (let axis = 0; axis < 3; axis++) {
      [reversed[t * 9 + 3 + axis], reversed[t * 9 + 6 + axis]] = [reversed[t * 9 + 6 + axis], reversed[t * 9 + 3 + axis]];
    }
    const result = await readModelFile(meshFile('obj', 'inside-out.obj', buildObj({ ...mesh, positions: reversed }, { meshFileName: 'x', params: DEFAULT_PARAMS })));
    if (result.kind !== 'mesh') throw new Error('expected mesh');
    expect(computeSignedVolume(result.mesh)).toBeCloseTo(1000, 3);
    expect(result.logs.some((log) => log.message.includes('Inverted winding detected'))).toBe(true);
  });

  it('detects 3MF by its ZIP signature whatever the extension says', async () => {
    const bytes = create3MF(generateCubeMesh(10));
    expect(detectMeshFormat(bytes, 'stl')).toBe('3mf');
    expect(detectMeshFormat(new Uint8Array(exportBinarySTL(new Float32Array(9), new Float32Array(3), 1)), 'stl')).toBe('stl');
    const result = await readModelFile(meshFile('stl', 'misnamed.stl', bytes));
    if (result.kind !== 'mesh') throw new Error('expected mesh');
    expect(result.format).toBe('3mf');
    expect(result.logs[0].message).toBe('misnamed.stl is a ZIP package; reading it as 3MF.');
  });
});
