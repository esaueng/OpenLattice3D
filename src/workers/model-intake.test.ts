import { describe, expect, it, vi } from 'vitest';
import { intakeTransfers, prepareStl, readModelFile } from './model-intake';
import { countNormalWindingAgreement, generateCubeMesh } from '../geometry/mesh-analysis';
import { exportBinarySTL } from '../geometry/stl-parser';
import { DEFAULT_IMPORT_LIMITS } from '../geometry/mesh-limits';
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
    for (const kind of ['stl', 'json'] as const) {
      const read = vi.fn(() => Promise.reject(new Error('must not read')));
      const size = (kind === 'stl' ? DEFAULT_IMPORT_LIMITS.maxStlBytes : DEFAULT_IMPORT_LIMITS.maxProjectBytes) + 1;
      await expect(readModelFile({ kind, file: { name: 'large', size, arrayBuffer: read, text: read } as unknown as File })).rejects.toThrow('import limit');
      expect(read).not.toHaveBeenCalled();
    }
    await expect(readModelFile({ kind: 'stl', file: { name: 'bad.stl', size: 1, arrayBuffer: async () => new ArrayBuffer(1) } as File })).rejects.toThrow('too small');
    await expect(readModelFile({ kind: 'json', file: { name: 'bad.json', size: 4, text: async () => '{bad' } as File })).rejects.toThrow();
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
