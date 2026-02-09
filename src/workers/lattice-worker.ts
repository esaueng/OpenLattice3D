// Web Worker for lattice generation (SDF sampling + marching cubes)
// This runs heavy computation off the main thread.

import { marchingCubes } from '../geometry/marching-cubes';
import { buildCombinedSDF, buildSurfaceHexLattice, buildSphereLattice, buildCubeLattice, buildCylinderLattice, buildTorusLattice, buildCapsuleLattice } from '../geometry/lattice';
import { MeshBVH } from '../geometry/bvh';
import { runValidation, checkSphereDeviation, checkMinThickness, checkManifold, checkDisconnected } from '../geometry/validation';
import type { LatticeParams, ValidationResult, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import { add, sub, dot, cross, length, scale, normalize } from '../geometry/vec3';
import type { SurfaceHexSample } from '../geometry/lattice';

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

type SurfaceSamplerTarget = {
  samples: SurfaceHexSample[];
  project: (p: Vec3) => { pos: Vec3; normal: Vec3 };
};

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  return 0.5 * length(cross(sub(b, a), sub(c, a)));
}

function pickTriangle(cumulativeAreas: Float32Array, totalArea: number): number {
  const r = Math.random() * totalArea;
  let lo = 0;
  let hi = cumulativeAreas.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (r <= cumulativeAreas[mid]) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function sampleTriangle(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const r1 = Math.random();
  const r2 = Math.random();
  const sqrtR1 = Math.sqrt(r1);
  const u = 1 - sqrtR1;
  const v = sqrtR1 * (1 - r2);
  const w = sqrtR1 * r2;
  return [
    a[0] * u + b[0] * v + c[0] * w,
    a[1] * u + b[1] * v + c[1] * w,
    a[2] * u + b[2] * v + c[2] * w,
  ];
}

function sampleSurfacePointsFromMesh(
  positions: Float32Array,
  normals: Float32Array,
  triCount: number,
  count: number,
  keepOutTris: Set<number>
): SurfaceHexSample[] {
  const areas = new Float32Array(triCount);
  let totalArea = 0;
  for (let i = 0; i < triCount; i++) {
    if (keepOutTris.has(i)) continue;
    const o = i * 9;
    const a: Vec3 = [positions[o], positions[o + 1], positions[o + 2]];
    const b: Vec3 = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const c: Vec3 = [positions[o + 6], positions[o + 7], positions[o + 8]];
    totalArea += triangleArea(a, b, c);
    areas[i] = totalArea;
  }
  if (totalArea <= 1e-6) return [];

  const samples: SurfaceHexSample[] = [];
  for (let i = 0; i < count; i++) {
    const triIndex = pickTriangle(areas, totalArea);
    const o = triIndex * 9;
    const a: Vec3 = [positions[o], positions[o + 1], positions[o + 2]];
    const b: Vec3 = [positions[o + 3], positions[o + 4], positions[o + 5]];
    const c: Vec3 = [positions[o + 6], positions[o + 7], positions[o + 8]];
    const pos = sampleTriangle(a, b, c);
    const ni = triIndex * 3;
    const normal = normalize([normals[ni], normals[ni + 1], normals[ni + 2]]);
    samples.push({ pos, normal });
  }
  return samples;
}

function estimateNormal(
  sdf: (x: number, y: number, z: number) => number,
  p: Vec3,
  eps: number
): Vec3 {
  const dx = sdf(p[0] + eps, p[1], p[2]) - sdf(p[0] - eps, p[1], p[2]);
  const dy = sdf(p[0], p[1] + eps, p[2]) - sdf(p[0], p[1] - eps, p[2]);
  const dz = sdf(p[0], p[1], p[2] + eps) - sdf(p[0], p[1], p[2] - eps);
  return normalize([dx, dy, dz]);
}

function projectToSurfaceSdf(
  sdf: (x: number, y: number, z: number) => number,
  p: Vec3,
  cellSize: number
): { pos: Vec3; normal: Vec3 } {
  const eps = Math.max(0.05, cellSize * 0.02);
  const d = sdf(p[0], p[1], p[2]);
  const n = estimateNormal(sdf, p, eps);
  const projected = sub(p, scale(n, d));
  const n2 = estimateNormal(sdf, projected, eps);
  return { pos: projected, normal: n2 };
}

function sampleSurfacePointsForShape(
  shape: SampleShape,
  count: number,
  params: { radius?: number; halfSize?: number; cylRadius?: number; cylHalfHeight?: number; torusMajor?: number; torusTube?: number; capRadius?: number; capHalfHeight?: number }
): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  if (shape === 'sphere') {
    const r = params.radius ?? 25;
    for (let i = 0; i < count; i++) {
      const u = Math.random();
      const v = Math.random();
      const theta = 2 * Math.PI * u;
      const phi = Math.acos(2 * v - 1);
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = r * Math.cos(phi);
      const normal = normalize([x, y, z]);
      samples.push({ pos: [x, y, z], normal });
    }
    return samples;
  }
  if (shape === 'cube') {
    const h = params.halfSize ?? 15;
    const faceArea = 4 * h * h;
    const totalArea = faceArea * 6;
    for (let i = 0; i < count; i++) {
      const r = Math.random() * totalArea;
      const face = Math.floor(r / faceArea);
      const u = (Math.random() * 2 - 1) * h;
      const v = (Math.random() * 2 - 1) * h;
      let pos: Vec3;
      let normal: Vec3;
      switch (face) {
        case 0:
          pos = [h, u, v]; normal = [1, 0, 0]; break;
        case 1:
          pos = [-h, u, v]; normal = [-1, 0, 0]; break;
        case 2:
          pos = [u, h, v]; normal = [0, 1, 0]; break;
        case 3:
          pos = [u, -h, v]; normal = [0, -1, 0]; break;
        case 4:
          pos = [u, v, h]; normal = [0, 0, 1]; break;
        default:
          pos = [u, v, -h]; normal = [0, 0, -1]; break;
      }
      samples.push({ pos, normal });
    }
    return samples;
  }
  if (shape === 'cylinder') {
    const r = params.cylRadius ?? 15;
    const h = params.cylHalfHeight ?? 20;
    const sideArea = 2 * Math.PI * r * (2 * h);
    const capArea = Math.PI * r * r;
    const totalArea = sideArea + 2 * capArea;
    for (let i = 0; i < count; i++) {
      const pick = Math.random() * totalArea;
      if (pick < sideArea) {
        const theta = Math.random() * 2 * Math.PI;
        const y = (Math.random() * 2 - 1) * h;
        const x = r * Math.cos(theta);
        const z = r * Math.sin(theta);
        samples.push({ pos: [x, y, z], normal: normalize([x, 0, z]) });
      } else {
        const theta = Math.random() * 2 * Math.PI;
        const rr = Math.sqrt(Math.random()) * r;
        const x = rr * Math.cos(theta);
        const z = rr * Math.sin(theta);
        const top = pick < sideArea + capArea;
        samples.push({ pos: [x, top ? h : -h, z], normal: [0, top ? 1 : -1, 0] });
      }
    }
    return samples;
  }
  if (shape === 'torus') {
    const major = params.torusMajor ?? 20;
    const tube = params.torusTube ?? 8;
    for (let i = 0; i < count; i++) {
      const u = Math.random() * 2 * Math.PI;
      const v = Math.random() * 2 * Math.PI;
      const cx = (major + tube * Math.cos(v));
      const x = cx * Math.cos(u);
      const z = cx * Math.sin(u);
      const y = tube * Math.sin(v);
      const normal = normalize([Math.cos(u) * Math.cos(v), Math.sin(v), Math.sin(u) * Math.cos(v)]);
      samples.push({ pos: [x, y, z], normal });
    }
    return samples;
  }
  if (shape === 'capsule') {
    const r = params.capRadius ?? 12;
    const h = params.capHalfHeight ?? 15;
    const cylArea = 2 * Math.PI * r * (2 * h);
    const sphereArea = 4 * Math.PI * r * r;
    const totalArea = cylArea + sphereArea;
    for (let i = 0; i < count; i++) {
      const pick = Math.random() * totalArea;
      if (pick < cylArea) {
        const theta = Math.random() * 2 * Math.PI;
        const y = (Math.random() * 2 - 1) * h;
        const x = r * Math.cos(theta);
        const z = r * Math.sin(theta);
        samples.push({ pos: [x, y, z], normal: normalize([x, 0, z]) });
      } else {
        const u = Math.random();
        const v = Math.random();
        const theta = 2 * Math.PI * u;
        const phi = Math.acos(2 * v - 1);
        const sx = r * Math.sin(phi) * Math.cos(theta);
        const sy = r * Math.cos(phi);
        const sz = r * Math.sin(phi) * Math.sin(theta);
        const top = Math.random() > 0.5;
        const centerY = top ? h : -h;
        const pos: Vec3 = [sx, sy + centerY, sz];
        const normal = normalize([sx, sy, sz]);
        samples.push({ pos, normal });
      }
    }
    return samples;
  }
  return samples;
}

function relaxSurfaceSamples(
  target: SurfaceSamplerTarget,
  cellSize: number,
  iterations: number,
  strength: number
): SurfaceHexSample[] {
  const samples = target.samples;
  if (samples.length === 0) return samples;
  for (let it = 0; it < iterations; it++) {
    const grid = new Map<string, SurfaceHexSample[]>();
    for (const sample of samples) {
      const key = `${Math.floor(sample.pos[0] / cellSize)},${Math.floor(sample.pos[1] / cellSize)},${Math.floor(sample.pos[2] / cellSize)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(sample);
      else grid.set(key, [sample]);
    }

    for (const sample of samples) {
      const base = sample.pos;
      const cx = Math.floor(base[0] / cellSize);
      const cy = Math.floor(base[1] / cellSize);
      const cz = Math.floor(base[2] / cellSize);
      let push: Vec3 = [0, 0, 0];

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const key = `${cx + dx},${cy + dy},${cz + dz}`;
            const bucket = grid.get(key);
            if (!bucket) continue;
            for (const other of bucket) {
              if (other === sample) continue;
              const d = length(sub(base, other.pos));
              if (d > 1e-6 && d < cellSize) {
                const away = scale(sub(base, other.pos), (cellSize - d) / d);
                push = add(push, away);
              }
            }
          }
        }
      }

      const n = normalize(sample.normal);
      const normalComponent = scale(n, dot(push, n));
      const tangentMove = scale(sub(push, normalComponent), strength);
      sample.pos = add(sample.pos, tangentMove);
    }

    for (const sample of samples) {
      const projected = target.project(sample.pos);
      sample.pos = projected.pos;
      sample.normal = projected.normal;
    }
  }
  return samples;
}

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
      let objectSdf: ((x: number, y: number, z: number) => number) | null = null;
      let surfaceHexSdf: ((x: number, y: number, z: number) => number) | null = null;
      let bounds: { min: Vec3; max: Vec3 };
      let sphereRadius: number | null = null;
      let bvh: MeshBVH | null = null;
      let surfaceSamples: SurfaceHexSample[] = [];

      const shape = msg.sampleShape || (msg.sphereMode ? 'sphere' : null);
      const isHexSurface = params.variant === 'implicit_conformal' && params.latticeType === 'hexagon';

      if (shape) {
        const pad = params.cellSize * 0.5;

        switch (shape) {
          case 'sphere': {
            sphereRadius = msg.sphereRadius || 25;
            const R = sphereRadius;
            bounds = { min: [-(R+pad), -(R+pad), -(R+pad)], max: [R+pad, R+pad, R+pad] };
            objectSdf = (x, y, z) => Math.sqrt(x * x + y * y + z * z) - R;
            sdf = isHexSurface ? objectSdf : buildSphereLattice(R, params);
            break;
          }
          case 'cube': {
            const h = 15; // 30mm cube → halfSize 15
            bounds = { min: [-(h+pad), -(h+pad), -(h+pad)], max: [h+pad, h+pad, h+pad] };
            objectSdf = (x, y, z) => {
              const dx = Math.abs(x) - h;
              const dy = Math.abs(y) - h;
              const dz = Math.abs(z) - h;
              const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
              const inside = Math.min(Math.max(dx, dy, dz), 0);
              return outside + inside;
            };
            sdf = isHexSurface ? objectSdf : buildCubeLattice(h, params);
            break;
          }
          case 'cylinder': {
            const cr = 15, ch = 20; // R=15, H=40 → halfH=20
            bounds = { min: [-cr-pad, -ch-pad, -cr-pad], max: [cr+pad, ch+pad, cr+pad] };
            objectSdf = (x, y, z) => {
              const dRadial = Math.sqrt(x * x + z * z) - cr;
              const dAxial = Math.abs(y) - ch;
              const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
              const inside = Math.min(Math.max(dRadial, dAxial), 0);
              return outside + inside;
            };
            sdf = isHexSurface ? objectSdf : buildCylinderLattice(cr, ch, params);
            break;
          }
          case 'torus': {
            const mR = 20, tR = 8; // major=20, tube=8
            const xy = mR + tR + pad;
            bounds = { min: [-xy, -(tR+pad), -xy], max: [xy, tR+pad, xy] };
            objectSdf = (x, y, z) => {
              const qx = Math.sqrt(x * x + z * z) - mR;
              return Math.sqrt(qx * qx + y * y) - tR;
            };
            sdf = isHexSurface ? objectSdf : buildTorusLattice(mR, tR, params);
            break;
          }
          case 'capsule': {
            const capR = 12, capHH = 15; // R=12, H=30 → halfH=15, total extent = 15+12
            const capExt = capHH + capR + pad;
            bounds = { min: [-(capR+pad), -capExt, -(capR+pad)], max: [capR+pad, capExt, capR+pad] };
            objectSdf = (x, y, z) => {
              const cy = Math.max(-capHH, Math.min(capHH, y));
              return Math.sqrt(x * x + (y - cy) * (y - cy) + z * z) - capR;
            };
            sdf = isHexSurface ? objectSdf : buildCapsuleLattice(capR, capHH, params);
            break;
          }
        }
        postMessage({ type: 'progress', progress: 0.05, message: `${shape} SDF ready` } as WorkerResponse);
        if (isHexSurface) {
          const areaEstimate = (() => {
            switch (shape) {
              case 'sphere': return 4 * Math.PI * (sphereRadius ?? 25) ** 2;
              case 'cube': return 6 * (15 ** 2) * 4;
              case 'cylinder': return 2 * Math.PI * 15 * (40) + 2 * Math.PI * 15 * 15;
              case 'torus': return 4 * Math.PI * Math.PI * 20 * 8;
              case 'capsule': return 2 * Math.PI * 12 * (30) + 4 * Math.PI * 12 * 12;
              default: return 1000;
            }
          })();
          const spacingArea = params.cellSize * params.cellSize * 0.9;
          const sampleCount = Math.max(30, Math.round(areaEstimate / spacingArea));
          surfaceSamples = sampleSurfacePointsForShape(shape, sampleCount, {
            radius: sphereRadius ?? 25,
            halfSize: 15,
            cylRadius: 15,
            cylHalfHeight: 20,
            torusMajor: 20,
            torusTube: 8,
            capRadius: 12,
            capHalfHeight: 15,
          });
          const target: SurfaceSamplerTarget = {
            samples: surfaceSamples,
            project: (p) => projectToSurfaceSdf(objectSdf!, p, params.cellSize),
          };
          relaxSurfaceSamples(target, params.cellSize * 0.95, 10, 0.35);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, params, surfaceSamples);
        }
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
        objectSdf = (x, y, z) => bvh!.signedDistance([x, y, z]);
        sdf = buildCombinedSDF({ bvh, params, keepOutTris: keepOutSet });
        if (isHexSurface) {
          const positions = msg.meshPositions!;
          const normals = msg.meshNormals!;
          const triCount = msg.meshTriCount!;
          let totalArea = 0;
          for (let i = 0; i < triCount; i++) {
            if (keepOutSet.has(i)) continue;
            const o = i * 9;
            const a: Vec3 = [positions[o], positions[o + 1], positions[o + 2]];
            const b: Vec3 = [positions[o + 3], positions[o + 4], positions[o + 5]];
            const c: Vec3 = [positions[o + 6], positions[o + 7], positions[o + 8]];
            totalArea += triangleArea(a, b, c);
          }
          const spacingArea = params.cellSize * params.cellSize * 0.9;
          const sampleCount = Math.max(30, Math.round(totalArea / spacingArea));
          surfaceSamples = sampleSurfacePointsFromMesh(positions, normals, triCount, sampleCount, keepOutSet);
          const target: SurfaceSamplerTarget = {
            samples: surfaceSamples,
            project: (p) => {
              const res = bvh!.closestPoint(p);
              const ni = res.triIndex * 3;
              const normal = normalize([normals[ni], normals[ni + 1], normals[ni + 2]]);
              return { pos: res.point, normal };
            },
          };
          relaxSurfaceSamples(target, params.cellSize * 0.95, 10, 0.35);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, params, surfaceSamples);
        }
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
      const sdfToSample = surfaceHexSdf ?? sdf;
      const result = marchingCubes(sdfToSample, bounds, resolution, 0, (frac) => {
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
        const minThickness = checkMinThickness(sdfToSample, result, params.minFeatureSize, 200);
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
        validation = runValidation(result, sdfToSample, params, bvh, null);
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
