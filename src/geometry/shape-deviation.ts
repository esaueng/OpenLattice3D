// Outer deviation against an analytic object SDF (the built-in sample shapes).
import type { MarchingCubesResult } from './marching-cubes';
import type { ObjectSdf } from './sample-shapes';

export interface OuterDeviationMeasurement {
  passed: boolean;
  /** Largest sampled distance (mm) by which the result surface lies outside the object. */
  maxDeviation: number;
  /** Triangle samples with a finite object distance; 0 means the check could not be measured. */
  sampled: number;
}

/** Default triangle sample budget, shared with the sphere and reference-mesh checks. */
export const OUTER_DEVIATION_SAMPLE_COUNT = 2000;

/**
 * Measure how far the generated surface pokes outside the object it was cut
 * from, using the object's analytic SDF.
 *
 * This generalises `checkSphereDeviation` to any shape. Which result triangles
 * count as "outer" is decided by the field itself: a triangle centroid with a
 * positive object distance lies outside the envelope and its distance is the
 * deviation; centroids on or inside the surface (the outer skin and every
 * interior lattice wall) contribute zero. That makes the check meaningful for
 * every variant, including open-exterior lattices that have no continuous skin.
 *
 * Only outward deviation is measured, matching the sphere and reference-mesh
 * checks: material that stops short of the surface is not an envelope
 * violation and is left to the thickness check.
 *
 * With no usable samples (empty mesh, non-finite field values) the result is
 * reported as unmeasured (`sampled: 0`) and fails, never as a 0 mm pass.
 */
export function checkAnalyticOuterDeviation(
  result: MarchingCubesResult,
  objectSdf: ObjectSdf,
  tolerance: number,
  sampleCount: number = OUTER_DEVIATION_SAMPLE_COUNT,
): OuterDeviationMeasurement {
  const { positions, triCount } = result;
  const available = Math.min(triCount, Math.floor(positions.length / 9));
  if (available <= 0) return { passed: false, maxDeviation: 0, sampled: 0 };
  const step = Math.max(1, Math.floor(available / Math.max(1, sampleCount)));

  let maxDeviation = 0;
  let sampled = 0;
  for (let i = 0; i < available; i += step) {
    const o = i * 9;
    const cx = (positions[o] + positions[o + 3] + positions[o + 6]) / 3;
    const cy = (positions[o + 1] + positions[o + 4] + positions[o + 7]) / 3;
    const cz = (positions[o + 2] + positions[o + 5] + positions[o + 8]) / 3;
    const distance = objectSdf(cx, cy, cz);
    if (!Number.isFinite(distance)) continue;
    sampled++;
    if (distance > maxDeviation) maxDeviation = distance;
  }

  if (sampled === 0) return { passed: false, maxDeviation: 0, sampled: 0 };
  return { passed: maxDeviation <= tolerance, maxDeviation, sampled };
}
