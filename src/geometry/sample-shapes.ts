// Analytic object SDFs for the built-in sample shapes, in millimetres.
//
// Negative inside, positive outside, exact Euclidean distance outside every
// shape (and exact or a lower bound inside), so |sdf| at a point on or outside
// the surface is its distance to the shape in mm.
//
// This module is the single source of the sample-shape primitives, dimensions
// and generation bounds: the lattice builders, the generation and tile
// workers, sparse tile skipping, and validation all evaluate these functions.
import type { SampleShape } from '../types/project';
import type { Vec3 } from './vec3';

export type ObjectSdf = (x: number, y: number, z: number) => number;

/** Fallback sphere radius used whenever the stored radius is unset or zero. */
export const DEFAULT_SAMPLE_SPHERE_RADIUS = 25;

/** Fixed dimensions of the non-sphere samples. */
export const SAMPLE_SHAPE_DIMENSIONS = {
  cube: { halfSize: 15 },
  cylinder: { radius: 15, halfHeight: 20 },
  torus: { majorRadius: 20, tubeRadius: 8 },
  capsule: { radius: 12, halfHeight: 15 },
} as const;

export function sampleSphereRadius(sphereRadius: number): number {
  return sphereRadius || DEFAULT_SAMPLE_SPHERE_RADIUS;
}

/** Sphere centred at the origin. */
export function sphereSdf(radius: number): ObjectSdf {
  return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - radius;
}

/** Axis-aligned cube centred at the origin. */
export function cubeSdf(halfSize: number): ObjectSdf {
  return (x, y, z) => {
    const dx = Math.abs(x) - halfSize;
    const dy = Math.abs(y) - halfSize;
    const dz = Math.abs(z) - halfSize;
    const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
    const inside = Math.min(Math.max(dx, dy, dz), 0);
    return outside + inside;
  };
}

/** Capped cylinder along z, centred at the origin. */
export function cylinderSdf(radius: number, halfHeight: number): ObjectSdf {
  return (x, y, z) => {
    const dRadial = Math.sqrt(x * x + y * y) - radius;
    const dAxial = Math.abs(z) - halfHeight;
    const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
    const inside = Math.min(Math.max(dRadial, dAxial), 0);
    return outside + inside;
  };
}

/** Torus in the xy plane, centred at the origin. */
export function torusSdf(majorRadius: number, tubeRadius: number): ObjectSdf {
  return (x, y, z) => {
    const qx = Math.sqrt(x * x + y * y) - majorRadius;
    return Math.sqrt(qx * qx + z * z) - tubeRadius;
  };
}

/** Capsule along z: a cylinder body of half-height `halfHeight` with hemispherical caps. */
export function capsuleSdf(radius: number, halfHeight: number): ObjectSdf {
  return (x, y, z) => {
    // Clamp z to the cylinder body, then measure distance to that clamped point.
    const cz = Math.max(-halfHeight, Math.min(halfHeight, z));
    return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - radius;
  };
}

export function sampleShapeObjectSdf(shape: SampleShape, sphereRadius: number): ObjectSdf {
  switch (shape) {
    case 'sphere':
      return sphereSdf(sampleSphereRadius(sphereRadius));
    case 'cube':
      return cubeSdf(SAMPLE_SHAPE_DIMENSIONS.cube.halfSize);
    case 'cylinder': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.cylinder;
      return cylinderSdf(radius, halfHeight);
    }
    case 'torus': {
      const { majorRadius, tubeRadius } = SAMPLE_SHAPE_DIMENSIONS.torus;
      return torusSdf(majorRadius, tubeRadius);
    }
    case 'capsule': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.capsule;
      return capsuleSdf(radius, halfHeight);
    }
  }
}

/** Generation grid bounds: the shape's bounding box grown by `pad` mm on every side. */
export function sampleShapeBounds(
  shape: SampleShape,
  sphereRadius: number,
  pad: number,
): { min: Vec3; max: Vec3 } {
  switch (shape) {
    case 'sphere': {
      const r = sampleSphereRadius(sphereRadius) + pad;
      return { min: [-r, -r, -r], max: [r, r, r] };
    }
    case 'cube': {
      const h = SAMPLE_SHAPE_DIMENSIONS.cube.halfSize + pad;
      return { min: [-h, -h, -h], max: [h, h, h] };
    }
    case 'cylinder': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.cylinder;
      const xy = radius + pad;
      const z = halfHeight + pad;
      return { min: [-xy, -xy, -z], max: [xy, xy, z] };
    }
    case 'torus': {
      const { majorRadius, tubeRadius } = SAMPLE_SHAPE_DIMENSIONS.torus;
      const xy = majorRadius + tubeRadius + pad;
      const z = tubeRadius + pad;
      return { min: [-xy, -xy, -z], max: [xy, xy, z] };
    }
    case 'capsule': {
      const { radius, halfHeight } = SAMPLE_SHAPE_DIMENSIONS.capsule;
      const xy = radius + pad;
      const z = halfHeight + radius + pad;
      return { min: [-xy, -xy, -z], max: [xy, xy, z] };
    }
  }
}
