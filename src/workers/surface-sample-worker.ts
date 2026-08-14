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

type WorkerMessage = ShapeMessage;

type WorkerResponse = {
  positions: Float32Array;
  normals: Float32Array;
};

type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

function sampleResultTransferList(response: WorkerResponse): Transferable[] {
  // Surface sample outputs are generated inside this worker and transferred
  // back to the lattice worker.
  return [response.positions.buffer, response.normals.buffer];
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
  return { pos: [sx, sy, sz + centerZ], normal: normalize([sx, sy, sz]) };
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

self.onmessage = (ev: MessageEvent<WorkerMessage>) => {
  const msg = ev.data;
  const sampler = () => sampleSurfacePointForShape(msg.shape, msg.params);
  const samples = generatePoissonSamples(sampler, msg.targetCount, msg.minDistance);
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
  postWorkerMessage(resp, sampleResultTransferList(resp));
};
