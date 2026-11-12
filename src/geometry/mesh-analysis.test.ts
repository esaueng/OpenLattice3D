import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import {
  alignNormalsToWinding,
  analyzeMesh,
  computeSignedVolume,
  countNormalWindingAgreement,
  flipMeshOrientation,
  generateCubeMesh,
} from './mesh-analysis';
import { parseSTL } from './stl-parser';

describe('imported STL orientation guards', () => {
  it('flips inverted closed winding and realigns unusable stored normals', () => {
    const source = readFileSync(new URL('../../public/assets/sphere-25mm.stl', import.meta.url));
    const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
    const imported = parseSTL(buffer);
    expect(analyzeMesh(imported).isWatertight).toBe(true);

    const outward = computeSignedVolume(imported) > 0 ? imported : flipMeshOrientation(imported);
    const inverted = flipMeshOrientation(outward);
    expect(computeSignedVolume(inverted)).toBeLessThan(0);

    const corrected = flipMeshOrientation(inverted);
    expect(computeSignedVolume(corrected)).toBeGreaterThan(0);
    const bvh = new MeshBVH(corrected.positions, corrected.normals, corrected.triCount);
    expect(bvh.signedDistance([0, 0, 0])).toBeLessThan(0);
    expect(bvh.signedDistance([35, 0, 0])).toBeGreaterThan(0);

    const zeroNormals = { ...corrected, normals: new Float32Array(corrected.normals.length) };
    const before = countNormalWindingAgreement(zeroNormals);
    expect(before.disagree).toBeGreaterThan(0);
    const aligned = alignNormalsToWinding(zeroNormals);
    const after = countNormalWindingAgreement(aligned);
    expect(after.disagree).toBe(0);
    expect(after.agree).toBeGreaterThan(0);
  });
});

describe('analyzeMesh condition report', () => {
  it('reports the enclosed volume of a closed mesh and no edge defects', () => {
    const info = analyzeMesh(generateCubeMesh(30));
    expect(info.isWatertight).toBe(true);
    expect(info.boundaryEdges).toBe(0);
    expect(info.nonManifoldEdges).toBe(0);
    expect(info.volumeMm3).toBeCloseTo(27_000, 3);
  });

  it('counts boundary edges and withholds the volume of an open mesh', () => {
    const cube = generateCubeMesh(30);
    const open = {
      positions: cube.positions.slice(0, (cube.triCount - 2) * 9),
      normals: cube.normals.slice(0, (cube.triCount - 2) * 3),
      triCount: cube.triCount - 2,
    };
    const info = analyzeMesh(open);
    expect(info.isWatertight).toBe(false);
    expect(info.boundaryEdges).toBe(4);
    expect(info.volumeMm3).toBeNull();
  });

  it('treats edges shared by three or more triangles as not watertight', () => {
    // Three triangles fanning out from the shared edge (0,0,0)-(0,0,10).
    const positions = new Float32Array([
      0, 0, 0, 10, 0, 0, 0, 0, 10,
      0, 0, 0, 0, 10, 0, 0, 0, 10,
      0, 0, 0, -10, -10, 0, 0, 0, 10,
    ]);
    const fin = { positions, normals: new Float32Array(9), triCount: 3 };
    const info = analyzeMesh(fin);
    expect(info.nonManifoldEdges).toBe(1);
    expect(info.boundaryEdges).toBe(6);
    expect(info.isManifold).toBe(false);
    expect(info.isWatertight).toBe(false);
    expect(info.volumeMm3).toBeNull();
  });

  it('rejects a closed mesh with an extra fin sharing one of its edges', () => {
    const cube = generateCubeMesh(30);
    // Duplicate one triangle with reversed winding: every one of its edges is
    // now shared by three triangles, and no edge is open.
    const o = 0;
    const tri = cube.positions.slice(o, o + 9);
    const reversed = new Float32Array([tri[0], tri[1], tri[2], tri[6], tri[7], tri[8], tri[3], tri[4], tri[5]]);
    const positions = new Float32Array(cube.positions.length + 9);
    positions.set(cube.positions);
    positions.set(reversed, cube.positions.length);
    const normals = new Float32Array(cube.normals.length + 3);
    normals.set(cube.normals);
    const info = analyzeMesh({ positions, normals, triCount: cube.triCount + 1 });
    expect(info.boundaryEdges).toBe(0);
    expect(info.nonManifoldEdges).toBe(3);
    expect(info.isWatertight).toBe(false);
    expect(info.volumeMm3).toBeNull();
  });
});
