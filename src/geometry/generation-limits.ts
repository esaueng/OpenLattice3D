import { MAX_MESH_TRIANGLES } from './mesh-limits';
import type { Vec3 } from './vec3';

// Preserve every supported export setting (up to 264 cells per axis), while
// bounding direct worker/library calls and the single-grid fallback as well.
export const MAX_GENERATION_FIELD_SAMPLES = 265 ** 3;

/** Validate dimensions before sampling, tile scheduling or typed-array allocation. */
export function generationSampleCount(cells: Vec3): number {
  if (cells.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error('Generation grid dimensions must be positive finite integers.');
  }
  const samples = cells.reduce((product, count) => product * (count + 1), 1);
  if (!Number.isSafeInteger(samples) || samples > MAX_GENERATION_FIELD_SAMPLES) {
    throw new Error('Generation grid exceeds the supported memory limit; lower the export resolution.');
  }
  return samples;
}

/** Bound extracted output and retained tiles before allocating the merged copy. */
export function assertGenerationOutputBudget(
  triangles: number,
  positionValues = triangles * 9,
  normalValues = triangles * 3,
  retainedBytes = (positionValues + normalValues) * Float32Array.BYTES_PER_ELEMENT,
): void {
  if (!Number.isSafeInteger(triangles) || triangles < 0
    || triangles > MAX_MESH_TRIANGLES
    || !Number.isSafeInteger(positionValues) || positionValues < 0
    || !Number.isSafeInteger(normalValues) || normalValues < 0
    || positionValues + normalValues > MAX_MESH_TRIANGLES * 12
    || !Number.isSafeInteger(retainedBytes) || retainedBytes < 0
    || retainedBytes > MAX_MESH_TRIANGLES * 12 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`Generated mesh exceeds the ${MAX_MESH_TRIANGLES.toLocaleString()} triangle memory limit; lower the export resolution.`);
  }
}
