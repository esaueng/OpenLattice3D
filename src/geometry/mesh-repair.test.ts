// Characterization of closeBoundaryLoops: the hashes below were captured from
// the original Map/string-key implementation before it was rewritten onto
// typed-array hash tables. Any change to vertex order, fill order, fan
// winding, normals, or the report breaks them.
import { describe, expect, it } from 'vitest';
import { PARITY_FIXTURES, buildFixtureSdf, buildShapeSdf } from '../backend/fixtures';
import type { LatticeTileJob, LatticeTileResponse } from '../workers/tile-types';
import { runTiledGeneration, type TileWorkerLike } from '../workers/tiled-generation';
import { createDeterministicRandom } from './deterministic-random';
import { analyzeTopology } from './__tests__/helpers';
import {
  marchingCubesFromField,
  marchingCubesRectangular,
  sampleSdfField,
  sealFieldBoundary,
  type MarchingCubesResult,
} from './marching-cubes';
import { closeBoundaryLoops, type RepairWorkCounters } from './mesh-repair';
import type { Vec3 } from './vec3';

function digest(result: MarchingCubesResult): string {
  // FNV-1a over bytes plus an independent 32-bit word mix, so a collision in
  // one does not hide a change.
  let fnv = 2166136261;
  let mix = 0x9e3779b9;
  for (const array of [result.positions, result.normals]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i++) fnv = Math.imul((fnv ^ bytes[i]) >>> 0, 16777619) >>> 0;
    const words = new Uint32Array(array.buffer, array.byteOffset, array.length);
    for (let i = 0; i < words.length; i++) {
      mix = Math.imul(mix ^ words[i], 0x85ebca6b) >>> 0;
      mix = (mix ^ (mix >>> 13)) >>> 0;
    }
  }
  return `${result.triCount}:${fnv.toString(16)}:${mix.toString(16)}`;
}

function mesh(triangles: number[][]): MarchingCubesResult {
  const positions = new Float32Array(triangles.flat());
  return { positions, normals: new Float32Array(triangles.length * 3).fill(0.5), triCount: triangles.length };
}

function sealedSingle(index: number): MarchingCubesResult {
  const fixture = PARITY_FIXTURES[index];
  const cells: Vec3 = [fixture.resolution, fixture.resolution, fixture.resolution];
  const field = sampleSdfField(buildFixtureSdf(fixture), fixture.bounds, cells);
  sealFieldBoundary(field, cells, 0);
  return marchingCubesFromField(field, fixture.bounds, cells, 0);
}

class InlineTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;

  postMessage(job: LatticeTileJob): void {
    const sdf = buildShapeSdf(job.shape, job.sphereRadius, job.params, job.generationSeed);
    const result = marchingCubesRectangular(sdf, job.bounds, job.cells, 0);
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: job.tileId,
      positions: result.positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: { totalMs: 0, triCount: result.triCount },
    };
    this.onmessage?.({ data: response });
  }

  terminate(): void { /* inline */ }
}

async function mergedTiles(index: number): Promise<MarchingCubesResult> {
  const fixture = PARITY_FIXTURES[index];
  const { result } = await runTiledGeneration(
    fixture.params, fixture.generationSeed, fixture.shape, fixture.sphereRadius,
    fixture.bounds, fixture.resolution, () => undefined, () => false,
    { workerCount: 1, createWorker: () => new InlineTileWorker() },
  );
  return result;
}

/** A 1×1 cube missing its top face, with signed zeros mixed in. */
function openBox(): MarchingCubesResult {
  const z = -0;
  return mesh([
    [0, 0, 0, 1, 1, 0, 1, 0, 0], [z, 0, 0, 0, 1, 0, 1, 1, 0],
    [0, 0, 1, 1, 0, 1, 1, 0, 0], [0, 0, 1, 1, 0, 0, 0, 0, z],
    [0, 1, 0, 1, 1, 1, 1, 1, 0], [0, 1, 0, 0, 1, 1, 1, 1, 1],
    [0, 0, 0, 0, 1, 1, 0, 1, 0], [0, 0, 0, 0, 0, 1, 0, 1, 1],
    [1, 0, 0, 1, 1, 0, 1, 1, 1], [1, 0, 0, 1, 1, 1, 1, 0, 1],
  ]);
}

/** Two triangles meeting at one vertex: the shared vertex starts two boundary edges. */
function bowtie(): MarchingCubesResult {
  return mesh([
    [0, 0, 0, 1, 0, 0, 1, 1, 0],
    [0, 0, 0, -1, 0, 0, -1, -1, 0],
  ]);
}

/** Degenerate triangles plus an edge shared by three faces. */
function degenerateAndNonManifold(): MarchingCubesResult {
  return mesh([
    [0, 0, 0, 1, 0, 0, 0, 1, 0],
    [0, 0, 0, 0, 0, 0, 2, 2, 2],
    [1, 0, 0, 0, 0, 0, 0, 0, 1],
    [0, 0, 0, 1, 0, 0, 0, -1, 0],
    [5, 5, 5, 5, 5, 5, 5, 5, 5],
    [0, 0, 0, 1, 0, 0, 1, 1, 1],
  ]);
}

/** A height-field grid with deterministic holes, some touching diagonally. */
function perforatedGrid(size: number, seed: number): MarchingCubesResult {
  const random = createDeterministicRandom(seed, 'mesh-repair-grid');
  const height = (x: number, y: number) => Math.fround(Math.sin(x * 0.37) * Math.cos(y * 0.23));
  const triangles: number[][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (random() < 0.12) continue;
      const a = [x, y, height(x, y)], b = [x + 1, y, height(x + 1, y)];
      const c = [x + 1, y + 1, height(x + 1, y + 1)], d = [x, y + 1, height(x, y + 1)];
      triangles.push([...a, ...b, ...c], [...a, ...c, ...d]);
    }
  }
  return mesh(triangles);
}

/** Disjoint triangles with no shared vertices: every triangle is its own loop. */
function triangleSoup(count: number, seed: number): MarchingCubesResult {
  const random = createDeterministicRandom(seed, 'mesh-repair-soup');
  const triangles: number[][] = [];
  for (let i = 0; i < count; i++) {
    const x = random() * 100, y = random() * 100, z = random() * 100;
    triangles.push([x, y, z, x + 1, y, z, x, y + 1, z + random()]);
  }
  return mesh(triangles);
}

/**
 * A flat grid on exact integer coordinates. Their float bit patterns differ
 * only in the high bits, which defeats weak hash mixing. The whole outer rim
 * is one boundary loop.
 */
function integerGrid(size: number): MarchingCubesResult {
  const triangles: number[][] = [];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      triangles.push([x, y, 0, x + 1, y, 0, x + 1, y + 1, 0], [x, y, 0, x + 1, y + 1, 0, x, y + 1, 0]);
    }
  }
  return mesh(triangles);
}

/** A closed octahedron: nothing to repair. */
function octahedron(): MarchingCubesResult {
  const v = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const faces = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]];
  return mesh(faces.map((f) => f.flatMap((i) => v[i])));
}

interface Expectation {
  digest: string;
  report: { loopsClosed: number; trianglesAdded: number; loopsUnresolved: number };
}

const SYNTHETIC: Array<[string, () => MarchingCubesResult, Expectation]> = [
  ['single triangle', () => mesh([[0, 0, 0, 1, 0, 0, 0, 1, 0]]), { digest: '2:b3b7a925:7a2bcabe', report: { loopsClosed: 1, trianglesAdded: 1, loopsUnresolved: 0 } }],
  ['open box with signed zeros', openBox, { digest: '10:3d099ff5:cda4a7bb', report: { loopsClosed: 0, trianglesAdded: 0, loopsUnresolved: 1 } }],
  ['bowtie', bowtie, { digest: '3:2815a065:4dee7776', report: { loopsClosed: 1, trianglesAdded: 1, loopsUnresolved: 1 } }],
  ['degenerate and non-manifold', degenerateAndNonManifold, { digest: '8:796cb5bc:c2d91e6', report: { loopsClosed: 1, trianglesAdded: 2, loopsUnresolved: 2 } }],
  ['perforated grid', () => perforatedGrid(48, 7), { digest: '4384:c5c3b144:495d72e5', report: { loopsClosed: 124, trianglesAdded: 312, loopsUnresolved: 103 } }],
  ['triangle soup', () => triangleSoup(3000, 11), { digest: '6000:1cba97d6:706db4fb', report: { loopsClosed: 3000, trianglesAdded: 3000, loopsUnresolved: 0 } }],
  ['integer grid', () => integerGrid(40), { digest: '3358:c50efeb5:3a524e41', report: { loopsClosed: 1, trianglesAdded: 158, loopsUnresolved: 0 } }],
  ['closed octahedron', octahedron, { digest: '8:a9ed5ec5:26041865', report: { loopsClosed: 0, trianglesAdded: 0, loopsUnresolved: 0 } }],
];

const CAPTURE = process.env.CAPTURE_REPAIR_DIGESTS === '1';

function check(name: string, input: MarchingCubesResult, expected: Expectation) {
  const before = digest(input);
  const { result, report } = closeBoundaryLoops(input);
  if (CAPTURE) console.log(`${name}: digest '${digest(result)}', report ${JSON.stringify(report)}`);
  expect(digest(input)).toBe(before);
  expect(digest(result)).toBe(expected.digest);
  expect(report).toEqual(expected.report);
  if (report.trianglesAdded === 0) expect(result).toBe(input);
}

describe('closeBoundaryLoops characterization', () => {
  it.each(SYNTHETIC)('matches the captured output for %s', (name, build, expected) => {
    check(name, build(), expected);
  });

  it.each([
    ['sphere-gyroid', 0, { digest: '199608:145b3f55:44700250', report: { loopsClosed: 23, trianglesAdded: 46, loopsUnresolved: 0 } }],
    ['cube-gyroid', 1, { digest: '154872:5581e2cb:c907625a', report: { loopsClosed: 22, trianglesAdded: 44, loopsUnresolved: 0 } }],
  ] as const)('matches the captured output for sealed single-volume %s', (name, index, expected) => {
    const input = sealedSingle(index);
    check(name, input, expected);
    const topology = analyzeTopology(closeBoundaryLoops(input).result);
    expect(topology.boundaryEdges).toBe(0);
  });

  it('matches the captured output for merged sphere-gyroid tiles', async () => {
    check('tiled sphere-gyroid', await mergedTiles(0), {
      digest: '199608:51099a3d:b0581403', report: { loopsClosed: 23, trianglesAdded: 46, loopsUnresolved: 0 },
    });
  });
});

function countWork(input: MarchingCubesResult): RepairWorkCounters {
  const counters: RepairWorkCounters = { corners: 0, weldProbes: 0, edgeVisits: 0, loopSteps: 0 };
  closeBoundaryLoops(input, counters);
  return counters;
}

function totalWork(counters: RepairWorkCounters): number {
  return counters.weldProbes + counters.edgeVisits + counters.loopSteps;
}

// Operation counts rather than wall-clock: deterministic, so a regression to
// quadratic loop walking, per-bucket rescans, or clustered hashing fails here
// on any machine without flaking on a busy one.
describe('closeBoundaryLoops complexity', () => {
  it.each([
    ['perforated grid', (n: number) => perforatedGrid(n, 7)],
    ['integer grid', integerGrid],
    ['triangle soup', (n: number) => triangleSoup(n * n, 11)],
  ] as const)('does linear work on a %s', (_name, build) => {
    const small = countWork(build(48));
    const large = countWork(build(192));
    const growth = large.corners / small.corners;
    expect(growth).toBeGreaterThan(12);

    for (const counters of [small, large]) {
      // One probe per corner is perfect hashing; clustering pushes this up.
      expect(counters.weldProbes / counters.corners).toBeLessThan(2);
      // Each edge reference is visited once to count and once to classify.
      expect(counters.edgeVisits).toBeLessThanOrEqual(counters.corners * 2);
      expect(counters.loopSteps).toBeLessThanOrEqual(counters.corners);
    }
    const workGrowth = totalWork(large) / totalWork(small);
    expect(workGrowth).toBeLessThan(growth * 1.25);
  });

  it('walks a single long boundary loop once', () => {
    const size = 160;
    const counters = countWork(integerGrid(size));
    // The rim has 4 * size vertices, all in one loop.
    expect(counters.loopSteps).toBe(4 * size);
  });

  it('keeps marching-cubes welding near one probe per corner', () => {
    const counters = countWork(sealedSingle(0));
    expect(counters.corners).toBe(199562 * 3);
    expect(counters.weldProbes / counters.corners).toBeLessThan(1.5);
    expect(counters.edgeVisits).toBe(counters.corners * 2);
  });
});
