export const MAX_MESH_COORDINATE = 1_000_000;
export const MAX_MESH_SURFACE_AREA = 1_000_000_000_000;
export const MAX_SURFACE_SAMPLE_COUNT = 100_000;

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

export function surfaceSampleCount(totalArea: number, cellSize: number): number {
  const spacingArea = cellSize * cellSize * 0.55;
  if (!Number.isFinite(totalArea) || totalArea < 0 || !Number.isFinite(spacingArea) || spacingArea <= 0) {
    throw new Error('Cannot calculate surface samples from invalid mesh area or cell size');
  }
  return Math.min(MAX_SURFACE_SAMPLE_COUNT, Math.max(60, Math.round(totalArea / spacingArea)));
}
