import { describe, expect, it } from 'vitest';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { marchingCubes } from '../marching-cubes';
import { buildIndexedMesh } from '../mesh-indexing';
import { buildThreeMf } from '../../utils/threemf';
import { DEFAULT_PARAMS } from '../../types/project';
import { SOLIDS } from './helpers';

void gunzipSync;   // keep the zlib import honest if unused by a future case

/** Read entries back out of the archive, so the package is checked as a package. */
function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Map<string, Uint8Array>();

  // Locate the end-of-central-directory record from the tail.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  expect(eocd, 'end of central directory').toBeGreaterThanOrEqual(0);

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);

  for (let i = 0; i < count; i++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));

    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 8 ? new Uint8Array(inflateRawSync(raw)) : raw);

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const OPTIONS = {
  meshFileName: 'test-part.stl',
  params: { ...DEFAULT_PARAMS },
  validation: null,
  metrics: null,
  material: { name: 'PA12 (Nylon)', density: 1.01 },
};

describe('3MF export', () => {
  const solid = SOLIDS.sphere(25);
  const mesh = marchingCubes(solid.sdf, solid.bounds, 32, 0);

  it('produces a package with the parts an OPC reader requires', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    expect([...entries.keys()].sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
  });

  it('declares millimetres, which STL cannot express at all', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
    expect(model).toContain('unit="millimeter"');
  });

  it('writes indexed geometry matching the welded mesh', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
    const indexed = buildIndexedMesh(mesh);

    const vertices = model.match(/<vertex /g)?.length ?? 0;
    const triangles = model.match(/<triangle /g)?.length ?? 0;
    expect(vertices).toBe(indexed.vertexCount);
    expect(triangles).toBe(indexed.triangleCount);
    // Welding must actually share vertices, not just re-emit soup.
    expect(vertices).toBeLessThan(mesh.triCount * 0.6);
  });

  it('keeps every triangle index inside the vertex array', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
    const vertexCount = model.match(/<vertex /g)!.length;
    for (const m of model.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"\/>/g)) {
      for (let i = 1; i <= 3; i++) {
        expect(Number(m[i])).toBeLessThan(vertexCount);
      }
    }
  });

  it('embeds the lattice recipe as namespaced metadata', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
    expect(model).toContain('<metadata name="ol:latticeType">gyroid</metadata>');
    expect(model).toContain('<metadata name="ol:cellSize">8</metadata>');
    expect(model).toContain('<metadata name="ol:material">PA12 (Nylon)</metadata>');
  });

  it('points its root relationship at the model part', async () => {
    const entries = readZip(await buildThreeMf(mesh, OPTIONS));
    const rels = new TextDecoder().decode(entries.get('_rels/.rels')!);
    expect(rels).toContain('Target="/3D/3dmodel.model"');
    expect(rels).toContain('3dmanufacturing/2013/01/3dmodel');
  });

  it('is smaller than the equivalent STL', async () => {
    const bytes = await buildThreeMf(mesh, OPTIONS);
    const stlBytes = 84 + mesh.triCount * 50;
    expect(bytes.length).toBeLessThan(stlBytes);
  });

  it('is byte-identical across runs, so exports are reproducible', async () => {
    const a = await buildThreeMf(mesh, OPTIONS);
    const b = await buildThreeMf(mesh, OPTIONS);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('escapes characters that would otherwise break the XML', async () => {
    const entries = readZip(await buildThreeMf(mesh, {
      ...OPTIONS,
      meshFileName: 'bracket <v2> & "final"',
    }));
    const model = new TextDecoder().decode(entries.get('3D/3dmodel.model')!);
    expect(model).toContain('bracket &lt;v2&gt; &amp; &quot;final&quot;');
    expect(model).not.toContain('<v2>');
  });
});
