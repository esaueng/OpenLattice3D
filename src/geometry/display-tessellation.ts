export interface CurveTessellationOptions {
  /** Maximum screen-space sagitta between an analytic arc and one display chord. */
  maxChordalDeflectionPx: number;
  /** Maximum angle spanned by one display chord. */
  maxAngularDeflectionRad: number;
  minSegments: number;
  maxSegments: number;
  /** Quantizes segment counts so camera motion does not rebuild the mesh every frame. */
  segmentStep: number;
}

export const DEFAULT_CURVE_TESSELLATION: Readonly<CurveTessellationOptions> = {
  maxChordalDeflectionPx: 0.35,
  maxAngularDeflectionRad: 5 * Math.PI / 180,
  minSegments: 32,
  maxSegments: 256,
  segmentStep: 8,
};

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizedOptions(options: CurveTessellationOptions): CurveTessellationOptions {
  const minSegments = Math.max(3, Math.ceil(finitePositive(options.minSegments, 3)));
  const maxSegments = Math.max(minSegments, Math.ceil(finitePositive(options.maxSegments, minSegments)));
  return {
    maxChordalDeflectionPx: finitePositive(options.maxChordalDeflectionPx, 0.35),
    maxAngularDeflectionRad: Math.min(
      Math.PI * 2,
      finitePositive(options.maxAngularDeflectionRad, 5 * Math.PI / 180),
    ),
    minSegments,
    maxSegments,
    segmentStep: Math.max(1, Math.ceil(finitePositive(options.segmentStep, 1))),
  };
}

/** Screen-space sagitta of one chord in a regular polygonal circle. */
export function chordalDeflection(projectedRadiusPx: number, segments: number): number {
  if (!Number.isFinite(projectedRadiusPx) || projectedRadiusPx <= 0 || segments < 3) return 0;
  return projectedRadiusPx * (1 - Math.cos(Math.PI / segments));
}

/**
 * Choose a bounded LOD for an analytic circle. The angular limit protects small
 * or distant curves while the pixel sagitta makes close-up views refine.
 */
export function radialSegmentsForProjectedRadius(
  projectedRadiusPx: number,
  options: CurveTessellationOptions = DEFAULT_CURVE_TESSELLATION,
): number {
  const normalized = normalizedOptions(options);
  const angularSegments = Math.ceil((Math.PI * 2) / normalized.maxAngularDeflectionRad);

  let chordalSegments = 3;
  if (Number.isFinite(projectedRadiusPx) && projectedRadiusPx > normalized.maxChordalDeflectionPx) {
    const cosine = Math.max(
      -1,
      Math.min(1, 1 - normalized.maxChordalDeflectionPx / projectedRadiusPx),
    );
    chordalSegments = Math.ceil(Math.PI / Math.acos(cosine));
  }

  const required = Math.max(normalized.minSegments, angularSegments, chordalSegments);
  const quantized = Math.ceil(required / normalized.segmentStep) * normalized.segmentStep;
  return Math.min(normalized.maxSegments, Math.max(normalized.minSegments, quantized));
}

export function perspectiveProjectedRadiusPx(
  radiusWorld: number,
  cameraDistanceWorld: number,
  verticalFovRad: number,
  viewportHeightPx: number,
): number {
  if (
    !Number.isFinite(radiusWorld) || radiusWorld <= 0
    || !Number.isFinite(cameraDistanceWorld) || cameraDistanceWorld <= 0
    || !Number.isFinite(verticalFovRad) || verticalFovRad <= 0 || verticalFovRad >= Math.PI
    || !Number.isFinite(viewportHeightPx) || viewportHeightPx <= 0
  ) {
    return 0;
  }
  return radiusWorld * viewportHeightPx
    / (2 * cameraDistanceWorld * Math.tan(verticalFovRad / 2));
}

export interface CylinderDisplayMesh {
  positions: Float32Array;
  /** Smooth radial side normals and flat cap normals, one normal per vertex. */
  normals: Float32Array;
  triCount: number;
}

function appendVertex(
  positions: number[],
  normals: number[],
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
) {
  positions.push(position[0], position[1], position[2]);
  normals.push(normal[0], normal[1], normal[2]);
}

/**
 * Tessellate an analytic cylinder for display only. Triangle order intentionally
 * matches generateCylinderMesh: two side faces, top, then bottom per segment.
 */
export function generateCylinderDisplayMesh(
  radius: number,
  height: number,
  segments: number,
): CylinderDisplayMesh {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Cylinder radius must be positive');
  if (!Number.isFinite(height) || height <= 0) throw new Error('Cylinder height must be positive');
  if (!Number.isInteger(segments) || segments < 3) throw new Error('Cylinder segments must be an integer >= 3');

  const positions: number[] = [];
  const normals: number[] = [];
  const halfHeight = height / 2;

  for (let index = 0; index < segments; index++) {
    const angle0 = (Math.PI * 2 * index) / segments;
    const angle1 = (Math.PI * 2 * (index + 1)) / segments;
    const cos0 = Math.cos(angle0);
    const sin0 = Math.sin(angle0);
    const cos1 = Math.cos(angle1);
    const sin1 = Math.sin(angle1);
    const bottom0: [number, number, number] = [radius * cos0, radius * sin0, -halfHeight];
    const bottom1: [number, number, number] = [radius * cos1, radius * sin1, -halfHeight];
    const top0: [number, number, number] = [radius * cos0, radius * sin0, halfHeight];
    const top1: [number, number, number] = [radius * cos1, radius * sin1, halfHeight];
    const normal0: [number, number, number] = [cos0, sin0, 0];
    const normal1: [number, number, number] = [cos1, sin1, 0];

    appendVertex(positions, normals, bottom0, normal0);
    appendVertex(positions, normals, bottom1, normal1);
    appendVertex(positions, normals, top1, normal1);
    appendVertex(positions, normals, bottom0, normal0);
    appendVertex(positions, normals, top1, normal1);
    appendVertex(positions, normals, top0, normal0);

    appendVertex(positions, normals, [0, 0, halfHeight], [0, 0, 1]);
    appendVertex(positions, normals, top0, [0, 0, 1]);
    appendVertex(positions, normals, top1, [0, 0, 1]);

    appendVertex(positions, normals, [0, 0, -halfHeight], [0, 0, -1]);
    appendVertex(positions, normals, bottom1, [0, 0, -1]);
    appendVertex(positions, normals, bottom0, [0, 0, -1]);
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    triCount: segments * 4,
  };
}

/** Samples the exact circular CAD-style edge on the same grid as the surface. */
export function sampleCircularEdge(radius: number, z: number, segments: number): Float32Array {
  if (!Number.isFinite(radius) || radius <= 0) throw new Error('Circle radius must be positive');
  if (!Number.isFinite(z)) throw new Error('Circle z must be finite');
  if (!Number.isInteger(segments) || segments < 3) throw new Error('Circle segments must be an integer >= 3');

  const positions = new Float32Array(segments * 3);
  for (let index = 0; index < segments; index++) {
    const angle = (Math.PI * 2 * index) / segments;
    positions[index * 3] = radius * Math.cos(angle);
    positions[index * 3 + 1] = radius * Math.sin(angle);
    positions[index * 3 + 2] = z;
  }
  return positions;
}
