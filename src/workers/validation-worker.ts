// Runs expensive mesh validation after generation has already returned geometry.
import { MeshBVH } from '../geometry/bvh';
import {
  buildCapsuleLattice,
  buildCombinedSDF,
  buildCubeLattice,
  buildCylinderLattice,
  buildSphereLattice,
  buildSurfaceHexLattice,
  buildTorusLattice,
} from '../geometry/lattice';
import type { SurfaceHexSample } from '../geometry/lattice';
import {
  checkMinThickness,
  checkSphereDeviation,
  checkTopology,
  runValidation,
} from '../geometry/validation';
import { withEscapeHoles } from '../geometry/escape-holes';
import { computeSignedVolume } from '../geometry/mesh-analysis';
import {
  VOLUME_SAMPLES_PER_AXIS,
  computeSurfaceArea,
  sampleOccupiedVolume,
} from '../geometry/metrics';
import type { LatticeMetrics } from '../geometry/metrics';
import type { EscapeHole } from '../geometry/escape-holes';
import type { LatticeParams, SampleShape, ValidationResult } from '../types/project';
import type { Vec3 } from '../geometry/vec3';

type SdfFunction = (x: number, y: number, z: number) => number;

export interface ValidationWorkerMessage {
  type: 'validate';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  params: LatticeParams;
  sphereMode: boolean;
  sphereRadius: number;
  sampleShape: SampleShape | null;
  meshPositions?: Float32Array;
  meshNormals?: Float32Array;
  meshTriCount?: number;
  keepOutTris?: number[];
  keepInTris?: number[];
  escapeHoles?: EscapeHole[];
  /** Set when the requested feature threshold was too small for the grid. */
  thinFilterSkipped?: string;
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
}

export interface ValidationWorkerResponse {
  type: 'progress' | 'result' | 'error';
  message?: string;
  validation?: ValidationResult;
  metrics?: LatticeMetrics;
}

function computeMetrics(
  sdf: SdfFunction,
  bounds: { min: Vec3; max: Vec3 },
  envelopeVolume: number,
  result: { positions: Float32Array; normals: Float32Array; triCount: number }
): LatticeMetrics {
  const latticeVolume = sampleOccupiedVolume(sdf, bounds);
  return {
    envelopeVolume,
    latticeVolume,
    relativeDensity: envelopeVolume > 0 ? latticeVolume / envelopeVolume : 0,
    surfaceArea: computeSurfaceArea(result),
    volumeSamplesPerAxis: VOLUME_SAMPLES_PER_AXIS,
  };
}

function unpackSurfaceSamples(
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

function shapeObjectSdf(shape: SampleShape, sphereRadius: number): {
  objectSdf: SdfFunction;
  latticeSdf: (params: LatticeParams) => SdfFunction;
  sphereRadius: number | null;
  /** Exact solid volume of the primitive, mm^3. */
  envelopeVolume: number;
  /** Sampling box, matching the padding the generation worker uses. */
  boundsFor: (pad: number) => { min: Vec3; max: Vec3 };
} {
  switch (shape) {
    case 'sphere': {
      const r = sphereRadius || 25;
      return {
        objectSdf: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r,
        latticeSdf: (params) => buildSphereLattice(r, params),
        sphereRadius: r,
        envelopeVolume: (4 / 3) * Math.PI * r ** 3,
        boundsFor: (pad) => ({ min: [-(r + pad), -(r + pad), -(r + pad)], max: [r + pad, r + pad, r + pad] }),
      };
    }
    case 'cube': {
      const h = 15;
      const objectSdf = (x: number, y: number, z: number) => {
        const dx = Math.abs(x) - h;
        const dy = Math.abs(y) - h;
        const dz = Math.abs(z) - h;
        const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
        const inside = Math.min(Math.max(dx, dy, dz), 0);
        return outside + inside;
      };
      return {
        objectSdf,
        latticeSdf: (params) => buildCubeLattice(h, params),
        sphereRadius: null,
        envelopeVolume: (2 * h) ** 3,
        boundsFor: (pad) => ({ min: [-(h + pad), -(h + pad), -(h + pad)], max: [h + pad, h + pad, h + pad] }),
      };
    }
    case 'cylinder': {
      const cr = 15;
      const ch = 20;
      const objectSdf = (x: number, y: number, z: number) => {
        const dRadial = Math.sqrt(x * x + y * y) - cr;
        const dAxial = Math.abs(z) - ch;
        const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
        const inside = Math.min(Math.max(dRadial, dAxial), 0);
        return outside + inside;
      };
      return {
        objectSdf,
        latticeSdf: (params) => buildCylinderLattice(cr, ch, params),
        sphereRadius: null,
        envelopeVolume: Math.PI * cr ** 2 * (2 * ch),
        boundsFor: (pad) => ({ min: [-cr - pad, -cr - pad, -ch - pad], max: [cr + pad, cr + pad, ch + pad] }),
      };
    }
    case 'torus': {
      const major = 20;
      const tube = 8;
      const objectSdf = (x: number, y: number, z: number) => {
        const qx = Math.sqrt(x * x + y * y) - major;
        return Math.sqrt(qx * qx + z * z) - tube;
      };
      return {
        objectSdf,
        latticeSdf: (params) => buildTorusLattice(major, tube, params),
        sphereRadius: null,
        envelopeVolume: 2 * Math.PI ** 2 * major * tube ** 2,
        boundsFor: (pad) => {
          const xy = major + tube + pad;
          return { min: [-xy, -xy, -(tube + pad)], max: [xy, xy, tube + pad] };
        },
      };
    }
    case 'capsule': {
      const r = 12;
      const halfHeight = 15;
      const objectSdf = (x: number, y: number, z: number) => {
        const cz = Math.max(-halfHeight, Math.min(halfHeight, z));
        return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - r;
      };
      return {
        objectSdf,
        latticeSdf: (params) => buildCapsuleLattice(r, halfHeight, params),
        sphereRadius: null,
        envelopeVolume: Math.PI * r ** 2 * (2 * halfHeight) + (4 / 3) * Math.PI * r ** 3,
        boundsFor: (pad) => {
          const ext = halfHeight + r + pad;
          return { min: [-(r + pad), -(r + pad), -ext], max: [r + pad, r + pad, ext] };
        },
      };
    }
  }
}

function runProceduralValidation(
  msg: ValidationWorkerMessage,
  sdf: SdfFunction,
): ValidationResult {
  const result = { positions: msg.positions, normals: msg.normals, triCount: msg.triCount };
  const shape = msg.sampleShape || (msg.sphereMode ? 'sphere' : null);
  const outerDeviation = shape === 'sphere'
    ? checkSphereDeviation(result, msg.sphereRadius || 25, msg.params.toleranceMm)
    : { passed: true, maxDeviation: 0 };
  const minThickness = checkMinThickness(sdf, result, msg.params.minFeatureSize);
  const { manifold, disconnected } = checkTopology(result);
  const warnings: string[] = [];

  if (!msg.params.escapeHoles && msg.params.variant === 'shell_core') {
    warnings.push('Escape holes disabled - trapped powder/resin likely');
  }
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

self.onmessage = (event: MessageEvent<ValidationWorkerMessage>) => {
  const msg = event.data;
  if (msg.type !== 'validate') return;

  try {
    postMessage({ type: 'progress', message: 'Validation running...' } as ValidationWorkerResponse);

    const result = { positions: msg.positions, normals: msg.normals, triCount: msg.triCount };
    const surfaceSamples = unpackSurfaceSamples(
      msg.surfaceSamplePositions,
      msg.surfaceSampleNormals,
      msg.surfaceSampleHoleScales
    );
    const isSurfacePolygon = msg.params.variant === 'implicit_conformal'
      && (msg.params.latticeType === 'hexagon' || msg.params.latticeType === 'triangle');
    const shape = msg.sampleShape || (msg.sphereMode ? 'sphere' : null);

    let validation: ValidationResult;
    let metrics: LatticeMetrics;
    if (shape) {
      const { objectSdf, latticeSdf, envelopeVolume, boundsFor } = shapeObjectSdf(shape, msg.sphereRadius);
      const baseSdf = isSurfacePolygon && surfaceSamples.length > 0
        ? buildSurfaceHexLattice(objectSdf, msg.params, surfaceSamples)
        : latticeSdf(msg.params);
      // Same wrapping order as generation, so thickness is measured against
      // the geometry that was actually produced.
      // Feature removal happens on the generation grid and cannot be replayed
      // against a point-sampled SDF, so validation measures the unfiltered
      // field. Opening only deletes material that was already too thin, so the
      // reported thickness is a lower bound on what was actually produced.
      const finalSdf = withEscapeHoles(baseSdf, msg.escapeHoles ?? []);
      validation = runProceduralValidation(msg, finalSdf);
      metrics = computeMetrics(finalSdf, boundsFor(msg.params.cellSize * 0.5), envelopeVolume, result);
    } else {
      const bvh = new MeshBVH(msg.meshPositions!, msg.meshNormals!, msg.meshTriCount!);
      const objectSdf = (x: number, y: number, z: number) => bvh.signedDistance([x, y, z] as Vec3);
      const baseSdf = isSurfacePolygon && surfaceSamples.length > 0
        ? buildSurfaceHexLattice(objectSdf, msg.params, surfaceSamples)
        : buildCombinedSDF({
            bvh,
            params: msg.params,
            keepOutTris: new Set(msg.keepOutTris || []),
            keepInTris: new Set(msg.keepInTris || []),
          });
      const finalSdf = withEscapeHoles(baseSdf, msg.escapeHoles ?? []);
      validation = runValidation(result, finalSdf, msg.params, bvh, null);
      if (msg.thinFilterSkipped) validation.warnings.push(msg.thinFilterSkipped);

      // The imported mesh is closed by the time it reaches here — the import
      // guards flip inverted winding — so its signed volume is exact and there
      // is no need to estimate the envelope by sampling.
      const source = {
        positions: msg.meshPositions!,
        normals: msg.meshNormals!,
        triCount: msg.meshTriCount!,
      };
      const pad = msg.params.cellSize * 0.5;
      const mn: Vec3 = [Infinity, Infinity, Infinity];
      const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < source.positions.length; i += 3) {
        for (let d = 0; d < 3; d++) {
          if (source.positions[i + d] < mn[d]) mn[d] = source.positions[i + d];
          if (source.positions[i + d] > mx[d]) mx[d] = source.positions[i + d];
        }
      }
      metrics = computeMetrics(
        finalSdf,
        { min: [mn[0] - pad, mn[1] - pad, mn[2] - pad], max: [mx[0] + pad, mx[1] + pad, mx[2] + pad] },
        Math.abs(computeSignedVolume(source)),
        result
      );
    }

    postMessage({ type: 'result', validation, metrics } as ValidationWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown validation error';
    postMessage({ type: 'error', message } as ValidationWorkerResponse);
  }
};
