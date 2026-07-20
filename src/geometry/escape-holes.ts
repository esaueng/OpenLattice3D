import type { GridSdfSampler } from './marching-cubes';
import type { Vec3 } from './vec3';
import type { BoundingBox, EscapeHoleAxis, LatticeParams } from '../types/project';

export type SampledSdf = ((x: number, y: number, z: number) => number) & Partial<GridSdfSampler>;

export function shouldApplyEscapeHoles(params: LatticeParams): boolean {
  return params.escapeHoles
    && params.escapeHoleCount > 0
    && params.escapeHoleDiameter > 0
    && params.variant === 'shell_core'
    && !params.noShell
    && !params.surfaceOnly;
}

/** Deterministic through-hole centres in the plane normal to the build axis.
 * Coordinates are kept within the middle 44% of the bounding box so the
 * cylinders have a good chance of crossing irregular imported parts. */
export function escapeHoleCenters(
  bounds: BoundingBox,
  axis: EscapeHoleAxis,
  count: number,
): Vec3[] {
  const safeCount = Math.max(0, Math.min(100, Math.floor(count)));
  if (safeCount === 0) return [];
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
  const transverse = axis === 'x' ? [1, 2] : axis === 'y' ? [0, 2] : [0, 1];
  const spanU = bounds.max[transverse[0]] - bounds.min[transverse[0]];
  const spanV = bounds.max[transverse[1]] - bounds.min[transverse[1]];

  if (safeCount === 1) return [center];
  if (safeCount === 2) {
    return [-1, 1].map((direction) => {
      const point: Vec3 = [...center];
      point[transverse[0]] += direction * spanU * 0.22;
      return point;
    });
  }

  const points: Vec3[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < safeCount; i++) {
    const radius = 0.31 * Math.sqrt((i + 0.5) / safeCount);
    const angle = i * goldenAngle;
    const point: Vec3 = [...center];
    point[transverse[0]] += Math.cos(angle) * spanU * radius;
    point[transverse[1]] += Math.sin(angle) * spanV * radius;
    points.push(point);
  }
  return points;
}

/** Signed distance to the union of infinite cylinders along the build axis. */
export function escapeHolesSdf(
  x: number,
  y: number,
  z: number,
  centers: readonly Vec3[],
  axis: EscapeHoleAxis,
  diameter: number,
): number {
  const radius = diameter * 0.5;
  let distance = Infinity;
  for (const center of centers) {
    let radial: number;
    if (axis === 'x') radial = Math.hypot(y - center[1], z - center[2]);
    else if (axis === 'y') radial = Math.hypot(x - center[0], z - center[2]);
    else radial = Math.hypot(x - center[0], y - center[1]);
    distance = Math.min(distance, radial - radius);
  }
  return distance;
}

/** Subtract escape-hole cylinders from a negative-inside material SDF. */
export function withEscapeHoles(
  base: SampledSdf,
  params: LatticeParams,
  bounds: BoundingBox | null,
): SampledSdf {
  if (!bounds || !shouldApplyEscapeHoles(params)) return base;
  const centers = escapeHoleCenters(bounds, params.escapeHoleAxis, params.escapeHoleCount);
  const result: SampledSdf = (x, y, z) => Math.max(
    base(x, y, z),
    -escapeHolesSdf(x, y, z, centers, params.escapeHoleAxis, params.escapeHoleDiameter),
  );

  if (base.sampleField) {
    result.sampleField = (sampleBounds, resolution, out, onProgress) => {
      base.sampleField!(sampleBounds, resolution, out, onProgress);
      const count = resolution + 1;
      const dx = (sampleBounds.max[0] - sampleBounds.min[0]) / resolution;
      const dy = (sampleBounds.max[1] - sampleBounds.min[1]) / resolution;
      const dz = (sampleBounds.max[2] - sampleBounds.min[2]) / resolution;
      let index = 0;
      for (let zi = 0; zi < count; zi++) {
        const z = sampleBounds.min[2] + zi * dz;
        for (let yi = 0; yi < count; yi++) {
          const y = sampleBounds.min[1] + yi * dy;
          for (let xi = 0; xi < count; xi++, index++) {
            const x = sampleBounds.min[0] + xi * dx;
            const hole = escapeHolesSdf(x, y, z, centers, params.escapeHoleAxis, params.escapeHoleDiameter);
            out[index] = Math.max(out[index], -hole);
          }
        }
      }
    };
  }
  return result;
}
