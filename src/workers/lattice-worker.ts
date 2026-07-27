// Web Worker for lattice generation (SDF sampling + marching cubes)
// This runs heavy computation off the main thread.

import { marchingCubesFromField, sampleSdfField, sealFieldBoundary } from '../geometry/marching-cubes';
import { openField, openingIsResolvable } from '../geometry/morphology';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { GridSdfSampler } from '../geometry/marching-cubes';
import { buildCombinedSDF, buildSurfaceHexLattice, buildSphereLattice, buildCubeLattice, buildCylinderLattice, buildTorusLattice, buildCapsuleLattice } from '../geometry/lattice';
import { MeshBVH } from '../geometry/bvh';
import { closeBoundaryLoops } from '../geometry/mesh-repair';
import { cutEscapeHolesInField, planEscapeHoles } from '../geometry/escape-holes';
import type { EscapeHole } from '../geometry/escape-holes';
import type { LatticeParams, ValidationResult, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import { add, sub, dot, cross, length, scale, normalize } from '../geometry/vec3';
import type { SurfaceHexSample } from '../geometry/lattice';
import type { LatticeTileJob, LatticeTileResponse, LatticeTileResult, TileBackend, TileSkipStats } from './tile-types';
import {
  detectGenerationBackendCapabilities,
  formatBackendCapabilities,
  selectBestBackend,
} from '../backend/generation-backend';
import { sampleFieldWebGPU } from '../backend/webgpu/webgpu-backend';

type SdfFunction = ((x: number, y: number, z: number) => number) & Partial<GridSdfSampler>;
type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;
const TILE_SIZE = 32;
const MAX_TILE_WORKERS = 8;
const ENABLE_SPARSE_TILE_SKIPPING = true;
const ENABLE_WASM_SINGLE_PLACEHOLDER = false;
const ENABLE_WASM_THREADED_PLACEHOLDER = false;
const ENABLE_WEBGPU_PLACEHOLDER = false;
const ENABLE_WEBGPU_FIELD_CPU_MC = false;

let activeTileWorkers: Worker[] = [];


function generatedResultTransferList(response: WorkerResponse): Transferable[] {
  const transfers: Transferable[] = [];
  // Generated result buffers are worker-owned after marching/cleanup and are
  // transferred to the UI so the viewer receives usable Float32Arrays without
  // copying the large position/normal payloads.
  if (response.positions) transfers.push(response.positions.buffer);
  if (response.normals) transfers.push(response.normals.buffer);
  if (response.surfaceSamplePositions) transfers.push(response.surfaceSamplePositions.buffer);
  if (response.surfaceSampleNormals) transfers.push(response.surfaceSampleNormals.buffer);
  if (response.surfaceSampleHoleScales) transfers.push(response.surfaceSampleHoleScales.buffer);
  return transfers;
}

function terminateTileWorkers(): void {
  for (const worker of activeTileWorkers) worker.terminate();
  activeTileWorkers = [];
}

function surfaceSampleWorkerTransferList(payload: ShapeSampleWorkerMessage | MeshSampleWorkerMessage): Transferable[] {
  if (payload.mode !== 'mesh') return [];
  if (payload.bufferKind === 'shared') return [];
  // Mesh sample workers receive copies made in this worker with .slice() below.
  // Transferring those copies does not detach UI-owned imported mesh buffers.
  return [payload.positions.buffer, payload.normals.buffer];
}

function isSharedFloat32Array(value: Float32Array): boolean {
  return typeof SharedArrayBuffer === 'function' && value.buffer instanceof SharedArrayBuffer;
}

function packSurfaceSamples(samples: SurfaceHexSample[]): {
  positions: Float32Array;
  normals: Float32Array;
  holeScales: Float32Array;
} | null {
  if (samples.length === 0) return null;
  const positions = new Float32Array(samples.length * 3);
  const normals = new Float32Array(samples.length * 3);
  const holeScales = new Float32Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];
    positions[i * 3] = sample.pos[0];
    positions[i * 3 + 1] = sample.pos[1];
    positions[i * 3 + 2] = sample.pos[2];
    normals[i * 3] = sample.normal[0];
    normals[i * 3 + 1] = sample.normal[1];
    normals[i * 3 + 2] = sample.normal[2];
    holeScales[i] = sample.holeScale ?? 1;
  }
  return { positions, normals, holeScales };
}

export interface WorkerMessage {
  type: 'generate' | 'validate' | 'cancel';
  // For generate:
  meshPositions?: Float32Array;
  meshNormals?: Float32Array;
  meshTriCount?: number;
  meshBufferKind?: 'shared' | 'transfer';
  params?: LatticeParams;
  sphereMode?: boolean;
  sphereRadius?: number;
  sampleShape?: SampleShape | null;
  resolution?: number;
  keepOutTris?: number[];
  keepInTris?: number[];
  demoMode?: boolean;
}

export interface WorkerResponse {
  type: 'progress' | 'result' | 'validation' | 'error';
  progress?: number;
  message?: string;
  positions?: Float32Array;
  normals?: Float32Array;
  triCount?: number;
  validation?: ValidationResult;
  surfaceSamplePositions?: Float32Array;
  surfaceSampleNormals?: Float32Array;
  surfaceSampleHoleScales?: Float32Array;
  escapeHoles?: EscapeHole[];
  /** Set when the requested feature threshold was too small for the grid. */
  thinFilterSkipped?: string;
  backend?: TileBackend;
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


type SurfaceSampleWorkerResponse = {
  positions: Float32Array;
  normals: Float32Array;
};

type ShapeSampleWorkerMessage = {
  mode: 'shape';
  shape: SampleShape;
  params: {
    radius?: number;
    halfSize?: number;
    cylRadius?: number;
    cylHalfHeight?: number;
    torusMajor?: number;
    torusTube?: number;
    capRadius?: number;
    capHalfHeight?: number;
  };
  targetCount: number;
  minDistance: number;
};

type MeshSampleWorkerMessage = {
  mode: 'mesh';
  positions: Float32Array;
  normals: Float32Array;
  bufferKind: 'shared' | 'transfer';
  triCount: number;
  keepOutTris: number[];
  targetCount: number;
  minDistance: number;
};

async function generatePoissonSamplesParallel(
  msgFactory: (targetCount: number) => ShapeSampleWorkerMessage | MeshSampleWorkerMessage,
  targetCount: number,
  minDistance: number,
  maxWorkers = Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency ?? 2) - 1))
): Promise<SurfaceHexSample[]> {
  const workerCount = Math.max(1, Math.min(maxWorkers, targetCount >= 240 ? 4 : 2));
  if (workerCount <= 1) {
    return [];
  }

  const perWorker = Math.ceil(targetCount / workerCount);
  const jobs = Array.from({ length: workerCount }, async (_, i) => {
    const count = Math.min(perWorker, Math.max(0, targetCount - i * perWorker));
    if (count <= 0) return [] as SurfaceHexSample[];

    const worker = new Worker(new URL('./surface-sample-worker.ts', import.meta.url), { type: 'module' });
    const response = await new Promise<SurfaceSampleWorkerResponse>((resolve, reject) => {
      worker.onmessage = (ev: MessageEvent<SurfaceSampleWorkerResponse>) => resolve(ev.data);
      worker.onerror = (err) => reject(err);
      const payload = msgFactory(count);
      worker.postMessage(payload, surfaceSampleWorkerTransferList(payload));
    }).finally(() => worker.terminate());

    const samples: SurfaceHexSample[] = [];
    for (let j = 0; j < response.positions.length; j += 3) {
      samples.push({
        pos: [response.positions[j], response.positions[j + 1], response.positions[j + 2]],
        normal: normalize([response.normals[j], response.normals[j + 1], response.normals[j + 2]]),
      });
    }
    return samples;
  });

  const all = (await Promise.all(jobs)).flat();
  // Trim to requested size if workers overshoot.
  return all.slice(0, targetCount);
}
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

type MeshSampler = {
  sample: () => SurfaceHexSample;
  totalArea: number;
};

function buildMeshSampler(
  positions: Float32Array,
  normals: Float32Array,
  triCount: number,
  keepOutTris: Set<number>
): MeshSampler | null {
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
  if (totalArea <= 1e-6) return null;
  return {
    totalArea,
    sample: () => {
      const triIndex = pickTriangle(areas, totalArea);
      const o = triIndex * 9;
      const a: Vec3 = [positions[o], positions[o + 1], positions[o + 2]];
      const b: Vec3 = [positions[o + 3], positions[o + 4], positions[o + 5]];
      const c: Vec3 = [positions[o + 6], positions[o + 7], positions[o + 8]];
      const pos = sampleTriangle(a, b, c);
      const ni = triIndex * 3;
      const normal = normalize([normals[ni], normals[ni + 1], normals[ni + 2]]);
      return { pos, normal };
    },
  };
}


function removeDisconnectedFragments(
  mesh: { positions: Float32Array; normals: Float32Array; triCount: number },
  minComponentRatio = 0.003
): { positions: Float32Array; normals: Float32Array; triCount: number; removedTriangles: number } {
  const { positions, normals, triCount } = mesh;
  if (triCount <= 0) return { positions, normals, triCount, removedTriangles: 0 };

  const q = (v: number) => Math.round(v * 1e3);
  const edgeToTris = new Map<string, number[]>();
  for (let i = 0; i < triCount; i++) {
    const verts: string[] = [];
    for (let v = 0; v < 3; v++) {
      const o = i * 9 + v * 3;
      verts.push(`${q(positions[o])},${q(positions[o + 1])},${q(positions[o + 2])}`);
    }
    for (let e = 0; e < 3; e++) {
      const a = verts[e];
      const b = verts[(e + 1) % 3];
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      const arr = edgeToTris.get(key);
      if (arr) arr.push(i);
      else edgeToTris.set(key, [i]);
    }
  }

  const adj: number[][] = Array.from({ length: triCount }, () => []);
  for (const tris of edgeToTris.values()) {
    for (let i = 0; i < tris.length; i++) {
      for (let j = i + 1; j < tris.length; j++) {
        adj[tris[i]].push(tris[j]);
        adj[tris[j]].push(tris[i]);
      }
    }
  }

  const visited = new Uint8Array(triCount);
  const components: number[][] = [];
  for (let i = 0; i < triCount; i++) {
    if (visited[i]) continue;
    const comp: number[] = [];
    const stack = [i];
    while (stack.length) {
      const t = stack.pop()!;
      if (visited[t]) continue;
      visited[t] = 1;
      comp.push(t);
      for (const nb of adj[t]) {
        if (!visited[nb]) stack.push(nb);
      }
    }
    components.push(comp);
  }

  if (components.length <= 1) {
    return { positions, normals, triCount, removedTriangles: 0 };
  }

  components.sort((a, b) => b.length - a.length);
  const largest = components[0].length;
  const keep = new Uint8Array(triCount);
  for (const comp of components) {
    if (comp.length === largest || comp.length >= largest * minComponentRatio) {
      for (const idx of comp) keep[idx] = 1;
    }
  }

  let kept = 0;
  for (let i = 0; i < triCount; i++) if (keep[i]) kept++;
  if (kept === triCount || kept === 0) {
    return { positions, normals, triCount, removedTriangles: 0 };
  }

  const outPos = new Float32Array(kept * 9);
  const outNrm = new Float32Array(kept * 3);
  let outTri = 0;
  for (let i = 0; i < triCount; i++) {
    if (!keep[i]) continue;
    outPos.set(positions.subarray(i * 9, i * 9 + 9), outTri * 9);
    outNrm.set(normals.subarray(i * 3, i * 3 + 3), outTri * 3);
    outTri++;
  }

  return {
    positions: outPos,
    normals: outNrm,
    triCount: outTri,
    removedTriangles: triCount - outTri,
  };
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

function sampleSurfacePointForShape(
  shape: SampleShape,
  params: { radius?: number; halfSize?: number; cylRadius?: number; cylHalfHeight?: number; torusMajor?: number; torusTube?: number; capRadius?: number; capHalfHeight?: number }
): SurfaceHexSample {
  if (shape === 'sphere') {
    const r = params.radius ?? 25;
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const x = r * Math.sin(phi) * Math.cos(theta);
    const y = r * Math.sin(phi) * Math.sin(theta);
    const z = r * Math.cos(phi);
    const pos: Vec3 = [x, y, z];
    return { pos, normal: normalize(pos) };
  }
  if (shape === 'cube') {
    const h = params.halfSize ?? 15;
    const faceArea = 4 * h * h;
    const totalArea = faceArea * 6;
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
    return { pos, normal };
  }
  if (shape === 'cylinder') {
    const r = params.cylRadius ?? 15;
    const h = params.cylHalfHeight ?? 20;
    const sideArea = 2 * Math.PI * r * (2 * h);
    const capArea = Math.PI * r * r;
    const totalArea = sideArea + 2 * capArea;
    const pick = Math.random() * totalArea;
    if (pick < sideArea) {
      const theta = Math.random() * 2 * Math.PI;
      const z = (Math.random() * 2 - 1) * h;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      return { pos: [x, y, z], normal: normalize([x, y, 0]) };
    }
    const theta = Math.random() * 2 * Math.PI;
    const rr = Math.sqrt(Math.random()) * r;
    const x = rr * Math.cos(theta);
    const y = rr * Math.sin(theta);
    const top = pick < sideArea + capArea;
    return { pos: [x, y, top ? h : -h], normal: [0, 0, top ? 1 : -1] };
  }
  if (shape === 'torus') {
    const major = params.torusMajor ?? 20;
    const tube = params.torusTube ?? 8;
    const u = Math.random() * 2 * Math.PI;
    const v = Math.random() * 2 * Math.PI;
    const cx = (major + tube * Math.cos(v));
    const x = cx * Math.cos(u);
    const y = cx * Math.sin(u);
    const z = tube * Math.sin(v);
    const normal = normalize([Math.cos(u) * Math.cos(v), Math.sin(u) * Math.cos(v), Math.sin(v)]);
    return { pos: [x, y, z], normal };
  }
  if (shape === 'capsule') {
    const r = params.capRadius ?? 12;
    const h = params.capHalfHeight ?? 15;
    const cylArea = 2 * Math.PI * r * (2 * h);
    const sphereArea = 4 * Math.PI * r * r;
    const totalArea = cylArea + sphereArea;
    const pick = Math.random() * totalArea;
    if (pick < cylArea) {
      const theta = Math.random() * 2 * Math.PI;
      const z = (Math.random() * 2 - 1) * h;
      const x = r * Math.cos(theta);
      const y = r * Math.sin(theta);
      return { pos: [x, y, z], normal: normalize([x, y, 0]) };
    }
    const u = Math.random();
    const v = Math.random();
    const theta = 2 * Math.PI * u;
    const phi = Math.acos(2 * v - 1);
    const sx = r * Math.sin(phi) * Math.cos(theta);
    const sy = r * Math.sin(phi) * Math.sin(theta);
    const sz = r * Math.cos(phi);
    const top = Math.random() > 0.5;
    const centerZ = top ? h : -h;
    const pos: Vec3 = [sx, sy, sz + centerZ];
    const normal = normalize([sx, sy, sz]);
    return { pos, normal };
  }
  return { pos: [0, 0, 0], normal: [0, 0, 1] };
}

function buildFibonacciSphereSamples(radius: number, count: number): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) / count;
    const z = 1 - 2 * t;
    const ring = Math.sqrt(1 - z * z);
    const theta = goldenAngle * i;
    const x = Math.cos(theta) * ring;
    const y = Math.sin(theta) * ring;
    const pos: Vec3 = [x * radius, y * radius, z * radius];
    samples.push({ pos, normal: normalize(pos) });
  }
  return samples;
}

function generatePoissonSamples(
  sampler: () => SurfaceHexSample,
  targetCount: number,
  minDistance: number
): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  let currentMin = minDistance;
  let attempts = 0;
  while (samples.length < targetCount && attempts < 6) {
    const grid = new Map<string, SurfaceHexSample[]>();
    for (const s of samples) {
      const key = `${Math.floor(s.pos[0] / currentMin)},${Math.floor(s.pos[1] / currentMin)},${Math.floor(s.pos[2] / currentMin)}`;
      const bucket = grid.get(key);
      if (bucket) bucket.push(s);
      else grid.set(key, [s]);
    }
    const batchCount = Math.max(targetCount * 3, 200);
    for (let i = 0; i < batchCount && samples.length < targetCount; i++) {
      const cand = sampler();
      const cx = Math.floor(cand.pos[0] / currentMin);
      const cy = Math.floor(cand.pos[1] / currentMin);
      const cz = Math.floor(cand.pos[2] / currentMin);
      let ok = true;
      for (let dx = -1; dx <= 1 && ok; dx++) {
        for (let dy = -1; dy <= 1 && ok; dy++) {
          for (let dz = -1; dz <= 1 && ok; dz++) {
            const key = `${cx + dx},${cy + dy},${cz + dz}`;
            const bucket = grid.get(key);
            if (!bucket) continue;
            for (const other of bucket) {
              if (length(sub(cand.pos, other.pos)) < currentMin) {
                ok = false;
                break;
              }
            }
          }
        }
      }
      if (ok) {
        samples.push(cand);
        const key = `${cx},${cy},${cz}`;
        const bucket = grid.get(key);
        if (bucket) bucket.push(cand);
        else grid.set(key, [cand]);
      }
    }
    if (samples.length < targetCount) {
      currentMin *= 0.85;
      attempts += 1;
    }
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


function applyAdaptiveHoleScales(samples: SurfaceHexSample[], spacing: number): SurfaceHexSample[] {
  if (samples.length === 0) return samples;
  const cell = Math.max(0.1, spacing);
  const grid = new Map<string, SurfaceHexSample[]>();
  for (const sample of samples) {
    const key = `${Math.floor(sample.pos[0] / cell)},${Math.floor(sample.pos[1] / cell)},${Math.floor(sample.pos[2] / cell)}`;
    const bucket = grid.get(key);
    if (bucket) bucket.push(sample);
    else grid.set(key, [sample]);
  }

  for (const sample of samples) {
    const base = sample.pos;
    const cx = Math.floor(base[0] / cell);
    const cy = Math.floor(base[1] / cell);
    const cz = Math.floor(base[2] / cell);
    let nearest = Infinity;

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const key = `${cx + dx},${cy + dy},${cz + dz}`;
          const bucket = grid.get(key);
          if (!bucket) continue;
          for (const other of bucket) {
            if (other === sample) continue;
            const d = length(sub(base, other.pos));
            if (d > 1e-6 && d < nearest) nearest = d;
          }
        }
      }
    }

    if (!Number.isFinite(nearest)) {
      sample.holeScale = 1.0;
      continue;
    }
    // 0.866 = 2*cos(30°)/2 packing-safe factor for neighboring hex inradii
    const targetScale = (nearest / spacing) * 0.86;
    sample.holeScale = Math.max(0.72, Math.min(1.0, targetScale));
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

function tileWorkerCount(): number {
  return Math.max(1, Math.min(MAX_TILE_WORKERS, (self.navigator?.hardwareConcurrency || 4) - 1));
}

function objectSdfForShape(shape: SampleShape, sphereRadius: number): (x: number, y: number, z: number) => number {
  switch (shape) {
    case 'sphere': {
      const radius = sphereRadius || 25;
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - radius;
    }
    case 'cube': {
      const h = 15;
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
      const cr = 15;
      const ch = 20;
      return (x, y, z) => {
        const dRadial = Math.sqrt(x * x + y * y) - cr;
        const dAxial = Math.abs(z) - ch;
        const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
        const inside = Math.min(Math.max(dRadial, dAxial), 0);
        return outside + inside;
      };
    }
    case 'torus': {
      const major = 20;
      const tube = 8;
      return (x, y, z) => {
        const qx = Math.sqrt(x * x + y * y) - major;
        return Math.sqrt(qx * qx + z * z) - tube;
      };
    }
    case 'capsule': {
      const capR = 12;
      const capHH = 15;
      return (x, y, z) => {
        const cz = Math.max(-capHH, Math.min(capHH, z));
        return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - capR;
      };
    }
  }
}

function sparseSkipMargin(params: LatticeParams, tileBounds: { min: Vec3; max: Vec3 }): number {
  const sx = tileBounds.max[0] - tileBounds.min[0];
  const sy = tileBounds.max[1] - tileBounds.min[1];
  const sz = tileBounds.max[2] - tileBounds.min[2];
  const tileRadius = 0.5 * Math.sqrt(sx * sx + sy * sy + sz * sz);
  const featureMargin = Math.max(
    params.cellSize * 0.25,
    params.wallThickness,
    params.strutDiameter,
    params.shellThickness,
    params.surfaceDepth,
    params.thinSectionFilter,
    0
  );
  return tileRadius + featureMargin;
}

function classifySparseTile(
  params: LatticeParams,
  objectSdf: (x: number, y: number, z: number) => number,
  tileBounds: { min: Vec3; max: Vec3 }
): 'process' | 'skip' {
  if (!ENABLE_SPARSE_TILE_SKIPPING) return 'process';

  const min = tileBounds.min;
  const max = tileBounds.max;
  const cx = (min[0] + max[0]) * 0.5;
  const cy = (min[1] + max[1]) * 0.5;
  const cz = (min[2] + max[2]) * 0.5;
  const margin = sparseSkipMargin(params, tileBounds);
  let minD = Infinity;
  let maxD = -Infinity;

  const record = (d: number) => {
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  };
  record(objectSdf(min[0], min[1], min[2]));
  record(objectSdf(max[0], min[1], min[2]));
  record(objectSdf(min[0], max[1], min[2]));
  record(objectSdf(max[0], max[1], min[2]));
  record(objectSdf(min[0], min[1], max[2]));
  record(objectSdf(max[0], min[1], max[2]));
  record(objectSdf(min[0], max[1], max[2]));
  record(objectSdf(max[0], max[1], max[2]));
  record(objectSdf(cx, cy, cz));

  // All modes are empty far enough outside the source object.
  if (minD > margin) return 'skip';

  // Surface-only lattices are also empty deep enough inside the surface band.
  if (params.surfaceOnly && maxD < -params.surfaceDepth - margin) return 'skip';

  return 'process';
}

function buildTileJobs(
  params: LatticeParams,
  shape: SampleShape,
  sphereRadius: number,
  bounds: { min: Vec3; max: Vec3 },
  resolution: number,
  escapeHoles: EscapeHole[]
): { jobs: LatticeTileJob[]; stats: TileSkipStats } {
  const jobs: LatticeTileJob[] = [];
  const dx = (bounds.max[0] - bounds.min[0]) / resolution;
  const dy = (bounds.max[1] - bounds.min[1]) / resolution;
  const dz = (bounds.max[2] - bounds.min[2]) / resolution;
  let tileId = 0;
  let tilesTotal = 0;
  let tilesSkipped = 0;
  const objectSdf = objectSdfForShape(shape, sphereRadius);

  for (let z = 0; z < resolution; z += TILE_SIZE) {
    const cz = Math.min(TILE_SIZE, resolution - z);
    for (let y = 0; y < resolution; y += TILE_SIZE) {
      const cy = Math.min(TILE_SIZE, resolution - y);
      for (let x = 0; x < resolution; x += TILE_SIZE) {
        const cx = Math.min(TILE_SIZE, resolution - x);
        tilesTotal++;
        const tileBounds = {
          min: [bounds.min[0] + x * dx, bounds.min[1] + y * dy, bounds.min[2] + z * dz] as Vec3,
          max: [bounds.min[0] + (x + cx) * dx, bounds.min[1] + (y + cy) * dy, bounds.min[2] + (z + cz) * dz] as Vec3,
        };
        if (classifySparseTile(params, objectSdf, tileBounds) === 'skip') {
          tilesSkipped++;
          continue;
        }
        jobs.push({
          type: 'tile',
          tileId: tileId++,
          params,
          shape,
          sphereRadius,
          cells: [cx, cy, cz],
          bounds: tileBounds,
          escapeHoles,
        });
      }
    }
  }

  return {
    jobs,
    stats: {
      tilesTotal,
      tilesSkipped,
      tilesProcessed: jobs.length,
    },
  };
}

function mergeTileResults(results: LatticeTileResult[]): MarchingCubesResult {
  const sorted = [...results].sort((a, b) => a.tileId - b.tileId);
  let triCount = 0;
  let positionLength = 0;
  let normalLength = 0;
  for (const result of sorted) {
    triCount += result.triCount;
    positionLength += result.positions.length;
    normalLength += result.normals.length;
  }

  const positions = new Float32Array(positionLength);
  const normals = new Float32Array(normalLength);
  let po = 0;
  let no = 0;
  for (const result of sorted) {
    positions.set(result.positions, po);
    normals.set(result.normals, no);
    po += result.positions.length;
    no += result.normals.length;
  }

  return { positions, normals, triCount };
}

function runTiledGeneration(
  params: LatticeParams,
  shape: SampleShape,
  sphereRadius: number,
  bounds: { min: Vec3; max: Vec3 },
  resolution: number,
  escapeHoles: EscapeHole[],
  onProgress: (completed: number, total: number, timingMs: number, stats: TileSkipStats) => void
): Promise<{ result: MarchingCubesResult; stats: TileSkipStats }> {
  const { jobs, stats } = buildTileJobs(params, shape, sphereRadius, bounds, resolution, escapeHoles);
  if (jobs.length === 0) {
    return Promise.resolve({
      result: { positions: new Float32Array(0), normals: new Float32Array(0), triCount: 0 },
      stats,
    });
  }
  const workerCount = Math.min(tileWorkerCount(), jobs.length);
  const results: LatticeTileResult[] = [];
  let nextJob = 0;
  let completed = 0;
  let timingMs = 0;

  return new Promise<{ result: MarchingCubesResult; stats: TileSkipStats }>((resolve, reject) => {
    const finish = () => {
      terminateTileWorkers();
      resolve({ result: mergeTileResults(results), stats });
    };

    const startWorker = () => {
      const worker = new Worker(new URL('./lattice-tile-worker.ts', import.meta.url), { type: 'module' });
      activeTileWorkers.push(worker);

      const postNext = () => {
        if (cancelled) {
          reject(new Error('Cancelled'));
          return;
        }
        const job = jobs[nextJob++];
        if (!job) {
          if (completed === jobs.length) finish();
          return;
        }
        worker.postMessage(job);
      };

      worker.onmessage = (event: MessageEvent<LatticeTileResponse>) => {
        const response = event.data;
        if (response.type === 'error') {
          reject(new Error(response.message));
          return;
        }
        results[response.tileId] = response;
        completed++;
        timingMs += response.timing.totalMs;
        onProgress(completed, jobs.length, timingMs, stats);
        if (completed === jobs.length) finish();
        else postNext();
      };
      worker.onerror = () => reject(new Error('Tile worker failed'));
      postNext();
    };

    try {
      for (let i = 0; i < workerCount; i++) startWorker();
    } catch (err) {
      terminateTileWorkers();
      reject(err instanceof Error ? err : new Error('Tile worker creation failed'));
    }
  }).finally(() => terminateTileWorkers());
}

self.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;

  if (msg.type === 'cancel') {
    cancelled = true;
    terminateTileWorkers();
    return;
  }

  cancelled = false;

  if (msg.type === 'generate') {
    try {
      const generationStart = performance.now();
      const params = msg.params!;
      const resolution = msg.resolution || 64;
      let sdf: SdfFunction;
      let objectSdf: ((x: number, y: number, z: number) => number) | null = null;
      let surfaceHexSdf: SdfFunction | null = null;
      let bounds: { min: Vec3; max: Vec3 };
      let sphereRadius: number | null = null;
      let thinFilterSkipped: string | null = null;
      let bvh: MeshBVH | null = null;
      let surfaceSamples: SurfaceHexSample[] = [];

      const isDemoGrid = Boolean(msg.demoMode);
      const shape = isDemoGrid ? null : (msg.sampleShape || (msg.sphereMode ? 'sphere' : null));
      const isSurfacePolygon = !isDemoGrid && params.variant === 'implicit_conformal' && (params.latticeType === 'hexagon' || params.latticeType === 'triangle');

      if (isDemoGrid) {
        const pad = params.cellSize * 0.5;
        const demoTypes: LatticeParams['latticeType'][] = [
          'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
          'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
        ];
        const cols = 4;
        const rows = Math.ceil(demoTypes.length / cols);
        const spacing = Math.max(20, params.cellSize * 2.6);
        const demoRadius = Math.max(7, Math.min(10, (msg.sphereRadius || 25) * 0.35));
        const windowHalf = Math.max(demoRadius + 1.8, spacing * 0.42);
        const baseParams: LatticeParams = { ...params, variant: 'shell_core', surfaceOnly: false, noShell: false };

        const boxSdf = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
          const dx = Math.abs(x) - hx;
          const dy = Math.abs(y) - hy;
          const dz = Math.abs(z) - hz;
          const outside = Math.sqrt(Math.max(dx, 0) ** 2 + Math.max(dy, 0) ** 2 + Math.max(dz, 0) ** 2);
          const inside = Math.min(Math.max(dx, dy, dz), 0);
          return outside + inside;
        };

        const cells = demoTypes.map((latticeType, index) => {
          const col = index % cols;
          const row = Math.floor(index / cols);
          const cx = (col - (cols - 1) / 2) * spacing;
          const cz = (row - (rows - 1) / 2) * spacing;
          const localParams: LatticeParams = { ...baseParams, latticeType };
          const sphereSdf = buildSphereLattice(demoRadius, localParams);
          return {
            cx,
            cz,
            sdf: (x: number, y: number, z: number) => {
              const localX = x - cx;
              const localZ = z - cz;
              return Math.max(
                sphereSdf(localX, y, localZ),
                boxSdf(localX, y, localZ, windowHalf, demoRadius + 2.2, windowHalf)
              );
            },
          };
        });

        const extentX = ((cols - 1) * spacing) * 0.5 + windowHalf + pad;
        const extentZ = ((rows - 1) * spacing) * 0.5 + windowHalf + pad;
        const extentY = demoRadius + 2.5 + pad;
        bounds = { min: [-extentX, -extentY, -extentZ], max: [extentX, extentY, extentZ] };

        sdf = (x, y, z) => {
          let d = Infinity;
          for (const c of cells) d = Math.min(d, c.sdf(x, y, z));
          return d;
        };

        postMessage({
          type: 'progress',
          progress: 0.06,
          message: `Demo grid ready: ${demoTypes.length} lattice types tiled on spheres`
        } as WorkerResponse);
      } else if (shape) {
        const pad = params.cellSize * 0.5;

        switch (shape) {
          case 'sphere': {
            sphereRadius = msg.sphereRadius || 25;
            const R = sphereRadius;
            bounds = { min: [-(R+pad), -(R+pad), -(R+pad)], max: [R+pad, R+pad, R+pad] };
            objectSdf = (x, y, z) => Math.sqrt(x * x + y * y + z * z) - R;
            sdf = isSurfacePolygon ? objectSdf : buildSphereLattice(R, params);
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
            sdf = isSurfacePolygon ? objectSdf : buildCubeLattice(h, params);
            break;
          }
          case 'cylinder': {
            const cr = 15, ch = 20; // R=15, H=40 → halfH=20
            bounds = { min: [-cr-pad, -cr-pad, -ch-pad], max: [cr+pad, cr+pad, ch+pad] };
            objectSdf = (x, y, z) => {
              const dRadial = Math.sqrt(x * x + y * y) - cr;
              const dAxial = Math.abs(z) - ch;
              const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
              const inside = Math.min(Math.max(dRadial, dAxial), 0);
              return outside + inside;
            };
            sdf = isSurfacePolygon ? objectSdf : buildCylinderLattice(cr, ch, params);
            break;
          }
          case 'torus': {
            const mR = 20, tR = 8; // major=20, tube=8
            const xy = mR + tR + pad;
            bounds = { min: [-xy, -xy, -(tR+pad)], max: [xy, xy, tR+pad] };
            objectSdf = (x, y, z) => {
              const qx = Math.sqrt(x * x + y * y) - mR;
              return Math.sqrt(qx * qx + z * z) - tR;
            };
            sdf = isSurfacePolygon ? objectSdf : buildTorusLattice(mR, tR, params);
            break;
          }
          case 'capsule': {
            const capR = 12, capHH = 15; // R=12, H=30 → halfH=15, total extent = 15+12
            const capExt = capHH + capR + pad;
            bounds = { min: [-(capR+pad), -(capR+pad), -capExt], max: [capR+pad, capR+pad, capExt] };
            objectSdf = (x, y, z) => {
              const cz = Math.max(-capHH, Math.min(capHH, z));
              return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - capR;
            };
            sdf = isSurfacePolygon ? objectSdf : buildCapsuleLattice(capR, capHH, params);
            break;
          }
        }
        postMessage({ type: 'progress', progress: 0.05, message: `${shape} SDF ready` } as WorkerResponse);
        if (isSurfacePolygon) {
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
          const spacingArea = params.cellSize * params.cellSize * 0.55;
          const sampleCount = Math.max(60, Math.round(areaEstimate / spacingArea));
          if (shape === 'sphere') {
            surfaceSamples = buildFibonacciSphereSamples(sphereRadius ?? 25, sampleCount);
          } else {
            const samplerParams = {
              radius: sphereRadius ?? 25,
              halfSize: 15,
              cylRadius: 15,
              cylHalfHeight: 20,
              torusMajor: 20,
              torusTube: 8,
              capRadius: 12,
              capHalfHeight: 15,
            };
            const fallbackSampler = () => sampleSurfacePointForShape(shape, samplerParams);
            surfaceSamples = await generatePoissonSamplesParallel(
              (count) => ({
                mode: 'shape',
                shape,
                params: samplerParams,
                targetCount: count,
                minDistance: params.cellSize * 0.75,
              }),
              sampleCount,
              params.cellSize * 0.75
            );
            if (surfaceSamples.length < Math.floor(sampleCount * 0.8)) {
              surfaceSamples = generatePoissonSamples(fallbackSampler, sampleCount, params.cellSize * 0.75);
            }
          }
          const target: SurfaceSamplerTarget = {
            samples: surfaceSamples,
            project: (p) => projectToSurfaceSdf(objectSdf!, p, params.cellSize),
          };
          relaxSurfaceSamples(target, params.cellSize * 0.95, 10, 0.35);
          applyAdaptiveHoleScales(surfaceSamples, params.cellSize);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, params, surfaceSamples);
        }
      } else {
        // Build BVH from mesh
        const meshBufferKind = msg.meshBufferKind ?? (isSharedFloat32Array(msg.meshPositions!) ? 'shared' : 'transfer');
        postMessage({
          type: 'progress',
          progress: 0.01,
          message: `Mesh buffers: ${meshBufferKind === 'shared' ? 'SharedArrayBuffer shared-memory' : 'ArrayBuffer transfer'} path active`
        } as WorkerResponse);
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
        const keepInSet = new Set(msg.keepInTris || []);
        objectSdf = (x, y, z) => bvh!.signedDistance([x, y, z]);
        sdf = buildCombinedSDF({ bvh, params, keepOutTris: keepOutSet, keepInTris: keepInSet });
        if (keepOutSet.size > 0 || keepInSet.size > 0) {
          postMessage({
            type: 'progress',
            progress: 0.1,
            message: `Constraints active: ${keepOutSet.size} keep-out, ${keepInSet.size} keep-in triangles`
          } as WorkerResponse);
        }
        if (isSurfacePolygon) {
          const positions = msg.meshPositions!;
          const normals = msg.meshNormals!;
          const triCount = msg.meshTriCount!;
          const useSharedMeshSamples = meshBufferKind === 'shared';
          const meshSampler = buildMeshSampler(positions, normals, triCount, keepOutSet);
          const totalArea = meshSampler?.totalArea ?? 0;
          const spacingArea = params.cellSize * params.cellSize * 0.55;
          const sampleCount = Math.max(60, Math.round(totalArea / spacingArea));
          if (meshSampler) {
            surfaceSamples = await generatePoissonSamplesParallel(
              (count) => ({
                mode: 'mesh',
                positions: useSharedMeshSamples ? positions : positions.slice(),
                normals: useSharedMeshSamples ? normals : normals.slice(),
                bufferKind: useSharedMeshSamples ? 'shared' : 'transfer',
                triCount,
                keepOutTris: Array.from(keepOutSet),
                targetCount: count,
                minDistance: params.cellSize * 0.75,
              }),
              sampleCount,
              params.cellSize * 0.75
            );
            if (surfaceSamples.length < Math.floor(sampleCount * 0.8)) {
              surfaceSamples = generatePoissonSamples(meshSampler.sample, sampleCount, params.cellSize * 0.75);
            }
          }
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
          applyAdaptiveHoleScales(surfaceSamples, params.cellSize);
          surfaceHexSdf = buildSurfaceHexLattice(objectSdf!, params, surfaceSamples);
        }
      }

      // Planned once here, from the raw object field, so every backend and the
      // validation pass all cut exactly the same channels.
      const escapeHoles = objectSdf ? planEscapeHoles(objectSdf, bounds, params) : [];
      if (escapeHoles.length > 0) {
        postMessage({
          type: 'progress',
          progress: 0.11,
          message: `Escape holes: ${escapeHoles.length} x ${params.escapeHoleDiameter}mm channels planned`
        } as WorkerResponse);
      } else if (params.escapeHoles && objectSdf && !params.noShell && !params.surfaceOnly) {
        postMessage({
          type: 'progress',
          progress: 0.11,
          message: 'Escape holes enabled but no placement found on this surface'
        } as WorkerResponse);
      }

      // Opening is a whole-volume distance transform, so it cannot be split
      // across tiles without seams. Generation falls back to the single-volume
      // backend whenever it is active.
      const thinFilterActive = params.thinSectionFilter > 0;
      const tileWorkerPoolAvailable = Boolean(
        shape && !isSurfacePolygon && !isDemoGrid && !thinFilterActive && tileWorkerCount() > 0
      );
      const backendCapabilities = detectGenerationBackendCapabilities(self, { tileWorkerPoolAvailable });
      const selectedBackend = selectBestBackend({
        capabilities: backendCapabilities,
        enableWasmSinglePlaceholder: ENABLE_WASM_SINGLE_PLACEHOLDER,
        enableWasmThreadedPlaceholder: ENABLE_WASM_THREADED_PLACEHOLDER,
        enableWebGPUPlaceholder: ENABLE_WEBGPU_PLACEHOLDER,
        enableWebGPUFieldCpuMc: ENABLE_WEBGPU_FIELD_CPU_MC &&
          Boolean(shape && !isSurfacePolygon && !isDemoGrid && (params.latticeType === 'gyroid' || params.latticeType === 'schwarzP')),
      });
      postMessage({
        type: 'progress',
        progress: 0.11,
        message: `Selected backend ${selectedBackend} (${formatBackendCapabilities(backendCapabilities)})`
      } as WorkerResponse);

      if (selectedBackend === 'webgpu-field-cpu-mc' && shape) {
        try {
          const backendStart = performance.now();
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `Backend ${selectedBackend}: WebGPU field sampling, CPU marching cubes`
          } as WorkerResponse);
          const sampled = await sampleFieldWebGPU({
            bounds,
            resolution,
            shape,
            sphereRadius: sphereRadius ?? msg.sphereRadius ?? 25,
            params,
          });
          if (cancelled) throw new Error('Cancelled');
          postMessage({
            type: 'progress',
            progress: 0.45,
            message: `WebGPU field ${Math.round(sampled.timing.webgpuFieldMs)}ms, GPU readback ${Math.round(sampled.timing.readbackMs)}ms`
          } as WorkerResponse);
          cutEscapeHolesInField(sampled.field, bounds, [resolution, resolution, resolution], escapeHoles);
          const cpuMcStart = performance.now();
          const rawResult = marchingCubesFromField(sampled.field, bounds, [resolution, resolution, resolution], 0, (frac) => {
            if (cancelled) throw new Error('Cancelled');
            postMessage({
              type: 'progress',
              progress: 0.45 + frac * 0.45,
              message: `CPU marching cubes from WebGPU field: ${Math.round(frac * 100)}%`
            } as WorkerResponse);
          });
          const cpuMcMs = performance.now() - cpuMcStart;
          const cleaned = removeDisconnectedFragments(rawResult, 0.004);
      const result = { ...cleaned, ...closeBoundaryLoops(cleaned).result };
          if (result.removedTriangles > 0) {
            postMessage({
              type: 'progress',
              progress: 0.9,
              message: `Removed ${result.removedTriangles.toLocaleString()} disconnected fragment triangles`
            } as WorkerResponse);
          }
          postMessage({
            type: 'progress',
            progress: 0.95,
            message: `Geometry ready via ${selectedBackend} in ${Math.round(performance.now() - backendStart)}ms (webgpu field ${Math.round(sampled.timing.webgpuFieldMs)}ms, readback ${Math.round(sampled.timing.readbackMs)}ms, CPU marching cubes ${Math.round(cpuMcMs)}ms)`
          } as WorkerResponse);
          const response: WorkerResponse = {
            type: 'result',
            positions: result.positions,
            normals: result.normals,
            triCount: result.triCount,
            escapeHoles,
            backend: selectedBackend,
          };
          postWorkerMessage(response, generatedResultTransferList(response));
          return;
        } catch (err: unknown) {
          if (cancelled) throw new Error('Cancelled');
          const message = err instanceof Error ? err.message : 'unknown error';
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `${selectedBackend} unavailable (${message}); falling back to cpu-single`
          } as WorkerResponse);
        }
      }

      if (selectedBackend === 'cpu-tiled' && shape) {
        try {
          const tiledStart = performance.now();
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `Backend ${selectedBackend}: ${tileWorkerCount()} workers, ${TILE_SIZE}^3 tiles, sparse skip ${ENABLE_SPARSE_TILE_SKIPPING ? 'on' : 'off'}`
          } as WorkerResponse);
          const { result: rawTiledResult, stats: tileStats } = await runTiledGeneration(
            params,
            shape,
            sphereRadius ?? msg.sphereRadius ?? 25,
            bounds,
            resolution,
            escapeHoles,
            (completed, total, timingMs, stats) => {
              postMessage({
                type: 'progress',
                progress: 0.12 + (completed / Math.max(1, total)) * 0.76,
                message: `cpu-tiled: ${completed}/${total} tiles processed, ${stats.tilesSkipped}/${stats.tilesTotal} skipped (${Math.round(timingMs)}ms worker time)`
              } as WorkerResponse);
            }
          );
          if (cancelled) throw new Error('Cancelled');
          // Tiles are extracted open along their seams and merged here, so the
          // whole-surface repair belongs after the merge rather than per tile.
          const cleanedTiles = removeDisconnectedFragments(rawTiledResult, 0.004);
          const result = { ...cleanedTiles, ...closeBoundaryLoops(cleanedTiles).result };
          if (result.removedTriangles > 0) {
            postMessage({
              type: 'progress',
              progress: 0.9,
              message: `Removed ${result.removedTriangles.toLocaleString()} disconnected fragment triangles`
            } as WorkerResponse);
          }
          postMessage({
            type: 'progress',
            progress: 0.95,
            message: `Geometry ready via ${selectedBackend} in ${Math.round(performance.now() - tiledStart)}ms (${tileStats.tilesSkipped}/${tileStats.tilesTotal} tiles skipped)`
          } as WorkerResponse);
          const response: WorkerResponse = {
            type: 'result',
            positions: result.positions,
            normals: result.normals,
            triCount: result.triCount,
            escapeHoles,
            backend: selectedBackend,
          };
          postWorkerMessage(response, generatedResultTransferList(response));
          return;
        } catch (err: unknown) {
          terminateTileWorkers();
          if (cancelled) throw new Error('Cancelled');
          const message = err instanceof Error ? err.message : 'unknown error';
          postMessage({
            type: 'progress',
            progress: 0.12,
            message: `cpu-tiled unavailable (${message}); falling back to cpu-single`
          } as WorkerResponse);
        }
      } else if (selectedBackend !== 'cpu-single') {
        postMessage({
          type: 'progress',
          progress: 0.12,
          message: `${selectedBackend} is not enabled for execution yet; falling back to cpu-single`
        } as WorkerResponse);
      }

      const initialEstimate = estimateGenerationTimings(params, resolution, !shape);
      let smoothedMarchSeconds = initialEstimate.marchSeconds;
      let estimateLabel = formatDuration(initialEstimate.preSeconds + initialEstimate.marchSeconds);
      postMessage({
        type: 'progress',
        progress: 0.12,
        message: `Estimated generation time: ~${estimateLabel}`
      } as WorkerResponse);

      // Run marching cubes
      const marchingStart = performance.now();
      const preSecondsActual = (marchingStart - generationStart) / 1000;
      const sdfToSample = surfaceHexSdf ?? sdf;
      const cells: Vec3 = [resolution, resolution, resolution];
      const spacing: Vec3 = [
        (bounds.max[0] - bounds.min[0]) / resolution,
        (bounds.max[1] - bounds.min[1]) / resolution,
        (bounds.max[2] - bounds.min[2]) / resolution,
      ];
      const field = sampleSdfField(sdfToSample, bounds, cells, (frac) => {
        if (cancelled) throw new Error('Cancelled');
        postMessage({ type: 'progress', progress: 0.12 + frac * 0.3, message: `Sampling field: ${Math.round(frac * 100)}%` } as WorkerResponse);
      });

      if (thinFilterActive) {
        // The structuring element lives on the sample grid, so a feature
        // smaller than the spacing cannot be represented. Say so rather than
        // appearing to have done something.
        const radius = params.thinSectionFilter / 2;
        if (openingIsResolvable(radius, spacing)) {
          postMessage({ type: 'progress', progress: 0.44, message: `Removing features under ${params.thinSectionFilter}mm` } as WorkerResponse);
          openField(field, [resolution + 1, resolution + 1, resolution + 1], spacing, radius);
        } else {
          const needed = Math.ceil((2 * Math.max(...spacing) / params.thinSectionFilter) * resolution);
          thinFilterSkipped = `Cannot remove features under ${params.thinSectionFilter}mm at this grid: samples are ${Math.max(...spacing).toFixed(2)}mm apart. Raise export resolution to about ${needed} or increase the threshold.`;
          postMessage({ type: 'progress', progress: 0.44, message: thinFilterSkipped } as WorkerResponse);
        }
      }

      cutEscapeHolesInField(field, bounds, cells, escapeHoles);
      sealFieldBoundary(field, cells, 0);

      const rawResult = marchingCubesFromField(field, bounds, cells, 0, (frac) => {
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
          preSecondsActual + smoothedMarchSeconds - elapsedSeconds
        );
        estimateLabel = formatDuration(remainingSeconds);
        postMessage({
          type: 'progress',
          progress: overallProgress,
          message: `Marching cubes: ${Math.round(frac * 100)}% (~${estimateLabel} remaining)`
        } as WorkerResponse);
      });

      const cleaned = removeDisconnectedFragments(rawResult, 0.004);
      const result = { ...cleaned, ...closeBoundaryLoops(cleaned).result };
      if (result.removedTriangles > 0) {
        postMessage({
          type: 'progress',
          progress: 0.84,
          message: `Removed ${result.removedTriangles.toLocaleString()} disconnected fragment triangles`
        } as WorkerResponse);
      }

      postMessage({ type: 'progress', progress: 0.95, message: 'Geometry ready' } as WorkerResponse);

      // Send generated geometry immediately. positions/normals and optional
      // surface sample buffers are transferred; validation runs separately.
      const packedSamples = packSurfaceSamples(surfaceSamples);
      const response: WorkerResponse = {
        type: 'result',
        positions: result.positions,
        normals: result.normals,
        triCount: result.triCount,
        surfaceSamplePositions: packedSamples?.positions,
        surfaceSampleNormals: packedSamples?.normals,
        surfaceSampleHoleScales: packedSamples?.holeScales,
        escapeHoles,
        thinFilterSkipped: thinFilterSkipped ?? undefined,
        backend: 'cpu-single',
      };
      postWorkerMessage(response, generatedResultTransferList(response));
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
