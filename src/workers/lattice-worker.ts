// Web Worker for lattice generation (SDF sampling + marching cubes)
// This runs heavy computation off the main thread.

import { marchingCubes } from '../geometry/marching-cubes';
import { buildCombinedSDF, buildSphereLattice, buildCubeLattice, buildCylinderLattice, buildTorusLattice, buildCapsuleLattice } from '../geometry/lattice';
import { MeshBVH } from '../geometry/bvh';
import { runValidation, checkSphereDeviation, checkMinThickness, checkManifold, checkDisconnected } from '../geometry/validation';
import type { LatticeParams, ValidationResult, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';

export interface WorkerMessage {
  type: 'generate' | 'validate' | 'cancel';
  // For generate:
  meshPositions?: Float32Array;
  meshNormals?: Float32Array;
  meshTriCount?: number;
  params?: LatticeParams;
  sphereMode?: boolean;
  sphereRadius?: number;
  sampleShape?: SampleShape | null;
  resolution?: number;
  keepOutTris?: number[];
}

export interface WorkerResponse {
  type: 'progress' | 'result' | 'validation' | 'error';
  progress?: number;
  message?: string;
  positions?: Float32Array;
  normals?: Float32Array;
  triCount?: number;
  validation?: ValidationResult;
}

let cancelled = false;

const LATTICE_COMPLEXITY: Record<LatticeParams['latticeType'], number> = {
  gyroid: 1.0,
  schwarzP: 1.0,
  schwarzD: 1.15,
  neovius: 1.2,
  iwp: 1.25,
  bcc: 1.1,
  octet: 1.2,
  diamond: 1.25,
  hexagon: 1.15,
  triangle: 1.1,
  voronoi: 1.7,
  spinodal: 2.0,
};

type GenerationEstimate = {
  preSeconds: number;
  marchSeconds: number;
  validationSeconds: number;
  totalSeconds: number;
};

function estimateGenerationTimings(
  params: LatticeParams,
  resolution: number,
  hasCustomMesh: boolean
): GenerationEstimate {
  const samples = Math.pow(resolution + 1, 3);
  const cubes = Math.pow(resolution, 3);
  const latticeFactor = LATTICE_COMPLEXITY[params.latticeType] ?? 1.0;
  const gradientFactor = params.gradientEnabled ? 1.1 : 1.0;

  const sdfCost = 2.2e-6 * latticeFactor * gradientFactor;
  const cubeCost = 0.9e-6;
  const preSeconds = samples * sdfCost;
  const marchSeconds = cubes * cubeCost;

  const validationFactor = hasCustomMesh ? 0.55 : 0.35;
  const validationSeconds = (preSeconds + marchSeconds) * validationFactor;
  const totalSeconds = Math.max(0.5, preSeconds + marchSeconds + validationSeconds);
  return {
    preSeconds,
    marchSeconds,
    validationSeconds,
    totalSeconds,
  };
}

function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  const hours = seconds / 3600;
  return `${hours.toFixed(1)}h`;
}

self.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  cancelled = false;

  if (msg.type === 'generate') {
    try {
      const generationStart = performance.now();
      const params = msg.params!;
      const resolution = msg.resolution || 64;
      let sdf: (x: number, y: number, z: number) => number;
      let bounds: { min: Vec3; max: Vec3 };
      let sphereRadius: number | null = null;
      let bvh: MeshBVH | null = null;

      const shape = msg.sampleShape || (msg.sphereMode ? 'sphere' : null);

      if (shape) {
        const pad = params.cellSize * 0.5;

        switch (shape) {
          case 'sphere': {
            sphereRadius = msg.sphereRadius || 25;
            const R = sphereRadius;
            bounds = { min: [-(R+pad), -(R+pad), -(R+pad)], max: [R+pad, R+pad, R+pad] };
            sdf = buildSphereLattice(R, params);
            break;
          }
          case 'cube': {
            const h = 15; // 30mm cube → halfSize 15
            bounds = { min: [-(h+pad), -(h+pad), -(h+pad)], max: [h+pad, h+pad, h+pad] };
            sdf = buildCubeLattice(h, params);
            break;
          }
          case 'cylinder': {
            const cr = 15, ch = 20; // R=15, H=40 → halfH=20
            bounds = { min: [-cr-pad, -ch-pad, -cr-pad], max: [cr+pad, ch+pad, cr+pad] };
            sdf = buildCylinderLattice(cr, ch, params);
            break;
          }
          case 'torus': {
            const mR = 20, tR = 8; // major=20, tube=8
            const xy = mR + tR + pad;
            bounds = { min: [-xy, -(tR+pad), -xy], max: [xy, tR+pad, xy] };
            sdf = buildTorusLattice(mR, tR, params);
            break;
          }
          case 'capsule': {
            const capR = 12, capHH = 15; // R=12, H=30 → halfH=15, total extent = 15+12
            const capExt = capHH + capR + pad;
            bounds = { min: [-(capR+pad), -capExt, -(capR+pad)], max: [capR+pad, capExt, capR+pad] };
            sdf = buildCapsuleLattice(capR, capHH, params);
            break;
          }
        }
        postMessage({ type: 'progress', progress: 0.05, message: `${shape} SDF ready` } as WorkerResponse);
      } else {
        // Build BVH from mesh
        postMessage({ type: 'progress', progress: 0.02, message: 'Building BVH...' } as WorkerResponse);
        bvh = new MeshBVH(msg.meshPositions!, msg.meshNormals!, msg.meshTriCount!);

        // Compute bounds
        const positions = msg.meshPositions!;
        const mn: Vec3 = [Infinity, Infinity, Infinity];
        const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < positions.length; i += 3) {
          for (let d = 0; d < 3; d++) {
            if (positions[i + d] < mn[d]) mn[d] = positions[i + d];
            if (positions[i + d] > mx[d]) mx[d] = positions[i + d];
          }
        }
        const pad = params.cellSize * 0.5;
        bounds = {
          min: [mn[0] - pad, mn[1] - pad, mn[2] - pad],
          max: [mx[0] + pad, mx[1] + pad, mx[2] + pad],
        };

        postMessage({ type: 'progress', progress: 0.1, message: 'BVH built, computing SDF...' } as WorkerResponse);

        const keepOutSet = new Set(msg.keepOutTris || []);
        sdf = buildCombinedSDF({ bvh, params, keepOutTris: keepOutSet });
      }

      const initialEstimate = estimateGenerationTimings(params, resolution, !shape);
      let smoothedMarchSeconds = initialEstimate.marchSeconds;
      let estimateLabel = formatDuration(initialEstimate.totalSeconds);
      postMessage({
        type: 'progress',
        progress: 0.12,
        message: `Estimated generation time: ~${estimateLabel}`
      } as WorkerResponse);

      // Run marching cubes
      const marchingStart = performance.now();
      const preSecondsActual = (marchingStart - generationStart) / 1000;
      const result = marchingCubes(sdf, bounds, resolution, 0, (frac) => {
        if (cancelled) throw new Error('Cancelled');
        const overallProgress = 0.1 + frac * 0.7;
        const elapsedSeconds = (performance.now() - generationStart) / 1000;
        const marchElapsedSeconds = Math.max(0, elapsedSeconds - preSecondsActual);
        if (frac > 0.02) {
          const dynamicMarchTotal = marchElapsedSeconds / frac;
          smoothedMarchSeconds = smoothedMarchSeconds * 0.7 + dynamicMarchTotal * 0.3;
        }
        const remainingSeconds = Math.max(
          0,
          preSecondsActual + smoothedMarchSeconds + initialEstimate.validationSeconds - elapsedSeconds
        );
        estimateLabel = formatDuration(remainingSeconds);
        postMessage({
          type: 'progress',
          progress: overallProgress,
          message: `Marching cubes: ${Math.round(frac * 100)}% (~${estimateLabel} remaining)`
        } as WorkerResponse);
      });

      const remainingValidation = Math.max(0, initialEstimate.validationSeconds);
      postMessage({
        type: 'progress',
        progress: 0.85,
        message: `Running validation... (~${formatDuration(remainingValidation)} remaining)`
      } as WorkerResponse);

      // Run validation
      let validation: ValidationResult;
      if (shape) {
        // Procedural shape: use sphere deviation only for sphere, skip for others
        const outerDeviation = (shape === 'sphere' && sphereRadius !== null)
          ? checkSphereDeviation(result, sphereRadius, params.toleranceMm)
          : { passed: true, maxDeviation: 0 };
        const minThickness = checkMinThickness(sdf, result, params.minFeatureSize, 200);
        const manifold = checkManifold(result);
        const disconnected = checkDisconnected(result);
        const warnings: string[] = [];
        if (!params.escapeHoles && params.variant === 'shell_core') {
          warnings.push('Escape holes disabled - trapped powder/resin likely');
        }
        if (params.processPreset === 'FDM' && params.variant === 'implicit_conformal') {
          warnings.push('FDM with open lattice exterior can be difficult to print');
        }
        validation = {
          passed: outerDeviation.passed && minThickness.passed && manifold.passed && disconnected.passed,
          outerDeviation: { ...outerDeviation, tolerance: params.toleranceMm },
          minThickness: { ...minThickness, required: params.minFeatureSize },
          manifold,
          disconnected,
          warnings,
        };
      } else {
        validation = runValidation(result, sdf, params, bvh, null);
      }

      postMessage({ type: 'progress', progress: 0.95, message: 'Done!' } as WorkerResponse);

      // Send result
      postMessage(
        {
          type: 'result',
          positions: result.positions,
          normals: result.normals,
          triCount: result.triCount,
          validation,
        } as WorkerResponse,
        // Transfer buffers for performance
        // @ts-expect-error transfer list
        [result.positions.buffer, result.normals.buffer]
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      if (message === 'Cancelled') {
        postMessage({ type: 'progress', progress: 0, message: 'Cancelled' } as WorkerResponse);
      } else {
        postMessage({ type: 'error', message } as WorkerResponse);
      }
    }
  }
};
