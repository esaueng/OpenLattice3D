export const MIN_SURFACE_SAMPLES = 60;
export const MAX_SURFACE_SAMPLES = 10_000;

export function surfaceSampleTargetCount(totalArea: number, cellSize: number): number {
  if (!Number.isFinite(totalArea) || totalArea < 0) {
    throw new Error('Surface sampling rejected a mesh with non-finite area');
  }
  if (!Number.isFinite(cellSize) || cellSize <= 0) {
    throw new Error('Surface sampling requires a finite positive cell size');
  }

  const requested = Math.max(MIN_SURFACE_SAMPLES, Math.round(totalArea / (cellSize * cellSize * 0.55)));
  if (!Number.isFinite(requested) || requested > MAX_SURFACE_SAMPLES) {
    throw new Error(
      `Surface sampling requires more than ${MAX_SURFACE_SAMPLES.toLocaleString()} points; increase cell size or reduce model scale`,
    );
  }
  return requested;
}
