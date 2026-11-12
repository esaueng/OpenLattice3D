// Analytic object SDFs for the built-in sample shapes, in millimetres.
//
// Negative inside, positive outside, exact Euclidean distance outside every
// shape (and exact or a lower bound inside), so |sdf| at a point on or outside
// the surface is its distance to the shape in mm.
import type { SampleShape } from '../types/project';

export type ObjectSdf = (x: number, y: number, z: number) => number;

/** Fallback sphere radius used whenever the stored radius is unset or zero. */
export const DEFAULT_SAMPLE_SPHERE_RADIUS = 25;

/** Fixed dimensions of the non-sphere samples, matching the generation worker. */
export const SAMPLE_SHAPE_DIMENSIONS = {
  cube: { halfSize: 15 },
  cylinder: { radius: 15, halfHeight: 20 },
  torus: { majorRadius: 20, tubeRadius: 8 },
  capsule: { radius: 12, halfHeight: 15 },
} as const;

export function sampleSphereRadius(sphereRadius: number): number {
  return sphereRadius || DEFAULT_SAMPLE_SPHERE_RADIUS;
}

export function sampleShapeObjectSdf(shape: SampleShape, sphereRadius: number): ObjectSdf {
  switch (shape) {
    case 'sphere': {
      const r = sampleSphereRadius(sphereRadius);
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r;
    }
    case 'cube': {
      const h = SAMPLE_SHAPE_DIMENSIONS.cube.halfSize;
      return (x, y, z) => {
        const dx = Math.abs(x) - h;
        const dy = Math.abs(y) - h;
        const dz = Math.abs(z) - h;
        const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
        const inside = Math.min(Math.max(dx, dy, dz), 0);
        return outside + inside;
      };
    }
    case 'cylinder': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.cylinder;
      return (x, y, z) => {
        const dRadial = Math.sqrt(x * x + y * y) - radius;
        const dAxial = Math.abs(z) - halfHeight;
        const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
        const inside = Math.min(Math.max(dRadial, dAxial), 0);
        return outside + inside;
      };
    }
    case 'torus': {
      const { majorRadius, tubeRadius } = SAMPLE_SHAPE_DIMENSIONS.torus;
      return (x, y, z) => {
        const qx = Math.sqrt(x * x + y * y) - majorRadius;
        return Math.sqrt(qx * qx + z * z) - tubeRadius;
      };
    }
    case 'capsule': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.capsule;
      return (x, y, z) => {
        const cz = Math.max(-halfHeight, Math.min(halfHeight, z));
        return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - radius;
      };
    }
  }
}
