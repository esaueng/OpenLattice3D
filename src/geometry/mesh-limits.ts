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

export interface ImportLimits {
  maxStlBytes: number;
  maxTriangles: number;
  maxEmbeddedStlBytes: number;
  maxProjectBytes: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxStlBytes: MAX_STL_FILE_BYTES,
  maxTriangles: MAX_MESH_TRIANGLES,
  maxEmbeddedStlBytes: MAX_EMBEDDED_STL_BYTES,
  maxProjectBytes: MAX_PROJECT_FILE_BYTES,
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
