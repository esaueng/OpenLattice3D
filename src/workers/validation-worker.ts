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
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
}

export interface ValidationWorkerResponse {
  type: 'progress' | 'result' | 'error';
  message?: string;
  validation?: ValidationResult;
}

function withThinSectionFilter(sdf: SdfFunction, filter: number): SdfFunction {
  if (filter <= 0) return sdf;
  return (x, y, z) => sdf(x, y, z) + filter;
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
} {
  switch (shape) {
    case 'sphere': {
      const r = sphereRadius || 25;
      return {
        objectSdf: (x, y, z) => Math.sqrt(x * x + y * y + z * z) - r,
        latticeSdf: (params) => buildSphereLattice(r, params),
        sphereRadius: r,
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
      return { objectSdf, latticeSdf: (params) => buildCubeLattice(h, params), sphereRadius: null };
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
      return { objectSdf, latticeSdf: (params) => buildCylinderLattice(cr, ch, params), sphereRadius: null };
    }
    case 'torus': {
      const major = 20;
      const tube = 8;
      const objectSdf = (x: number, y: number, z: number) => {
        const qx = Math.sqrt(x * x + y * y) - major;
        return Math.sqrt(qx * qx + z * z) - tube;
      };
      return { objectSdf, latticeSdf: (params) => buildTorusLattice(major, tube, params), sphereRadius: null };
    }
    case 'capsule': {
      const r = 12;
      const halfHeight = 15;
      const objectSdf = (x: number, y: number, z: number) => {
        const cz = Math.max(-halfHeight, Math.min(halfHeight, z));
        return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - r;
      };
      return { objectSdf, latticeSdf: (params) => buildCapsuleLattice(r, halfHeight, params), sphereRadius: null };
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
  const minThickness = checkMinThickness(sdf, result, msg.params.minFeatureSize, 200);
  const { manifold, disconnected } = checkTopology(result);
  const warnings: string[] = [];

  if (!msg.params.escapeHoles && msg.params.variant === 'shell_core') {
    warnings.push('Escape holes disabled - trapped powder/resin likely');
  }
  if (msg.params.processPreset === 'FDM' && msg.params.variant === 'implicit_conformal') {
    warnings.push('FDM with open lattice exterior can be difficult to print');
  }

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
    if (shape) {
      const { objectSdf, latticeSdf } = shapeObjectSdf(shape, msg.sphereRadius);
      const baseSdf = isSurfacePolygon && surfaceSamples.length > 0
        ? buildSurfaceHexLattice(objectSdf, msg.params, surfaceSamples)
        : latticeSdf(msg.params);
      // Same wrapping order as generation, so thickness is measured against
      // the geometry that was actually produced.
      validation = runProceduralValidation(msg, withEscapeHoles(
        withThinSectionFilter(baseSdf, msg.params.thinSectionFilter),
        msg.escapeHoles ?? []
      ));
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
      validation = runValidation(
        result,
        withEscapeHoles(
          withThinSectionFilter(baseSdf, msg.params.thinSectionFilter),
          msg.escapeHoles ?? []
        ),
        msg.params,
        bvh,
        null
      );
    }

    postMessage({ type: 'result', validation } as ValidationWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown validation error';
    postMessage({ type: 'error', message } as ValidationWorkerResponse);
  }
};
