// Minimal ZIP reader for 3MF packages: central directory, STORE and DEFLATE.
//
// Only what 3MF needs and nothing that could exhaust tab memory. Every size
// that drives an allocation is checked against a budget before allocating,
// and inflation is streamed and aborted as soon as it produces more bytes
// than the entry declares, so a zip bomb fails fast instead of expanding.
// Decompression uses the platform `DecompressionStream('deflate-raw')`
// (browsers, workers and Node 22), so there is no dependency.
import { formatByteCount } from './mesh-limits';

export interface ZipLimits {
  /** Most central-directory entries a package may list. */
  maxEntries: number;
  /** Largest uncompressed size of any single extracted entry. */
  maxEntryBytes: number;
}

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_CENTRAL_DIRECTORY_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_MARKER = 0xffffffff;

/** Whether bytes begin with a ZIP local file header (`PK\x03\x04`). */
export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const utf8 = new TextDecoder('utf-8', { fatal: false });
// ZIP names without the UTF-8 flag are CP437; for the ASCII names 3MF uses
// the two agree, and anything else is only compared, never written anywhere.
function decodeName(bytes: Uint8Array): string {
  return utf8.decode(bytes);
}

function fail(message: string): never {
  throw new Error(`3MF package is not a readable ZIP: ${message}`);
}

/** Read the central directory. Throws on truncation, ZIP64, or too many entries. */
export function readZipDirectory(bytes: Uint8Array, limits: ZipLimits): ZipEntry[] {
  if (bytes.length < END_OF_CENTRAL_DIRECTORY_BYTES) fail('file is too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits in the last 22 bytes plus an optional comment.
  const earliest = Math.max(0, bytes.length - END_OF_CENTRAL_DIRECTORY_BYTES - MAX_COMMENT_BYTES);
  let end = -1;
  for (let offset = bytes.length - END_OF_CENTRAL_DIRECTORY_BYTES; offset >= earliest; offset--) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE
      && offset + END_OF_CENTRAL_DIRECTORY_BYTES + view.getUint16(offset + 20, true) === bytes.length) {
      end = offset;
      break;
    }
  }
  if (end < 0) fail('end of central directory not found (truncated or not a ZIP)');
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail('multi-disk archives are not supported');
  const entryCount = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  const directoryOffset = view.getUint32(end + 16, true);
  if (entryCount === 0xffff || directorySize === ZIP64_MARKER || directoryOffset === ZIP64_MARKER) fail('ZIP64 archives are not supported');
  if (entryCount > limits.maxEntries) {
    throw new Error(`3MF package lists ${entryCount} entries, exceeding the supported limit of ${limits.maxEntries}`);
  }
  if (directoryOffset + directorySize > end) fail('central directory lies outside the file');

  const entries: ZipEntry[] = [];
  let offset = directoryOffset;
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > end || view.getUint32(offset, true) !== CENTRAL_HEADER_SIGNATURE) fail(`central directory entry ${i + 1} is corrupt`);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const next = offset + 46 + nameLength + extraLength + commentLength;
    if (next > end) fail(`central directory entry ${i + 1} is truncated`);
    const entry: ZipEntry = {
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      crc32: view.getUint32(offset + 16, true),
      compressedSize: view.getUint32(offset + 20, true),
      uncompressedSize: view.getUint32(offset + 24, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
      name: decodeName(bytes.subarray(offset + 46, offset + 46 + nameLength)),
    };
    if (entry.compressedSize === ZIP64_MARKER || entry.uncompressedSize === ZIP64_MARKER || entry.localHeaderOffset === ZIP64_MARKER) {
      fail(`entry ${entry.name} uses ZIP64, which is not supported`);
    }
    entries.push(entry);
    offset = next;
  }
  return entries;
}

/** Locate an entry's data through its local header, bounds-checked. */
function entryData(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localHeaderOffset;
  if (header + 30 > bytes.length || view.getUint32(header, true) !== LOCAL_HEADER_SIGNATURE) {
    fail(`local header for ${entry.name} is missing`);
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const stop = start + entry.compressedSize;
  if (stop > bytes.length) fail(`entry ${entry.name} is truncated`);
  return bytes.subarray(start, stop);
}

async function inflateRaw(data: Uint8Array, expectedBytes: number, name: string): Promise<Uint8Array> {
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot decompress 3MF packages (DecompressionStream is unavailable)');
  }
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Errors surface on the reader; the writer side only needs to not go unhandled.
  const writing = writer.write(data as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => undefined);
  const out = new Uint8Array(expectedBytes);
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.length > expectedBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`3MF entry ${name} inflates beyond its declared ${formatByteCount(expectedBytes)}; refusing a possible zip bomb`);
      }
      out.set(value, length);
      length += value.length;
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('3MF entry')) throw error;
    fail(`entry ${name} has corrupt or truncated compressed data`);
  } finally {
    await writing;
  }
  if (length !== expectedBytes) fail(`entry ${name} inflated to ${length} bytes, but declares ${expectedBytes}`);
  return out;
}

/** Extract one entry, enforcing the size budget before any allocation. */
export async function extractZipEntry(bytes: Uint8Array, entry: ZipEntry, limits: ZipLimits): Promise<Uint8Array> {
  if (entry.flags & 0x1) fail(`entry ${entry.name} is encrypted`);
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new Error(
      `3MF entry ${entry.name} is ${formatByteCount(entry.uncompressedSize)} uncompressed, exceeding the ${formatByteCount(limits.maxEntryBytes)} import limit`,
    );
  }
  const data = entryData(bytes, entry);
  let out: Uint8Array;
  if (entry.method === METHOD_STORE) {
    if (entry.compressedSize !== entry.uncompressedSize) fail(`stored entry ${entry.name} has inconsistent sizes`);
    out = data.slice();
  } else if (entry.method === METHOD_DEFLATE) {
    out = await inflateRaw(data, entry.uncompressedSize, entry.name);
  } else {
    fail(`entry ${entry.name} uses unsupported compression method ${entry.method}`);
  }
  if (crc32(out) !== entry.crc32) fail(`entry ${entry.name} failed its CRC check`);
  return out;
}
