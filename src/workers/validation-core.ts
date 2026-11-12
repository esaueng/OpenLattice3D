// Validation pipeline run by validation-worker.ts, kept free of worker globals
// so it can be unit-tested in Node.
import { MeshBVH } from '../geometry/bvh';
import {
  buildCombinedSDF,
  buildSampleShapeLattice,
  buildSurfaceHexLattice,
} from '../geometry/lattice';
import type { SurfaceHexSample } from '../geometry/lattice';
import { sampleShapeObjectSdf, type ObjectSdf } from '../geometry/sample-shapes';
import { checkAnalyticOuterDeviation } from '../geometry/shape-deviation';
import {
  checkMinThickness,
  checkTopology,
  OUTER_DEVIATION_UNMEASURED_WARNING,
  runValidation,
  topologyWarnings,
} from '../geometry/validation';
import type { LatticeParams, SampleShape, ValidationResult } from '../types/project';
import type { Vec3 } from '../geometry/vec3';

type SdfFunction = (x: number, y: number, z: number) => number;

export interface ValidationWorkerMessage {
  type: 'validate';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  params: LatticeParams;
  generationSeed: number;
  sphereMode: boolean;
  sphereRadius: number;
  sampleShape: SampleShape | null;
  meshPositions?: Float32Array;
  meshNormals?: Float32Array;
  meshTriCount?: number;
  keepOutTris?: number[];
  keepInTris?: number[];
  /** Set when the requested feature width is smaller than the sample grid. */
  thinFilterSkipped?: string;
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
}

export interface ValidationWorkerResponse {
  /** 0..1 thickness-sampling progress; absent on message-only progress posts. */
  progress?: number;
  type: 'progress' | 'result' | 'error';
  message?: string;
  validation?: ValidationResult;
}

export function unpackSurfaceSamples(
  positions?: Float32Array,
  normals?: Float32Array,
  holeScales?: Float32Array
): SurfaceHexSample[] {
  if (!positions || !normals) return [];
  const samples: SurfaceHexSample[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    samples.push({
      pos: [positions[i], positions[i + 1], positions[i + 2]],
      normal: [normals[i], normals[i + 1], normals[i + 2]],
      holeScale: holeScales ? holeScales[i / 3] : undefined,
    });
  }
  return samples;
}

/** Object and lattice fields for a built-in sample shape, matching the generation worker. */
export function sampleShapeFields(shape: SampleShape, sphereRadius: number, generationSeed: number): {
  objectSdf: ObjectSdf;
  latticeSdf: (params: LatticeParams) => SdfFunction;
} {
  return {
    objectSdf: sampleShapeObjectSdf(shape, sphereRadius),
    latticeSdf: (params) => buildSampleShapeLattice(shape, sphereRadius, params, generationSeed),
  };
}

export function runProceduralValidation(
  msg: ValidationWorkerMessage,
  objectSdf: ObjectSdf,
  sdf: SdfFunction,
  onProgress?: (fraction: number) => void,
): ValidationResult {
  const result = { positions: msg.positions, normals: msg.normals, triCount: msg.triCount };
  // Every sample shape has an analytic envelope, so deviation is measured for
  // all of them; an unmeasurable result is reported as such, never as 0 mm.
  const outerDeviation = checkAnalyticOuterDeviation(result, objectSdf, msg.params.toleranceMm);
  const minThickness = checkMinThickness(sdf, result, msg.params.minFeatureSize, 200, onProgress);
  const { manifold, disconnected } = checkTopology(result);
  const warnings: string[] = [];
  if (outerDeviation.sampled === 0) warnings.push(OUTER_DEVIATION_UNMEASURED_WARNING);
  if (minThickness.sampled === 0) warnings.push('Minimum thickness could not be measured');

  warnings.push(...topologyWarnings(disconnected, msg.params));
  if (msg.params.processPreset === 'FDM' && msg.params.variant === 'implicit_conformal') {
    warnings.push('FDM with open lattice exterior can be difficult to print');
  }
  if (msg.thinFilterSkipped) warnings.push(msg.thinFilterSkipped);

  return {
    passed: outerDeviation.passed && minThickness.passed && manifold.passed && disconnected.passed,
    outerDeviation: { ...outerDeviation, tolerance: msg.params.toleranceMm },
    minThickness: { ...minThickness, required: msg.params.minFeatureSize },
    manifold,
    disconnected,
    warnings,
  };
}

/** Full validation for one generated result, as posted to the validation worker. */
export function validateGeneratedResult(
  msg: ValidationWorkerMessage,
  onProgress?: (fraction: number) => void,
): ValidationResult {
  const result = { positions: msg.positions, normals: msg.normals, triCount: msg.triCount };
  const surfaceSamples = unpackSurfaceSamples(
    msg.surfaceSamplePositions,
    msg.surfaceSampleNormals,
    msg.surfaceSampleHoleScales
  );
  const isSurfacePolygon = msg.params.variant === 'implicit_conformal'
    && (msg.params.latticeType === 'hexagon' || msg.params.latticeType === 'triangle');
  const shape = msg.sampleShape || (msg.sphereMode ? 'sphere' : null);

  if (shape) {
    const { objectSdf, latticeSdf } = sampleShapeFields(shape, msg.sphereRadius, msg.generationSeed);
    const baseSdf = isSurfacePolygon && surfaceSamples.length > 0
      ? buildSurfaceHexLattice(objectSdf, msg.params, surfaceSamples)
      : latticeSdf(msg.params);
    // Opening is applied to the sampled generation field. Replaying the old
    // pointwise erosion here would validate geometry that was not produced.
    return runProceduralValidation(msg, objectSdf, baseSdf, onProgress);
  }

  // An imported model's lattice field is built from its mesh, so without that
  // mesh there is nothing to validate at all: reject the request. When the mesh
  // is present it is always the deviation reference, and an unmeasurable
  // deviation is reported exactly like the sample-shape path (sampled 0,
  // failing, with a warning) by runValidation.
  if (!msg.meshPositions || !msg.meshNormals || msg.meshTriCount === undefined) {
    throw new Error('Validation needs the original mesh or a sample shape');
  }
  const bvh = new MeshBVH(msg.meshPositions, msg.meshNormals, msg.meshTriCount);
  const objectSdf = (x: number, y: number, z: number) => bvh.signedDistance([x, y, z] as Vec3);
  const baseSdf = isSurfacePolygon && surfaceSamples.length > 0
    ? buildSurfaceHexLattice(objectSdf, msg.params, surfaceSamples)
    : buildCombinedSDF({
      bvh,
      params: msg.params,
      generationSeed: msg.generationSeed,
      keepOutTris: new Set(msg.keepOutTris || []),
      keepInTris: new Set(msg.keepInTris || []),
    });
  const validation = runValidation(
    result,
    baseSdf,
    msg.params,
    bvh,
    null
  );
  if (msg.thinFilterSkipped) validation.warnings.push(msg.thinFilterSkipped);
  return validation;
}
