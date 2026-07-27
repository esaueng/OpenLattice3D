import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from './bvh';
import {
  alignNormalsToWinding,
  analyzeMesh,
  computeSignedVolume,
  countNormalWindingAgreement,
  flipMeshOrientation,
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
