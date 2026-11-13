// Single-buffer transport form of a serialized MeshBVH.
//
// Every array a MeshBVH queries is copied into one ArrayBuffer or
// SharedArrayBuffer at 4-byte-aligned offsets. A SharedArrayBuffer is posted
// to any number of tile workers without copying; a plain ArrayBuffer is
// transferred, so a pool needs one packed copy per worker.
import type { SerializedMeshBVH } from './bvh';

type ArrayKey = Exclude<keyof SerializedMeshBVH, 'triCount'>;
type ArrayKind = 'f32' | 'i32' | 'u32';

const ARRAY_LAYOUT: readonly (readonly [ArrayKey, ArrayKind])[] = [
  ['positions', 'f32'],
  ['normals', 'f32'],
  ['nodeMin', 'f32'],
  ['nodeMax', 'f32'],
  ['leftFirst', 'i32'],
  ['count', 'i32'],
  ['triIndices', 'u32'],
  ['triA', 'f32'],
  ['triAB', 'f32'],
  ['triAC', 'f32'],
  ['triBC', 'f32'],
  ['triVertex', 'u32'],
  ['triEdge', 'u32'],
  ['vertexNormals', 'f32'],
  ['edgeNormals', 'f32'],
];

export interface PackedMeshBVH {
  triCount: number;
  /** Element count of each array, in ARRAY_LAYOUT order. */
  lengths: number[];
  buffer: ArrayBuffer | SharedArrayBuffer;
}

/** Whether this context may share memory with workers (COOP/COEP isolation). */
export function canShareMemory(): boolean {
  return typeof SharedArrayBuffer === 'function'
    && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

export function packSerializedMeshBVH(data: SerializedMeshBVH, shared: boolean): PackedMeshBVH {
  const lengths = ARRAY_LAYOUT.map(([key]) => data[key].length);
  const totalElements = lengths.reduce((sum, length) => sum + length, 0);
  const byteLength = totalElements * 4;
  const buffer = shared ? new SharedArrayBuffer(byteLength) : new ArrayBuffer(byteLength);
  // Copy raw bits through one view so float payloads (including NaN
  // patterns and -0) survive unchanged.
  const words = new Uint32Array(buffer);
  let offset = 0;
  for (const [key] of ARRAY_LAYOUT) {
    const source = data[key];
    words.set(new Uint32Array(source.buffer, source.byteOffset, source.length), offset);
    offset += source.length;
  }
  return { triCount: data.triCount, lengths, buffer };
}

/** Copy a packed BVH into a fresh transferable ArrayBuffer. */
export function clonePackedMeshBVH(packed: PackedMeshBVH): PackedMeshBVH {
  const buffer = new ArrayBuffer(packed.buffer.byteLength);
  new Uint8Array(buffer).set(new Uint8Array(packed.buffer));
  return { triCount: packed.triCount, lengths: [...packed.lengths], buffer };
}

/** Typed-array views over a packed buffer; nothing is copied. */
export function unpackSerializedMeshBVH(packed: PackedMeshBVH): SerializedMeshBVH {
  if (!Array.isArray(packed.lengths) || packed.lengths.length !== ARRAY_LAYOUT.length) {
    throw new Error('Packed MeshBVH has an unexpected layout');
  }
  const totalElements = packed.lengths.reduce((sum, length) => sum + length, 0);
  if (
    !packed.lengths.every((length) => Number.isInteger(length) && length >= 0)
    || totalElements * 4 !== packed.buffer.byteLength
  ) {
    throw new Error('Packed MeshBVH buffer does not match its layout');
  }
  const views: Partial<Record<ArrayKey, Float32Array | Int32Array | Uint32Array>> = {};
  let byteOffset = 0;
  ARRAY_LAYOUT.forEach(([key, kind], index) => {
    const length = packed.lengths[index];
    views[key] = kind === 'f32'
      ? new Float32Array(packed.buffer, byteOffset, length)
      : kind === 'i32'
        ? new Int32Array(packed.buffer, byteOffset, length)
        : new Uint32Array(packed.buffer, byteOffset, length);
    byteOffset += length * 4;
  });
  return { triCount: packed.triCount, ...views } as SerializedMeshBVH;
}
