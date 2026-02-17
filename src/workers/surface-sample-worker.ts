import type { SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import { normalize } from '../geometry/vec3';
import type { SurfaceHexSample } from '../geometry/lattice';

type ShapeSampleParams = {
  radius?: number;
  halfSize?: number;
  cylRadius?: number;
  cylHalfHeight?: number;
  torusMajor?: number;
  torusTube?: number;
  capRadius?: number;
  capHalfHeight?: number;
};

type ShapeMessage = {
  mode: 'shape';
  shape: SampleShape;
  params: ShapeSampleParams;
  targetCount: number;
  minDistance: number;
};

type MeshMessage = {
  mode: 'mesh';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  keepOutTris: number[];
  targetCount: number;
  minDistance: number;
};

type WorkerMessage = ShapeMessage | MeshMessage;

type WorkerResponse = {
  positions: Float32Array;
  normals: Float32Array;
};

function triangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const ab: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = ab[1] * ac[2] - ab[2] * ac[1];
  const cy = ab[2] * ac[0] - ab[0] * ac[2];
  const cz = ab[0] * ac[1] - ab[1] * ac[0];
  return 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
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

function sampleSurfacePointForShape(shape: SampleShape, params: ShapeSampleParams): SurfaceHexSample {
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
      case 0: pos = [h, u, v]; normal = [1, 0, 0]; break;
      case 1: pos = [-h, u, v]; normal = [-1, 0, 0]; break;
      case 2: pos = [u, h, v]; normal = [0, 1, 0]; break;
      case 3: pos = [u, -h, v]; normal = [0, -1, 0]; break;
      case 4: pos = [u, v, h]; normal = [0, 0, 1]; break;
      default: pos = [u, v, -h]; normal = [0, 0, -1]; break;
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
      const y = (Math.random() * 2 - 1) * h;
      const x = r * Math.cos(theta);
      const z = r * Math.sin(theta);
      return { pos: [x, y, z], normal: normalize([x, 0, z]) };
    }
    const theta = Math.random() * 2 * Math.PI;
    const rr = Math.sqrt(Math.random()) * r;
    const x = rr * Math.cos(theta);
    const z = rr * Math.sin(theta);
    const top = pick < sideArea + capArea;
    return { pos: [x, top ? h : -h, z], normal: [0, top ? 1 : -1, 0] };
  }
  if (shape === 'torus') {
    const major = params.torusMajor ?? 20;
    const tube = params.torusTube ?? 8;
    const u = Math.random() * 2 * Math.PI;
    const v = Math.random() * 2 * Math.PI;
    const cx = (major + tube * Math.cos(v));
    const x = cx * Math.cos(u);
    const z = cx * Math.sin(u);
    const y = tube * Math.sin(v);
    const normal = normalize([Math.cos(u) * Math.cos(v), Math.sin(v), Math.sin(u) * Math.cos(v)]);
    return { pos: [x, y, z], normal };
  }
  const r = params.capRadius ?? 12;
  const h = params.capHalfHeight ?? 15;
  const cylArea = 2 * Math.PI * r * (2 * h);
  const sphereArea = 4 * Math.PI * r * r;
  const totalArea = cylArea + sphereArea;
  const pick = Math.random() * totalArea;
  if (pick < cylArea) {
    const theta = Math.random() * 2 * Math.PI;
    const y = (Math.random() * 2 - 1) * h;
    const x = r * Math.cos(theta);
    const z = r * Math.sin(theta);
    return { pos: [x, y, z], normal: normalize([x, 0, z]) };
  }
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const phi = Math.acos(2 * v - 1);
  const sx = r * Math.sin(phi) * Math.cos(theta);
  const sy = r * Math.cos(phi);
  const sz = r * Math.sin(phi) * Math.sin(theta);
  const top = Math.random() > 0.5;
  const centerY = top ? h : -h;
  return { pos: [sx, sy + centerY, sz], normal: normalize([sx, sy, sz]) };
}

function generatePoissonSamples(
  sampler: () => SurfaceHexSample,
  targetCount: number,
  minDistance: number
): SurfaceHexSample[] {
  const samples: SurfaceHexSample[] = [];
  const minDist2 = minDistance * minDistance;
  let attempts = 0;
  while (samples.length < targetCount && attempts < 6) {
    const spacing = minDistance * Math.max(0.6, 1 - attempts * 0.12);
    const spacing2 = spacing * spacing;
    const batchCount = Math.max(targetCount * 2, 128);
    for (let i = 0; i < batchCount && samples.length < targetCount; i++) {
      const cand = sampler();
      let ok = true;
      for (const s of samples) {
        const dx = s.pos[0] - cand.pos[0];
        const dy = s.pos[1] - cand.pos[1];
        const dz = s.pos[2] - cand.pos[2];
        if (dx * dx + dy * dy + dz * dz < spacing2) {
          ok = false;
          break;
        }
      }
      if (ok) samples.push(cand);
    }
    attempts++;
    if (samples.length < targetCount) {
      minDistance *= 0.9;
      if (minDistance * minDistance < minDist2 * 0.35) break;
    }
  }
  return samples;
}

function meshSamplerFromMessage(msg: MeshMessage): (() => SurfaceHexSample) | null {
  const keepOut = new Set(msg.keepOutTris);
  const areas = new Float32Array(msg.triCount);
  let totalArea = 0;
  for (let i = 0; i < msg.triCount; i++) {
    if (keepOut.has(i)) continue;
    const o = i * 9;
    const a: Vec3 = [msg.positions[o], msg.positions[o + 1], msg.positions[o + 2]];
    const b: Vec3 = [msg.positions[o + 3], msg.positions[o + 4], msg.positions[o + 5]];
    const c: Vec3 = [msg.positions[o + 6], msg.positions[o + 7], msg.positions[o + 8]];
    totalArea += triangleArea(a, b, c);
    areas[i] = totalArea;
  }
  if (totalArea <= 1e-6) return null;
  return () => {
    const triIndex = pickTriangle(areas, totalArea);
    const o = triIndex * 9;
    const a: Vec3 = [msg.positions[o], msg.positions[o + 1], msg.positions[o + 2]];
    const b: Vec3 = [msg.positions[o + 3], msg.positions[o + 4], msg.positions[o + 5]];
    const c: Vec3 = [msg.positions[o + 6], msg.positions[o + 7], msg.positions[o + 8]];
    const pos = sampleTriangle(a, b, c);
    const ni = triIndex * 3;
    const normal = normalize([msg.normals[ni], msg.normals[ni + 1], msg.normals[ni + 2]]);
    return { pos, normal };
  };
}

self.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  const sampler = msg.mode === 'shape'
    ? () => sampleSurfacePointForShape(msg.shape, msg.params)
    : meshSamplerFromMessage(msg);

  const samples = sampler ? generatePoissonSamples(sampler, msg.targetCount, msg.minDistance) : [];
  const outPos = new Float32Array(samples.length * 3);
  const outNrm = new Float32Array(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    outPos[i * 3] = samples[i].pos[0];
    outPos[i * 3 + 1] = samples[i].pos[1];
    outPos[i * 3 + 2] = samples[i].pos[2];
    outNrm[i * 3] = samples[i].normal[0];
    outNrm[i * 3 + 1] = samples[i].normal[1];
    outNrm[i * 3 + 2] = samples[i].normal[2];
  }
  const resp: WorkerResponse = { positions: outPos, normals: outNrm };
  // @ts-expect-error transfer list
  self.postMessage(resp, [outPos.buffer, outNrm.buffer]);
};
