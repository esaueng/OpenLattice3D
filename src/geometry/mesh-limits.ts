export const MAX_MESH_COORDINATE = 1_000_000;
export const MAX_MESH_SURFACE_AREA = 1_000_000_000_000;

// Browser-memory import budgets. Every import path must reject input that
// exceeds these budgets before allocating typed arrays, decoding text, or
// running atob(), so a hostile or accidental file cannot exhaust tab memory.
//
// Rationale:
// - MAX_MESH_TRIANGLES bounds the positions/normals allocation to roughly
//   240 MiB (5M triangles * 12 floats * 4 bytes) plus parser overhead.
// - MAX_STL_FILE_BYTES independently caps file bytes read into memory; a
//   maximal binary STL spends 50 bytes per triangle, so the byte cap normally
//   bites before the triangle cap. The triangle cap still guards oversized
//   header declarations and the incrementally growing ASCII parser arrays.
// - Project JSON embeds one base64 binary STL (4/3 expansion), so the project
//   budget must exceed the embedded budget by at least that factor.
export const MAX_MESH_TRIANGLES = 5_000_000;
export const MAX_STL_FILE_BYTES = 128 * 1024 * 1024;
export const MAX_EMBEDDED_STL_BYTES = MAX_STL_FILE_BYTES;
export const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024;

// Indexed formats (3MF, OBJ):
// - MAX_MESH_VERTICES allows any triangle soup that fits the triangle cap
//   (three unshared corners per triangle). In practice the byte caps below
//   bite first: a 3MF vertex element or OBJ `v` line is at least ~10 bytes.
// - 3MF is a ZIP. The package itself has the STL byte cap. Extracted parts
//   (relationships plus model XML) share one uncompressed budget equal to the
//   project budget, checked against each entry's declared size before any
//   allocation and enforced again while inflating, so a zip bomb is refused
//   instead of expanded. Unused entries (thumbnails, textures) are never
//   extracted. Real 3MF packages list a handful of entries; the entry cap only
//   bounds central-directory parsing.
// - Components can instance one object many times, so the expanded instance
//   count is capped separately from triangles (which are counted after
//   expansion, before the output mesh is allocated).
// - OBJ is text at roughly 2-3x the bytes of binary STL per triangle, so it
//   gets the project budget rather than the STL one.
export const MAX_MESH_VERTICES = 3 * MAX_MESH_TRIANGLES;
export const MAX_3MF_FILE_BYTES = MAX_STL_FILE_BYTES;
export const MAX_3MF_UNCOMPRESSED_BYTES = MAX_PROJECT_FILE_BYTES;
export const MAX_ZIP_ENTRIES = 4096;
export const MAX_3MF_COMPONENT_INSTANCES = 100_000;
export const MAX_OBJ_FILE_BYTES = MAX_PROJECT_FILE_BYTES;

export interface ImportLimits {
  maxStlBytes: number;
  maxTriangles: number;
  maxEmbeddedStlBytes: number;
  maxProjectBytes: number;
  maxVertices: number;
  maxThreeMfBytes: number;
  maxThreeMfUncompressedBytes: number;
  maxZipEntries: number;
  maxComponentInstances: number;
  maxObjBytes: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxStlBytes: MAX_STL_FILE_BYTES,
  maxTriangles: MAX_MESH_TRIANGLES,
  maxEmbeddedStlBytes: MAX_EMBEDDED_STL_BYTES,
  maxProjectBytes: MAX_PROJECT_FILE_BYTES,
  maxVertices: MAX_MESH_VERTICES,
  maxThreeMfBytes: MAX_3MF_FILE_BYTES,
  maxThreeMfUncompressedBytes: MAX_3MF_UNCOMPRESSED_BYTES,
  maxZipEntries: MAX_ZIP_ENTRIES,
  maxComponentInstances: MAX_3MF_COMPONENT_INSTANCES,
  maxObjBytes: MAX_OBJ_FILE_BYTES,
};

export function formatByteCount(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KiB`;
  return `${Number((bytes / (1024 * 1024)).toFixed(1))} MiB`;
}

/** Reject an input whose byte size exceeds its budget before it is read. */
export function assertFileSizeWithinBudget(sizeBytes: number, budgetBytes: number, label: string): void {
  if (sizeBytes > budgetBytes) {
    throw new Error(
      `${label} is ${formatByteCount(sizeBytes)}, exceeding the ${formatByteCount(budgetBytes)} import limit`
    );
  }
}

/** Upper bound on the bytes atob() will produce for an encoded length. */
export function estimateDecodedBase64Bytes(encodedLength: number): number {
  return Math.ceil(encodedLength / 4) * 3;
}

export function validateMeshPositions(positions: ArrayLike<number>): void {
  for (let i = 0; i < positions.length; i++) {
    const coordinate = positions[i];
    if (!Number.isFinite(coordinate) || Math.abs(coordinate) > MAX_MESH_COORDINATE) {
      throw new Error(
        `Mesh coordinate at index ${i} must be finite and within +/-${MAX_MESH_COORDINATE}`
      );
    }
  }
}

export function addMeshTriangleArea(totalArea: number, triangleArea: number): number {
  const nextArea = totalArea + triangleArea;
  if (!Number.isFinite(triangleArea) || !Number.isFinite(nextArea) || nextArea > MAX_MESH_SURFACE_AREA) {
    throw new Error(`Mesh surface area exceeds the supported limit of ${MAX_MESH_SURFACE_AREA}`);
  }
  return nextArea;
}

/** Mesh file formats the importer reads. */
export type MeshFileFormat = 'stl' | '3mf' | 'obj';
export const MESH_FILE_FORMATS: readonly MeshFileFormat[] = ['stl', '3mf', 'obj'];
export const MESH_FORMAT_LABEL: Readonly<Record<MeshFileFormat, string>> = { stl: 'STL', '3mf': '3MF', obj: 'OBJ' };

/** The byte budget checked against a mesh file's declared size before reading it. */
export function meshFileByteBudget(format: MeshFileFormat, limits: ImportLimits = DEFAULT_IMPORT_LIMITS): number {
  if (format === '3mf') return limits.maxThreeMfBytes;
  if (format === 'obj') return limits.maxObjBytes;
  return limits.maxStlBytes;
}
