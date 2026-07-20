import type { MarchingCubesResult } from './marching-cubes';

const encoder = new TextEncoder();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function setUint16(view: DataView, offset: number, value: number): number {
  view.setUint16(offset, value, true);
  return offset + 2;
}

function setUint32(view: DataView, offset: number, value: number): number {
  view.setUint32(offset, value, true);
  return offset + 4;
}

type ZipEntry = { name: string; data: Uint8Array };

/** Deterministic ZIP container using the STORE method required by 3MF readers. */
function createStoredZip(entries: ZipEntry[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const checksum = crc32(entry.data);
    const local = new Uint8Array(30 + name.length + entry.data.length);
    const localView = new DataView(local.buffer);
    let offset = 0;
    offset = setUint32(localView, offset, 0x04034b50);
    offset = setUint16(localView, offset, 20);
    offset = setUint16(localView, offset, 0);
    offset = setUint16(localView, offset, 0);
    offset = setUint16(localView, offset, 0);
    offset = setUint16(localView, offset, 0);
    offset = setUint32(localView, offset, checksum);
    offset = setUint32(localView, offset, entry.data.length);
    offset = setUint32(localView, offset, entry.data.length);
    offset = setUint16(localView, offset, name.length);
    offset = setUint16(localView, offset, 0);
    local.set(name, offset);
    local.set(entry.data, offset + name.length);
    locals.push(local);

    const directory = new Uint8Array(46 + name.length);
    const directoryView = new DataView(directory.buffer);
    offset = 0;
    offset = setUint32(directoryView, offset, 0x02014b50);
    offset = setUint16(directoryView, offset, 20);
    offset = setUint16(directoryView, offset, 20);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint32(directoryView, offset, checksum);
    offset = setUint32(directoryView, offset, entry.data.length);
    offset = setUint32(directoryView, offset, entry.data.length);
    offset = setUint16(directoryView, offset, name.length);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint16(directoryView, offset, 0);
    offset = setUint32(directoryView, offset, 0);
    offset = setUint32(directoryView, offset, localOffset);
    directory.set(name, offset);
    central.push(directory);
    localOffset += local.length;
  }

  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  let offset = 0;
  offset = setUint32(endView, offset, 0x06054b50);
  offset = setUint16(endView, offset, 0);
  offset = setUint16(endView, offset, 0);
  offset = setUint16(endView, offset, entries.length);
  offset = setUint16(endView, offset, entries.length);
  offset = setUint32(endView, offset, centralSize);
  offset = setUint32(endView, offset, localOffset);
  setUint16(endView, offset, 0);

  const total = localOffset + centralSize + end.length;
  const zip = new Uint8Array(total);
  offset = 0;
  for (const local of locals) {
    zip.set(local, offset);
    offset += local.length;
  }
  for (const directory of central) {
    zip.set(directory, offset);
    offset += directory.length;
  }
  zip.set(end, offset);
  return zip;
}

function numberText(value: number): string {
  if (!Number.isFinite(value)) throw new Error('3MF export cannot encode non-finite coordinates');
  return Number(value.toPrecision(9)).toString();
}

export function build3MFModelXml(result: MarchingCubesResult): string {
  const vertexIndex = new Map<string, number>();
  const vertices: string[] = [];
  const triangles: string[] = [];

  const indexFor = (x: number, y: number, z: number) => {
    const key = `${x},${y},${z}`;
    const existing = vertexIndex.get(key);
    if (existing !== undefined) return existing;
    const index = vertices.length;
    vertexIndex.set(key, index);
    vertices.push(`<vertex x="${numberText(x)}" y="${numberText(y)}" z="${numberText(z)}"/>`);
    return index;
  };

  for (let triangle = 0; triangle < result.triCount; triangle++) {
    const offset = triangle * 9;
    const v1 = indexFor(result.positions[offset], result.positions[offset + 1], result.positions[offset + 2]);
    const v2 = indexFor(result.positions[offset + 3], result.positions[offset + 4], result.positions[offset + 5]);
    const v3 = indexFor(result.positions[offset + 6], result.positions[offset + 7], result.positions[offset + 8]);
    triangles.push(`<triangle v1="${v1}" v2="${v2}" v3="${v3}"/>`);
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${vertices.join('')}</vertices><triangles>${triangles.join('')}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
}

export function create3MF(result: MarchingCubesResult): Uint8Array {
  if (result.positions.length < result.triCount * 9) {
    throw new Error('3MF export position buffer is smaller than triCount requires');
  }
  const contentTypes = `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;
  const relationships = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;
  return createStoredZip([
    { name: '[Content_Types].xml', data: encoder.encode(contentTypes) },
    { name: '_rels/.rels', data: encoder.encode(relationships) },
    { name: '3D/3dmodel.model', data: encoder.encode(build3MFModelXml(result)) },
  ]);
}
