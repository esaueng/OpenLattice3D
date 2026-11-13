// Characterization of the built-in sample-shape fields. The golden hashes were
// captured from the code before the per-call-site shape SDF copies (generation
// worker, tile worker, sparse tile skipping, parity fixtures, validation) were
// consolidated into src/geometry/sample-shapes.ts and buildSampleShapeLattice.
// Every call site must keep producing bit-identical fields, bounds and meshes;
// a golden may only change together with an intentional, documented change to
// generated output. Print fresh values with
//   CAPTURE_SAMPLE_SHAPE_GOLDENS=1 npx vitest run <this file> --silent=false
import { arch } from 'node:os';
import { describe, expect, it } from 'vitest';
import { buildShapeSdf } from '../backend/fixtures';
import { buildSampleShapeLattice } from '../geometry/lattice';
import { marchingCubesRectangular, type MarchingCubesResult } from '../geometry/marching-cubes';
import { sampleShapeBounds, sampleShapeObjectSdf } from '../geometry/sample-shapes';
import type { Vec3 } from '../geometry/vec3';
import { DEFAULT_PARAMS, type LatticeParams, type SampleShape } from '../types/project';
import type { LatticeTileJob, LatticeTileResponse } from './tile-types';
import { runTiledGeneration, type TileWorkerLike } from './tiled-generation';
import { sampleShapeFields } from './validation-core';

const SHAPES: SampleShape[] = ['sphere', 'cube', 'cylinder', 'torus', 'capsule'];
const SEED = 1234;
const SPHERE_RADIUS = 22;

function fnv(values: Float64Array | Float32Array): string {
  let value = 2166136261;
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  return value.toString(16).padStart(8, '0');
}

/** A deterministic, deliberately non-lattice-aligned grid covering every shape. */
function gridPoints(): Vec3[] {
  const points: Vec3[] = [];
  const n = 11;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      for (let k = 0; k < n; k++) {
        points.push([
          -33.3 + i * 6.71,
          -31.7 + j * 6.37,
          -36.1 + k * 7.13,
        ]);
      }
    }
  }
  // Points exactly on surfaces, axes and edges, where clamps and maxima switch.
  points.push([0, 0, 0], [15, 0, 0], [15, 15, 15], [0, 15, 20], [28, 0, 0], [0, 0, 27], [12, 0, 15], [22, 0, 0]);
  return points;
}

function fieldHash(sdf: (x: number, y: number, z: number) => number): string {
  const points = gridPoints();
  const values = new Float64Array(points.length);
  points.forEach(([x, y, z], index) => { values[index] = sdf(x, y, z); });
  return fnv(values);
}

function meshHash(result: MarchingCubesResult): string {
  return `${result.triCount}:${fnv(result.positions)}:${fnv(result.normals)}`;
}

const LATTICE_PARAMS: Array<[string, LatticeParams]> = [
  ['gyroid-shell', { ...DEFAULT_PARAMS, latticeType: 'gyroid' }],
  ['bcc-noShell', { ...DEFAULT_PARAMS, latticeType: 'bcc', noShell: true }],
  ['voronoi-surface', { ...DEFAULT_PARAMS, latticeType: 'voronoi', surfaceOnly: true }],
];

// Frozen copies of the pre-consolidation call-site code, kept to show the
// shared implementations are drop-in replacements.

// Bounds as lattice-worker.ts computed them.
function legacyWorkerBounds(shape: SampleShape, sphereRadiusInput: number, pad: number): { min: Vec3; max: Vec3 } {
  switch (shape) {
    case 'sphere': {
      const R = sphereRadiusInput || 25;
      return { min: [-(R + pad), -(R + pad), -(R + pad)], max: [R + pad, R + pad, R + pad] };
    }
    case 'cube': {
      const h = 15;
      return { min: [-(h + pad), -(h + pad), -(h + pad)], max: [h + pad, h + pad, h + pad] };
    }
    case 'cylinder': {
      const cr = 15, ch = 20;
      return { min: [-cr - pad, -cr - pad, -ch - pad], max: [cr + pad, cr + pad, ch + pad] };
    }
    case 'torus': {
      const mR = 20, tR = 8;
      const xy = mR + tR + pad;
      return { min: [-xy, -xy, -(tR + pad)], max: [xy, xy, tR + pad] };
    }
    case 'capsule': {
      const capR = 12, capHH = 15;
      const capExt = capHH + capR + pad;
      return { min: [-(capR + pad), -(capR + pad), -capExt], max: [capR + pad, capR + pad, capExt] };
    }
  }
}

// Object SDFs as lattice-worker.ts inlined them.
function legacyWorkerObjectSdf(shape: SampleShape, sphereRadiusInput: number): (x: number, y: number, z: number) => number {
  switch (shape) {
    case 'sphere': {
      const R = sphereRadiusInput || 25;
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - R;
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
      const cr = 15, ch = 20;
      return (x, y, z) => {
        const dRadial = Math.sqrt(x * x + y * y) - cr;
        const dAxial = Math.abs(z) - ch;
        const outside = Math.sqrt(Math.max(dRadial, 0) ** 2 + Math.max(dAxial, 0) ** 2);
        const inside = Math.min(Math.max(dRadial, dAxial), 0);
        return outside + inside;
      };
    }
    case 'torus': {
      const mR = 20, tR = 8;
      return (x, y, z) => {
        const qx = Math.sqrt(x * x + y * y) - mR;
        return Math.sqrt(qx * qx + z * z) - tR;
      };
    }
    case 'capsule': {
      const capR = 12, capHH = 15;
      return (x, y, z) => {
        const cz = Math.max(-capHH, Math.min(capHH, z));
        return Math.sqrt(x * x + y * y + (z - cz) * (z - cz)) - capR;
      };
    }
  }
}

// Object SDFs as tiled-generation.ts wrote them for sparse tile skipping. The
// same shapes and dimensions, but via Math.hypot, which rounds differently
// from Math.sqrt of the summed squares.
function legacyTiledObjectSdf(shape: SampleShape, sphereRadius: number): (x: number, y: number, z: number) => number {
  switch (shape) {
    case 'sphere': {
      const radius = sphereRadius || 25;
      return (x, y, z) => Math.sqrt(x * x + y * y + z * z) - radius;
    }
    case 'cube':
      return (x, y, z) => {
        const dx = Math.abs(x) - 15;
        const dy = Math.abs(y) - 15;
        const dz = Math.abs(z) - 15;
        return Math.hypot(Math.max(dx, 0), Math.max(dy, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dy, dz), 0);
      };
    case 'cylinder':
      return (x, y, z) => {
        const radial = Math.hypot(x, y) - 15;
        const axial = Math.abs(z) - 20;
        return Math.hypot(Math.max(radial, 0), Math.max(axial, 0)) + Math.min(Math.max(radial, axial), 0);
      };
    case 'torus':
      return (x, y, z) => Math.hypot(Math.hypot(x, y) - 20, z) - 8;
    case 'capsule':
      return (x, y, z) => Math.hypot(x, y, z - Math.max(-15, Math.min(15, z))) - 12;
  }
}

class ComputingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly jobs: LatticeTileJob[];
  constructor(jobs: LatticeTileJob[]) { this.jobs = jobs; }

  postMessage(job: LatticeTileJob): void {
    this.jobs.push(job);
    // Mirrors lattice-tile-worker.ts, which evaluates the same fixture field.
    const result = marchingCubesRectangular(
      buildShapeSdf(job.shape, job.sphereRadius, job.params, job.generationSeed),
      job.bounds,
      job.cells,
      0,
    );
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: job.tileId,
      positions: result.positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: { totalMs: 1, triCount: result.triCount },
    };
    queueMicrotask(() => this.onmessage?.({ data: response }));
  }

  terminate(): void {}
}

class RecordingTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private readonly jobs: LatticeTileJob[];
  constructor(jobs: LatticeTileJob[]) { this.jobs = jobs; }

  postMessage(job: LatticeTileJob): void {
    this.jobs.push(job);
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: job.tileId,
      positions: new Float32Array(0),
      normals: new Float32Array(0),
      triCount: 0,
      timing: { totalMs: 1, triCount: 0 },
    };
    queueMicrotask(() => this.onmessage?.({ data: response }));
  }

  terminate(): void {}
}

function jobsHash(jobs: LatticeTileJob[]): string {
  const sorted = [...jobs].sort((a, b) => a.tileId - b.tileId);
  const values = new Float64Array(sorted.length * 10);
  sorted.forEach((job, index) => {
    values.set([job.tileId, ...job.cells, ...job.bounds.min, ...job.bounds.max], index * 10);
  });
  return fnv(values);
}

// Golden values captured from the pre-consolidation code (see file header).
// V8's x64 and arm64 floating-point implementations give different low bits
// in some gyroid field samples. Both sets were captured on the original code.
const GOLDEN_FIELDS: Record<string, string> = {
  'sphere/gyroid-shell': 'cd78672d',
  'sphere/bcc-noShell': 'dfab840a',
  'sphere/voronoi-surface': '4d0c0146',
  'sphere/object': '02da8411',
  'cube/gyroid-shell': '0c933513',
  'cube/bcc-noShell': '33eb109b',
  'cube/voronoi-surface': '20938245',
  'cube/object': '7a29450b',
  'cylinder/gyroid-shell': 'd80fe747',
  'cylinder/bcc-noShell': '0d727b93',
  'cylinder/voronoi-surface': 'd0c8948b',
  'cylinder/object': 'bfd3909a',
  'torus/gyroid-shell': 'f65c8081',
  'torus/bcc-noShell': '67e4dd22',
  'torus/voronoi-surface': '400ce84d',
  'torus/object': '5219051a',
  'capsule/gyroid-shell': 'c7ee7b74',
  'capsule/bcc-noShell': 'c0ee38b2',
  'capsule/voronoi-surface': 'ed917977',
  'capsule/object': '56f61b5f',
};
const ARM64_GYROID_FIELDS: Record<string, string> = {
  'sphere/gyroid-shell': 'd43c2467',
  'cube/gyroid-shell': '9d4aab9d',
  'cylinder/gyroid-shell': 'c340a5cb',
  'capsule/gyroid-shell': '811e34a2',
};
const GOLDEN_BOUNDS: Record<string, string> = {
  'sphere/22/1.5': '49507d65',
  'sphere/0/2.5': '3e29e865',
  'sphere/25/0.3': '4034b265',
  'cube/22/1.5': 'c97f75c5',
  'cube/0/2.5': '74025125',
  'cube/25/0.3': '25a45dfd',
  'cylinder/22/1.5': '72356de5',
  'cylinder/0/2.5': 'dd814705',
  'cylinder/25/0.3': '991c6fbd',
  'torus/22/1.5': 'b10475e5',
  'torus/0/2.5': '2d08f165',
  'torus/25/0.3': '6a577379',
  'capsule/22/1.5': '3c0eb245',
  'capsule/0/2.5': 'c2ed6625',
  'capsule/25/0.3': 'cfaab7bd',
};
const GOLDEN_TILED: Record<string, string> = {
  'sphere': '125/1/124:00fc89f4:463592:d974b931:249d565b',
  'cube': '125/1/124:95ce6270:697112:ef527689:d7b010ad',
  'cylinder': '125/0/125:848d17f3:603854:b0c3160c:3086bcbc',
  'torus': '125/0/125:c76cbfd3:641976:329a152a:c00e4047',
  'capsule': '125/0/125:90c34457:519320:f4b5bd4f:94a95b01',
};
const GOLDEN_SWEEP: Record<string, string> = {
  'sphere': '2376:1f678083',
  'cube': '1551:08c0ee1a',
  'cylinder': '1820:b23112ad',
  'torus': '1906:3d79b305',
  'capsule': '2013:b64da37e',
};

const capture = process.env.CAPTURE_SAMPLE_SHAPE_GOLDENS === '1';
const captured: Record<string, Record<string, string>> = { fields: {}, bounds: {}, tiled: {}, sweep: {} };

describe('sample-shape characterization', () => {
  describe.each(SHAPES)('%s', (shape) => {
    it.each(LATTICE_PARAMS)('keeps the %s lattice field bit-identical at every call site', (name, params) => {
      const key = `${shape}/${name}`;
      // Parity fixtures and the tile worker, validation, and the generation worker.
      const fixture = fieldHash(buildShapeSdf(shape, SPHERE_RADIUS, params, SEED));
      const validation = fieldHash(sampleShapeFields(shape, SPHERE_RADIUS, SEED).latticeSdf(params));
      const generation = fieldHash(buildSampleShapeLattice(shape, SPHERE_RADIUS, params, SEED));
      expect(validation).toBe(fixture);
      expect(generation).toBe(fixture);
      if (capture) captured.fields[key] = fixture;
      else {
        const arm64Hash = arch() === 'arm64' ? ARM64_GYROID_FIELDS[key] : undefined;
        expect(fixture).toBe(arm64Hash ?? GOLDEN_FIELDS[key]);
      }
    });

    it('keeps the object field bit-identical', () => {
      const key = `${shape}/object`;
      const hash = fieldHash(sampleShapeFields(shape, SPHERE_RADIUS, SEED).objectSdf);
      expect(fieldHash(sampleShapeObjectSdf(shape, SPHERE_RADIUS))).toBe(hash);
      expect(fieldHash(legacyWorkerObjectSdf(shape, SPHERE_RADIUS))).toBe(hash);
      if (capture) captured.fields[key] = hash;
      else expect(hash).toBe(GOLDEN_FIELDS[key]);
    });

    it('matches the former Math.hypot sparse-skip SDF to within rounding', () => {
      const shared = sampleShapeObjectSdf(shape, SPHERE_RADIUS);
      const legacy = legacyTiledObjectSdf(shape, SPHERE_RADIUS);
      let maxDifference = 0;
      for (const [x, y, z] of gridPoints()) {
        const a = shared(x, y, z);
        const b = legacy(x, y, z);
        expect(Math.sign(a)).toBe(Math.sign(b));
        maxDifference = Math.max(maxDifference, Math.abs(a - b));
      }
      // A few ulps at ~50 mm magnitudes.
      expect(maxDifference).toBeLessThan(1e-12);
    });

    it('keeps the generation bounds bit-identical', () => {
      for (const [radius, pad] of [[SPHERE_RADIUS, 1.5], [0, 2.5], [25, 0.3]] as const) {
        const key = `${shape}/${radius}/${pad}`;
        const legacy = legacyWorkerBounds(shape, radius, pad);
        const shared = sampleShapeBounds(shape, radius, pad);
        expect(shared).toEqual(legacy);
        const hash = fnv(new Float64Array([...shared.min, ...shared.max]));
        expect(fnv(new Float64Array([...legacy.min, ...legacy.max]))).toBe(hash);
        if (capture) captured.bounds[key] = hash;
        else expect(hash).toBe(GOLDEN_BOUNDS[key]);
      }
    });

    it('keeps tiled sparse skipping and the merged mesh bit-identical', async () => {
      const params: LatticeParams = { ...DEFAULT_PARAMS, latticeType: 'gyroid', cellSize: 6, surfaceOnly: true, surfaceDepth: 2 };
      const bounds = sampleShapeBounds(shape, SPHERE_RADIUS, params.cellSize * 0.5);
      const jobs: LatticeTileJob[] = [];
      const { result, stats } = await runTiledGeneration(
        params, SEED, shape, SPHERE_RADIUS, bounds, 160,
        () => undefined, () => false,
        { workerCount: 3, createWorker: () => new ComputingTileWorker(jobs) },
      );
      const hash = `${stats.tilesTotal}/${stats.tilesSkipped}/${stats.tilesProcessed}:${jobsHash(jobs)}:${meshHash(result)}`;
      if (capture) captured.tiled[shape] = hash;
      else expect(hash).toBe(GOLDEN_TILED[shape]);
    });

    it('keeps every sparse tile-skip decision across a sweep of grids', async () => {
      const parts: string[] = [];
      for (const surfaceOnly of [false, true]) {
        for (const cellSize of [2, 5, 11]) {
          for (const scale of [1, 1.7, 3.1]) {
            for (const resolution of [96, 224]) {
              const params: LatticeParams = { ...DEFAULT_PARAMS, latticeType: 'gyroid', cellSize, surfaceOnly, surfaceDepth: 1.2 };
              const base = sampleShapeBounds(shape, SPHERE_RADIUS, cellSize * 0.5);
              const bounds = {
                min: base.min.map((value) => value * scale) as Vec3,
                max: base.max.map((value) => value * scale * 0.93) as Vec3,
              };
              const jobs: LatticeTileJob[] = [];
              const { stats } = await runTiledGeneration(
                params, SEED, shape, SPHERE_RADIUS, bounds, resolution,
                () => undefined, () => false,
                { workerCount: 2, createWorker: () => new RecordingTileWorker(jobs) },
              );
              parts.push(`${stats.tilesTotal}/${stats.tilesSkipped}:${jobsHash(jobs)}`);
            }
          }
        }
      }
      const skipped = parts.reduce((sum, part) => sum + Number(part.split('/')[1].split(':')[0]), 0);
      expect(skipped).toBeGreaterThan(0);
      const hash = `${skipped}:${fnv(new Float64Array(parts.flatMap((part) => [...part].map((c) => c.charCodeAt(0)))))}`;
      if (capture) captured.sweep[shape] = hash;
      else expect(hash).toBe(GOLDEN_SWEEP[shape]);
    });
  });

  it.runIf(capture)('prints captured goldens', () => {
    console.log(`GOLDENS ${JSON.stringify(captured)}`);
  });
});
