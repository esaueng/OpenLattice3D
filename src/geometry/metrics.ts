// Engineering readouts for a generated lattice: how much material it uses,
// and therefore what it weighs and how much was saved against a solid part.
import type { Vec3 } from './vec3';
import type { MarchingCubesResult } from './marching-cubes';

/** Samples per axis for the occupancy integral. See sampleOccupiedVolume. */
export const VOLUME_SAMPLES_PER_AXIS = 48;

export interface LatticeMetrics {
  /** Volume of the solid part the lattice was generated inside, mm^3. Exact. */
  envelopeVolume: number;
  /** Material volume of the lattice, mm^3. Estimated by occupancy sampling. */
  latticeVolume: number;
  /** latticeVolume / envelopeVolume. */
  relativeDensity: number;
  /** Surface area of the extracted mesh, mm^2. Resolution dependent. */
  surfaceArea: number;
  /** Samples per axis actually used, so the report can state its own basis. */
  volumeSamplesPerAxis: number;
}

/**
 * Material volume, by counting sample points that fall inside the field.
 *
 * Deliberately measured from the field rather than from the extracted mesh.
 * Marching cubes under-resolves thin lattice walls, so a mesh-based volume
 * drifts badly with export resolution — measured on a default gyroid sphere it
 * reported a relative density of 0.241 at resolution 48 against 0.384 at 168,
 * which makes the headline number a function of an unrelated quality slider.
 * The occupancy integral converges immediately instead: the same case holds
 * 0.378-0.388 across every grid from 32 to 192.
 *
 * Sampling cell centres rather than corners keeps the estimate unbiased for
 * features that straddle the sampling grid.
 */
export function sampleOccupiedVolume(
  sdf: (x: number, y: number, z: number) => number,
  bounds: { min: Vec3; max: Vec3 },
  samplesPerAxis: number = VOLUME_SAMPLES_PER_AXIS
): number {
  const n = Math.max(2, Math.floor(samplesPerAxis));
  const sx = bounds.max[0] - bounds.min[0];
  const sy = bounds.max[1] - bounds.min[1];
  const sz = bounds.max[2] - bounds.min[2];
  const dx = sx / n;
  const dy = sy / n;
  const dz = sz / n;

  let inside = 0;
  for (let k = 0; k < n; k++) {
    const z = bounds.min[2] + (k + 0.5) * dz;
    for (let j = 0; j < n; j++) {
      const y = bounds.min[1] + (j + 0.5) * dy;
      for (let i = 0; i < n; i++) {
        if (sdf(bounds.min[0] + (i + 0.5) * dx, y, z) <= 0) inside++;
      }
    }
  }

  return (inside / (n * n * n)) * sx * sy * sz;
}

/** Total triangle area of the extracted mesh, mm^2. */
export function computeSurfaceArea(result: MarchingCubesResult): number {
  const { positions, triCount } = result;
  let area = 0;

  for (let i = 0; i < triCount; i++) {
    const o = i * 9;
    const e1x = positions[o + 3] - positions[o];
    const e1y = positions[o + 4] - positions[o + 1];
    const e1z = positions[o + 5] - positions[o + 2];
    const e2x = positions[o + 6] - positions[o];
    const e2y = positions[o + 7] - positions[o + 1];
    const e2z = positions[o + 8] - positions[o + 2];
    const cx = e1y * e2z - e1z * e2y;
    const cy = e1z * e2x - e1x * e2z;
    const cz = e1x * e2y - e1y * e2x;
    area += 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
  }

  return area;
}

/** Grams, from mm^3 and g/cm^3. */
export function massGrams(volumeMm3: number, densityGramsPerCm3: number): number {
  return (volumeMm3 / 1000) * densityGramsPerCm3;
}
