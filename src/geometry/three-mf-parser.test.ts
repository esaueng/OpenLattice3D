import { describe, expect, it } from 'vitest';
import { computeSignedVolume, countNormalWindingAgreement, generateCubeMesh, generateSphereMesh } from './mesh-analysis';
import { DEFAULT_IMPORT_LIMITS, type ImportLimits } from './mesh-limits';
import { create3MF } from './three-mf';
import { parse3MF, parseTransform, THREE_MF_UNIT_TO_MM } from './three-mf-parser';
import { extractZipEntry, readZipDirectory } from './zip-reader';
import type { TriangleMesh } from './stl-parser';

const encoder = new TextEncoder();
const CORE = 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02';
const PROD = 'http://schemas.microsoft.com/3dmanufacturing/production/2015/06';

interface FixtureEntry {
  name: string;
  data: Uint8Array | string;
  deflate?: boolean;
  /** Lie about the uncompressed size in both headers. */
  declaredSize?: number;
  flags?: number;
  method?: number;
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) { c ^= byte; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A ZIP writer for fixtures: STORE or DEFLATE, with optional lying headers. */
async function zip(entries: FixtureEntry[]): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    const body = entry.deflate ? await deflateRaw(raw) : raw;
    const method = entry.method ?? (entry.deflate ? 8 : 0);
    const size = entry.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, entry.flags ?? 0, true);
    dv.setUint16(10, method, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, body.length, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    locals.push(local);
    central.push(dir);
    offset += local.length;
  }
  const centralSize = central.reduce((sum, d) => sum + d.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...locals, ...central, end]) { out.set(part, cursor); cursor += part.length; }
  return out;
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** A unit cube (0..1) as 3MF mesh markup, outward winding. */
function cubeObject(id: number, extra = ''): string {
  const v = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<object id="${id}" type="model"${extra}><mesh><vertices>${v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices>`
    + `<triangles>${t.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`).join('')}</triangles></mesh></object>`;
}

function model(body: string, attrs = 'unit="millimeter"'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model ${attrs} xml:lang="en-US" xmlns="${CORE}" xmlns:p="${PROD}">${body}</model>`;
}

function pkg(modelXml: string, extra: FixtureEntry[] = [], deflate = false): Promise<Uint8Array> {
  return zip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    { name: '_rels/.rels', data: RELS, deflate },
    { name: '3D/3dmodel.model', data: modelXml, deflate },
    ...extra,
  ]);
}

function bounds(mesh: TriangleMesh) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i++) {
    min[i % 3] = Math.min(min[i % 3], mesh.positions[i]);
    max[i % 3] = Math.max(max[i % 3], mesh.positions[i]);
  }
  return { min, max };
}

function expectClose(actual: ArrayLike<number>, expected: ArrayLike<number>, tolerance = 1e-5) {
  expect(actual.length).toBe(expected.length);
  let worst = 0;
  for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(actual[i] - expected[i]));
  expect(worst).toBeLessThanOrEqual(tolerance);
}

describe('3MF import round trip', () => {
  it('reads back the repo 3MF writer output with identical geometry', async () => {
    for (const mesh of [generateCubeMesh(30), generateSphereMesh(12.5, 24)]) {
      const parsed = await parse3MF(create3MF(mesh, 0x1234abcd));
      expect(parsed.declaredUnit).toBe('millimeter');
      expect(parsed.scaleToMm).toBe(1);
      expect(parsed.buildItems).toBe(1);
      expect(parsed.mesh.triCount).toBe(mesh.triCount);
      // The writer rounds to 9 significant digits; float32 holds ~7.
      expectClose(parsed.mesh.positions, mesh.positions, 1e-5);
      expect(countNormalWindingAgreement(parsed.mesh).disagree).toBe(0);
    }
  });

  it('reads DEFLATE-compressed parts the same as stored ones', async () => {
    const mesh = generateCubeMesh(20);
    const stored = create3MF(mesh);
    const entries = readZipDirectory(stored, { maxEntries: 10, maxEntryBytes: 1 << 20 });
    const repacked = await zip(await Promise.all(entries.map(async (entry) => ({
      name: entry.name, data: await extractZipEntry(stored, entry, { maxEntries: 10, maxEntryBytes: 1 << 20 }), deflate: true,
    }))));
    const deflated = await parse3MF(repacked);
    expect(deflated.mesh).toEqual((await parse3MF(stored)).mesh);
  });

  it('finds the model through the package relationships, case-insensitively', async () => {
    const rels = RELS.replace('/3D/3dmodel.model', '/3D/Part%20One.model');
    const bytes = await zip([{ name: '_rels/.rels', data: rels }, { name: '3d/part one.MODEL', data: model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`) }]);
    expect((await parse3MF(bytes)).mesh.triCount).toBe(12);
    // Without relationships, the conventional path is used.
    const bare = await zip([{ name: '3D/3dmodel.model', data: model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`) }]);
    expect((await parse3MF(bare)).mesh.triCount).toBe(12);
  });
});

describe('3MF units', () => {
  const unitCube = `<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`;

  it.each(Object.entries(THREE_MF_UNIT_TO_MM))('converts %s to millimetres explicitly', async (unit, factor) => {
    const parsed = await parse3MF(await pkg(model(unitCube, `unit="${unit}"`)));
    expect(parsed.declaredUnit).toBe(unit);
    expect(parsed.scaleToMm).toBe(factor);
    const { min, max } = bounds(parsed.mesh);
    expect(min).toEqual([0, 0, 0]);
    expect(max).toEqual([factor, factor, factor].map(Math.fround));
  });

  it('assumes the spec default millimetre when no unit is declared, and reports it as undeclared', async () => {
    const parsed = await parse3MF(await pkg(model(unitCube, '')));
    expect(parsed.declaredUnit).toBeNull();
    expect(parsed.scaleToMm).toBe(1);
    expect(bounds(parsed.mesh).max).toEqual([1, 1, 1]);
  });

  it('keeps coordinates as written and warns on an unrecognized unit', async () => {
    const parsed = await parse3MF(await pkg(model(unitCube, 'unit="furlong"')));
    expect(parsed.declaredUnit).toBeNull();
    expect(parsed.scaleToMm).toBe(1);
    expect(parsed.warnings.join(' ')).toContain('unrecognized unit "furlong"');
  });
});

describe('3MF transforms and build', () => {
  it('parses 3x4 transforms and rejects malformed ones', () => {
    expect(Array.from(parseTransform('1 0 0 0 1 0 0 0 1 5 6 7'))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 5, 6, 7]);
    expect(Array.from(parseTransform(undefined))).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(() => parseTransform('1 0 0')).toThrow(/12 numbers/);
    expect(() => parseTransform('1 0 0 0 1 0 0 0 1 x 0 0')).toThrow(/finite/);
  });

  it('applies build item transforms and merges every item into one mesh', async () => {
    const parsed = await parse3MF(await pkg(model(`<resources>${cubeObject(1)}</resources><build>`
      + '<item objectid="1" transform="2 0 0 0 2 0 0 0 2 10 0 0"/>'
      + '<item objectid="1" transform="1 0 0 0 1 0 0 0 1 -5 -5 -5"/></build>')));
    expect(parsed.buildItems).toBe(2);
    expect(parsed.mesh.triCount).toBe(24);
    expect(bounds(parsed.mesh)).toEqual({ min: [-5, -5, -5], max: [12, 2, 2] });
    expect(computeSignedVolume(parsed.mesh)).toBeCloseTo(8 + 1, 6);
  });

  it('composes component transforms beneath the build item transform', async () => {
    // Rotate 90 degrees about Z (x' = -y, y' = x), then the item translates.
    const rotate = '0 1 0 -1 0 0 0 0 1 0 0 0';
    const parsed = await parse3MF(await pkg(model(`<resources>${cubeObject(1)}`
      + `<object id="2" type="model"><components><component objectid="1" transform="${rotate}"/>`
      + '<component objectid="1" transform="1 0 0 0 1 0 0 0 3 0 0 5"/></components></object></resources>'
      + '<build><item objectid="2" transform="1 0 0 0 1 0 0 0 1 100 0 0"/></build>', 'unit="centimeter"')));
    expect(parsed.mesh.triCount).toBe(24);
    const { min, max } = bounds(parsed.mesh);
    // Rotated cube spans x -1..0; stretched cube spans z 5..8; all in cm -> x10.
    expectClose(min, [990, 0, 0], 1e-4);
    expectClose(max, [1010, 10, 80], 1e-4);
    expect(computeSignedVolume(parsed.mesh)).toBeCloseTo((1 + 3) * 1000, 3);
  });

  it('reverses winding for mirrored instances so faces stay outward', async () => {
    const parsed = await parse3MF(await pkg(model(`<resources>${cubeObject(1)}</resources>`
      + '<build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build>')));
    expect(parsed.mirroredInstances).toBe(1);
    expect(bounds(parsed.mesh)).toEqual({ min: [-1, 0, 0], max: [0, 1, 1] });
    expect(computeSignedVolume(parsed.mesh)).toBeCloseTo(1, 6);
    expect(parsed.warnings.join(' ')).toContain('mirrored');
  });

  it('follows production-extension p:path references into other model parts', async () => {
    const objectPart = model(`<resources>${cubeObject(7)}</resources><build><item objectid="7" p:path="/ignored.model"/></build>`);
    const root = model('<resources><object id="1" type="model"><components>'
      + '<component p:path="/3D/Objects/object_1.model" objectid="7" transform="1 0 0 0 1 0 0 0 1 0 0 2"/>'
      + '</components></object></resources><build><item objectid="1"/></build>');
    const parsed = await parse3MF(await pkg(root, [{ name: '3D/Objects/object_1.model', data: objectPart, deflate: true }]));
    expect(bounds(parsed.mesh)).toEqual({ min: [0, 0, 2], max: [1, 1, 3] });
  });

  it('rejects component paths in child model parts', async () => {
    const root = model('<resources/><build><item objectid="1" p:path="/child.model"/></build>');
    const child = model('<resources><object id="1"><components>'
      + '<component objectid="1" p:path="/other.model"/></components></object></resources><build/>');
    await expect(parse3MF(await pkg(root, [{ name: 'child.model', data: child }])))
      .rejects.toThrow('child.model cannot reference another model part');
  });

  it('honors required extensions using their namespaces, including aliased prefixes', async () => {
    const build = `<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`;
    const supported = model(build, `requiredextensions="prod" xmlns:prod="${PROD}"`);
    expect((await parse3MF(await pkg(supported))).mesh.triCount).toBe(12);

    const unsupported = model(build, 'requiredextensions="p beam" xmlns:beam="http://schemas.microsoft.com/3dmanufacturing/beamlattice/2017/02"');
    await expect(parse3MF(await pkg(unsupported))).rejects.toThrow('requires an unsupported extension ("beam")');
  });

  it('skips support objects, ignores extension elements, and drops degenerate triangles', async () => {
    const slice = '<s:slicestack xmlns:s="http://schemas.microsoft.com/3dmanufacturing/slice/2015/07" id="9"><s:slice ztop="1"><s:vertices><s:vertex x="99" y="99"/></s:vertices></s:slice></s:slicestack>';
    const withDegenerate = cubeObject(1).replace('</triangles>', '<triangle v1="0" v2="0" v3="1"/></triangles>');
    const parsed = await parse3MF(await pkg(model(`<!-- note --><metadata name="Title">a &amp; b</metadata><resources>${slice}${withDegenerate}${cubeObject(2).replace('type="model"', 'type="support"')}</resources>`
      + '<build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 50 0 0"/></build>')));
    expect(parsed.mesh.triCount).toBe(12);
    expect(bounds(parsed.mesh).max).toEqual([1, 1, 1]);
    expect(parsed.warnings.join(' ')).toMatch(/Skipped 1 build item.*Dropped 1 triangle/);
  });
});

describe('3MF malformed input', () => {
  it('rejects non-ZIP, truncated and corrupt packages with a clear error', async () => {
    const good = await pkg(model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`));
    await expect(parse3MF(encoder.encode('solid not a zip'))).rejects.toThrow(/ZIP signature/);
    await expect(parse3MF(good.slice(0, good.length - 30))).rejects.toThrow(/not a readable ZIP/);
    await expect(parse3MF(good.slice(0, 200))).rejects.toThrow(/not a readable ZIP/);
    const corrupt = good.slice();
    corrupt[200] ^= 0xff; // inside the stored model part
    await expect(parse3MF(corrupt)).rejects.toThrow(/CRC|well-formed|invalid/);
    const deflated = await pkg(model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`), [], true);
    const entries = readZipDirectory(deflated, { maxEntries: 10, maxEntryBytes: 1 << 20 });
    const modelEntry = entries.find((entry) => entry.name === '3D/3dmodel.model')!;
    const garbled = deflated.slice();
    garbled.fill(0xff, modelEntry.localHeaderOffset + 60, modelEntry.localHeaderOffset + 80);
    await expect(parse3MF(garbled)).rejects.toThrow(/corrupt or truncated compressed data|CRC|inflated/);
  });

  it('rejects encrypted, unsupported-method and model-less packages', async () => {
    await expect(parse3MF(await zip([{ name: '3D/3dmodel.model', data: 'x', flags: 1 }]))).rejects.toThrow(/encrypted/);
    await expect(parse3MF(await zip([{ name: '3D/3dmodel.model', data: 'x', method: 12 }]))).rejects.toThrow(/compression method 12/);
    await expect(parse3MF(await zip([{ name: 'readme.txt', data: 'x' }]))).rejects.toThrow(/no 3D model part/);
  });

  it('rejects malformed XML and invalid model structure', async () => {
    const cases: [string, RegExp][] = [
      [model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`).slice(0, -30), /not well-formed XML/],
      [model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/>`), /expected <\/build> but found <\/model>/],
      [model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></bild>`), /expected <\/build>/],
      ['<!DOCTYPE model [<!ENTITY a "aaaa">]>' + model('<build/>'), /DTD/],
      [model('<resources>' + cubeObject(1).replace('v3="1"', 'v3="99"') + '</resources><build><item objectid="1"/></build>'), /references vertex 99/],
      [model('<resources>' + cubeObject(1).replace('x="1"', 'x="abc"') + '</resources><build><item objectid="1"/></build>'), /not a finite number/],
      [model(`<resources>${cubeObject(1)}</resources><build><item objectid="5"/></build>`), /object 5 is not defined/],
      [model(`<resources>${cubeObject(1)}</resources><build/>`), /no build items/],
      [model('<resources><object id="1"><components><component objectid="2"/></components></object>'
        + '<object id="2"><components><component objectid="1"/></components></object></resources><build><item objectid="1"/></build>'), /contains itself/],
      ['<notamodel/>', /not a 3MF model/],
    ];
    for (const [xml, error] of cases) await expect(parse3MF(await pkg(xml))).rejects.toThrow(error);
  });
});

describe('3MF resource limits', () => {
  const limits = (overrides: Partial<ImportLimits>): ImportLimits => ({ ...DEFAULT_IMPORT_LIMITS, ...overrides });
  const cube = model(`<resources>${cubeObject(1)}</resources><build><item objectid="1"/></build>`);

  it('rejects a package over the byte budget before reading it', async () => {
    const bytes = await pkg(cube);
    await expect(parse3MF(bytes, limits({ maxThreeMfBytes: bytes.length - 1 }))).rejects.toThrow(/import limit/);
    await expect(parse3MF(bytes, limits({ maxThreeMfBytes: bytes.length }))).resolves.toBeDefined();
  });

  it('refuses a zip bomb by declared size before inflating, and by actual output while inflating', async () => {
    const bomb = new Uint8Array(4 * 1024 * 1024); // 4 MiB of zeros deflates to ~4 KiB
    const declared = await pkg(cube, [], true);
    await expect(parse3MF(await zip([{ name: '_rels/.rels', data: RELS }, { name: '3D/3dmodel.model', data: bomb, deflate: true }]),
      limits({ maxThreeMfUncompressedBytes: 1024 * 1024 }))).rejects.toThrow(/1 MiB uncompressed import limit/);
    // Headers that understate the size: inflation stops at the declared size.
    await expect(parse3MF(await zip([{ name: '3D/3dmodel.model', data: bomb, deflate: true, declaredSize: 1000 }])))
      .rejects.toThrow(/inflates beyond its declared/);
    // The uncompressed budget is shared across every extracted part.
    const relsSize = encoder.encode(RELS).length;
    await expect(parse3MF(declared, limits({ maxThreeMfUncompressedBytes: relsSize + 10 }))).rejects.toThrow(/uncompressed import limit/);
  });

  it('caps the number of ZIP entries', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `Metadata/${i}.txt`, data: 'x' }));
    await expect(parse3MF(await pkg(cube, many), limits({ maxZipEntries: 5 }))).rejects.toThrow(/lists 9 entries, exceeding the supported limit of 5/);
  });

  it('enforces vertex and triangle limits while parsing and after component expansion', async () => {
    await expect(parse3MF(await pkg(cube), limits({ maxVertices: 7 }))).rejects.toThrow(/7 vertices/);
    await expect(parse3MF(await pkg(cube), limits({ maxTriangles: 11 }))).rejects.toThrow(/11 triangles/);
    // 12 triangles instanced 4 x 4 x 4 = 64 times is 768 triangles from a tiny file.
    const nest = (id: number, child: number) => `<object id="${id}"><components>${[0, 1, 2, 3].map((k) => `<component objectid="${child}" transform="1 0 0 0 1 0 0 0 1 ${k * 2} 0 0"/>`).join('')}</components></object>`;
    const amplified = model(`<resources>${cubeObject(1)}${nest(2, 1)}${nest(3, 2)}${nest(4, 3)}</resources><build><item objectid="4"/></build>`);
    await expect(parse3MF(await pkg(amplified), limits({ maxTriangles: 700 }))).rejects.toThrow(/expands to 768 triangles/);
    await expect(parse3MF(await pkg(amplified), limits({ maxComponentInstances: 50 }))).rejects.toThrow(/object instances/);
    expect((await parse3MF(await pkg(amplified))).mesh.triCount).toBe(768);
  });
});
