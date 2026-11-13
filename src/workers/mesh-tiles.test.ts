import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MeshBVH } from '../geometry/bvh';
import { cutEscapeHolesInField } from '../geometry/escape-holes';
import {
  marchingCubesFromField,
  sampleSdfField,
  sealFieldBoundary,
  type MarchingCubesResult,
} from '../geometry/marching-cubes';
import { generateCubeMesh, generateSphereMesh } from '../geometry/mesh-analysis';
import { closeBoundaryLoops, closeExtractedBoundaryLoops, type RepairWorkCounters } from '../geometry/mesh-repair';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { Vec3 } from '../geometry/vec3';
import { DEFAULT_PARAMS, type LatticeParams } from '../types/project';
import { prepareStl } from './model-intake';
import {
  buildImportedMeshSdf,
  computeMeshTile,
  createMeshTileContext,
  planMeshTiles,
  signIsReliableForSkipping,
  type MeshTileContext,
} from './mesh-tiles';
import type { LatticeTileResponse, LatticeTileResult, TileWorkerMessage } from './tile-types';
import { runMeshTiledGeneration, TILE_SIZE, type TileWorkerLike } from './tiled-generation';
import { failureCause } from '../utils/failure-cause';

/** A sample STL as generation receives it: after intake orientation and repair. */
function loadStl(name: string): TriangleMesh {
  const source = readFileSync(new URL(`../../public/assets/${name}`, import.meta.url));
  const buffer = source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength) as ArrayBuffer;
  return prepareStl(buffer, name).mesh;
}

/** Padded generation bounds, computed as lattice-worker computes them. */
function generationBounds(mesh: TriangleMesh, params: LatticeParams): { min: Vec3; max: Vec3 } {
  const mn: Vec3 = [Infinity, Infinity, Infinity];
  const mx: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let d = 0; d < 3; d++) {
      if (mesh.positions[i + d] < mn[d]) mn[d] = mesh.positions[i + d];
      if (mesh.positions[i + d] > mx[d]) mx[d] = mesh.positions[i + d];
    }
  }
  const pad = params.cellSize * 0.5;
  return { min: [mn[0] - pad, mn[1] - pad, mn[2] - pad], max: [mx[0] + pad, mx[1] + pad, mx[2] + pad] };
}

interface Case {
  mesh: TriangleMesh;
  params: LatticeParams;
  seed: number;
  keepOutTris: number[];
  keepInTris: number[];
  resolution: number;
}

/**
 * The cpu-single imported-mesh sequence from lattice-worker.ts (tiling is
 * disabled under thin-section filtering, so no opening step): sample, cut
 * escape holes into the field, seal the grid boundary, extract.
 */
function singleWorkerRaw(c: Case, vertexIds = false): MarchingCubesResult {
  const bvh = new MeshBVH(c.mesh.positions, c.mesh.normals, c.mesh.triCount);
  const sdf = buildImportedMeshSdf(bvh, c.params, c.seed, c.keepOutTris, c.keepInTris);
  const bounds = generationBounds(c.mesh, c.params);
  const cells: Vec3 = [c.resolution, c.resolution, c.resolution];
  const field = sampleSdfField(sdf, bounds, cells);
  cutEscapeHolesInField(field, bounds, cells, c.params);
  sealFieldBoundary(field, cells, 0);
  return marchingCubesFromField(field, bounds, cells, 0, undefined, { vertexIds });
}

function newCounters(): RepairWorkCounters {
  return { corners: 0, weldProbes: 0, edgeVisits: 0, loopSteps: 0 };
}

/**
 * Behaves like lattice-tile-worker.ts for mesh runs: messages are structured
 * clones (shared buffers stay shared, transferred ones move), replies arrive
 * asynchronously and out of tile order.
 */
class MeshTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private context: MeshTileContext | null = null;
  private terminated = false;
  /** Rewrites a response before it is sent, to model dropped or corrupt ids. */
  private readonly edit?: (response: LatticeTileResult) => void;
  constructor(edit?: (response: LatticeTileResult) => void) { this.edit = edit; }

  postMessage(message: TileWorkerMessage, transfer: Transferable[] = []): void {
    const msg = structuredClone(message, { transfer });
    if (msg.type === 'mesh-init') {
      this.context = createMeshTileContext(msg);
      return;
    }
    if (msg.type !== 'mesh-tile') throw new Error('unexpected job');
    const result = computeMeshTile(this.context!, msg);
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: msg.tileId,
      positions: result.positions.slice(),
      normals: result.normals,
      triCount: result.triCount,
      rowTriangleStarts: result.rowTriangleStarts,
      ...(result.vertexIds ? { vertexIds: result.vertexIds.ids.slice() } : {}),
      timing: { totalMs: 1, triCount: result.triCount },
    };
    this.edit?.(response);
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: structuredClone(response) });
    }, (7 - msg.tileId % 8) % 4);
  }

  terminate(): void { this.terminated = true; }
}

async function tiledRaw(
  c: Case,
  workerCount: number,
  shareMemory: boolean,
  edit?: (response: LatticeTileResult) => void,
) {
  const bvh = new MeshBVH(c.mesh.positions, c.mesh.normals, c.mesh.triCount);
  return runMeshTiledGeneration(
    {
      bvh,
      params: c.params,
      fieldParams: c.params,
      generationSeed: c.seed,
      keepOutTris: c.keepOutTris,
      keepInTris: c.keepInTris,
      bounds: generationBounds(c.mesh, c.params),
      resolution: c.resolution,
    },
    () => undefined,
    () => false,
    { workerCount, shareMemory, createWorker: () => new MeshTileWorker(edit) },
  );
}

function bytesEqual(a: MarchingCubesResult, b: MarchingCubesResult): boolean {
  if (a.triCount !== b.triCount) return false;
  const pairs: [Float32Array, Float32Array][] = [
    [a.positions.subarray(0, a.triCount * 9), b.positions.subarray(0, b.triCount * 9)],
    [a.normals.subarray(0, a.triCount * 3), b.normals.subarray(0, b.triCount * 3)],
  ];
  for (const [x, y] of pairs) {
    const xb = new Uint32Array(x.buffer, x.byteOffset, x.length);
    const yb = new Uint32Array(y.buffer, y.byteOffset, y.length);
    for (let i = 0; i < xb.length; i++) if (xb[i] !== yb[i]) return false;
  }
  return true;
}

/** Triangles whose centroid satisfies a predicate: a deterministic painted region. */
function paint(mesh: TriangleMesh, predicate: (c: Vec3) => boolean): number[] {
  const picked: number[] = [];
  for (let t = 0; t < mesh.triCount; t++) {
    const o = t * 9;
    const c: Vec3 = [
      (mesh.positions[o] + mesh.positions[o + 3] + mesh.positions[o + 6]) / 3,
      (mesh.positions[o + 1] + mesh.positions[o + 4] + mesh.positions[o + 7]) / 3,
      (mesh.positions[o + 2] + mesh.positions[o + 5] + mesh.positions[o + 8]) / 3,
    ];
    if (predicate(c)) picked.push(t);
  }
  return picked;
}

const sphere = loadStl('sphere-25mm.stl');
const cube = loadStl('cube-30mm.stl');
const masks = {
  keepOutTris: paint(sphere, (c) => c[2] > 16),
  keepInTris: paint(sphere, (c) => c[0] > 15),
};

describe('tiled imported-mesh generation', () => {
  it.each([
    ['without region masks', { keepOutTris: [], keepInTris: [] }],
    ['with keep-in and keep-out masks', masks],
  ] as const)('matches the single-worker path byte for byte with 1, 2 and 8 workers %s', async (_label, regions) => {
    expect(masks.keepOutTris.length).toBeGreaterThan(0);
    expect(masks.keepInTris.length).toBeGreaterThan(0);
    const c: Case = {
      mesh: sphere,
      params: { ...DEFAULT_PARAMS },
      seed: 0x5eed,
      keepOutTris: [...regions.keepOutTris],
      keepInTris: [...regions.keepInTris],
      resolution: 72,
    };
    // The single-worker path as lattice-worker.ts runs it, with grid ids.
    const single = singleWorkerRaw(c, true);
    expect(single.triCount).toBeGreaterThan(10_000);
    expect(single.vertexIds?.ids.length).toBe(single.triCount * 3);
    // Reference: the position-hash weld on the single-worker soup.
    const hashCounters = newCounters();
    const singleClean = closeBoundaryLoops(single, hashCounters).result;
    expect(hashCounters.gridIdCorners).toBeUndefined();

    // Ids are consumed by the cleanup, which must not hand them on.
    const singleCounters = newCounters();
    const singleIdClean = closeExtractedBoundaryLoops(single, singleCounters).result;
    expect(singleCounters.gridIdCorners).toBe(single.triCount * 3);
    expect(singleIdClean.vertexIds).toBeUndefined();
    expect(bytesEqual(singleIdClean, singleClean), 'single worker, id weld').toBe(true);

    for (const [workerCount, shareMemory] of [[1, false], [2, true], [8, false], [8, true]] as const) {
      const { result, stats } = await tiledRaw(c, workerCount, shareMemory);
      expect(stats.sparseSkipping).toBe(true);
      expect(stats.tilesSkipped).toBeGreaterThan(0);
      expect(stats.tilesProcessed + stats.tilesSkipped).toBe(stats.tilesTotal);
      expect(bytesEqual(result, single), `raw soup, ${workerCount} workers`).toBe(true);
      // Merged tile ids are the whole-grid ids, reference for reference.
      expect(result.vertexIds?.gridCells).toEqual([c.resolution, c.resolution, c.resolution]);
      const ids = result.vertexIds!.ids;
      const singleIds = single.vertexIds!.ids;
      expect(ids.length === singleIds.length && ids.every((id, i) => id === singleIds[i])).toBe(true);
      const counters = newCounters();
      const cleaned = closeExtractedBoundaryLoops(result, counters).result;
      expect(counters.gridIdCorners, `id weld taken, ${workerCount} workers`).toBe(result.triCount * 3);
      expect(cleaned.vertexIds).toBeUndefined();
      expect(bytesEqual(cleaned, singleClean), `cleaned, ${workerCount} workers`).toBe(true);
      expect(bytesEqual(closeBoundaryLoops(result).result, singleClean), `hash weld, ${workerCount} workers`).toBe(true);
    }
  });

  it('merges no ids, and still matches, when any tile returns none', async () => {
    const c: Case = {
      mesh: sphere,
      params: { ...DEFAULT_PARAMS },
      seed: 0x5eed,
      keepOutTris: [],
      keepInTris: [],
      resolution: 72,
    };
    const singleClean = closeBoundaryLoops(singleWorkerRaw(c)).result;
    const { result } = await tiledRaw(c, 2, true, (response) => {
      if (response.tileId === 3) delete response.vertexIds;
    });
    expect(result.vertexIds).toBeUndefined();
    const counters = newCounters();
    const cleaned = closeExtractedBoundaryLoops(result, counters).result;
    expect(counters.gridIdCorners).toBeUndefined();
    expect(bytesEqual(cleaned, singleClean)).toBe(true);
  });

  it('rejects tile ids that do not match the tile positions', async () => {
    const c: Case = {
      mesh: sphere,
      params: { ...DEFAULT_PARAMS },
      seed: 1,
      keepOutTris: [],
      keepInTris: [],
      resolution: 40,
    };
    for (const corrupt of [
      (response: LatticeTileResult) => { response.vertexIds = response.vertexIds!.subarray(1); },
      (response: LatticeTileResult) => { response.vertexIds = new Int32Array(response.vertexIds!) as unknown as Uint32Array; },
    ]) {
      const error = await tiledRaw(c, 2, false, (response) => {
        if (response.tileId === 1) corrupt(response);
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/malformed response/);
      expect(failureCause(error)).toBe('worker');
    }
  });

  it.each([
    ['bcc struts with escape holes and graded density', sphere, {
      latticeType: 'bcc', escapeHoles: true, escapeHoleCount: 3, gradientEnabled: true, gradientStrength: 0.8,
    }, masks],
    ['surface-only schwarzP band', sphere, { latticeType: 'schwarzP', surfaceOnly: true, surfaceDepth: 4 }, masks],
    ['no-shell octet in a sharp-cornered cube', cube, { latticeType: 'octet', noShell: true, cellSize: 6 }, null],
    ['implicit-conformal diamond', sphere, { latticeType: 'diamond', variant: 'implicit_conformal' }, null],
  ] as const)('matches the single-worker path for %s', async (_label, mesh, overrides, regions) => {
    const c: Case = {
      mesh,
      params: { ...DEFAULT_PARAMS, ...overrides } as LatticeParams,
      seed: 99,
      keepOutTris: regions ? [...regions.keepOutTris] : [],
      keepInTris: regions ? [...regions.keepInTris] : [],
      resolution: 66,
    };
    const single = singleWorkerRaw(c);
    expect(single.triCount).toBeGreaterThan(1000);
    const { result } = await tiledRaw(c, 3, true);
    expect(bytesEqual(result, single)).toBe(true);
    const counters = newCounters();
    const cleaned = closeExtractedBoundaryLoops(result, counters).result;
    expect(counters.gridIdCorners).toBe(result.triCount * 3);
    expect(bytesEqual(cleaned, closeBoundaryLoops(single).result)).toBe(true);
  });
});

describe('imported-mesh sparse tile skipping', () => {
  it('only skips tiles whose sampled field is positive everywhere, inside and outside', () => {
    const params: LatticeParams = { ...DEFAULT_PARAMS, surfaceOnly: true, surfaceDepth: 3, cellSize: 4 };
    const bvh = new MeshBVH(sphere.positions, sphere.normals, sphere.triCount);
    const bounds = generationBounds(sphere, params);
    const resolution = 160;
    const plan = planMeshTiles({
      bvh,
      serialized: bvh.serialize(),
      params,
      bounds,
      resolution,
      tileSize: 16,
      hasKeepOut: true,
      hasKeepIn: true,
      enableSparseSkipping: true,
    });
    const processed = new Set(plan.jobs.map((job) => job.origin.join(',')));
    const sdf = buildImportedMeshSdf(bvh, params, 1, masks.keepOutTris, masks.keepInTris);
    const spacing = (bounds.max[0] - bounds.min[0]) / resolution;
    let insideSkipped = 0;
    let outsideSkipped = 0;
    for (let z = 0; z < resolution; z += 16) {
      for (let y = 0; y < resolution; y += 16) {
        for (let x = 0; x < resolution; x += 16) {
          if (processed.has(`${x},${y},${z}`)) continue;
          const at = (i: number, j: number, k: number): Vec3 => [
            bounds.min[0] + (x + i) * spacing,
            bounds.min[1] + (y + j) * spacing,
            bounds.min[2] + (z + k) * spacing,
          ];
          if (bvh.signedDistance(at(8, 8, 8)) < 0) insideSkipped++;
          else outsideSkipped++;
          // Every other sample of the window, including all eight corners.
          for (let k = 0; k <= 16; k += 2) {
            for (let j = 0; j <= 16; j += 2) {
              for (let i = 0; i <= 16; i += 2) {
                const p = at(i, j, k);
                const value = sdf(p[0], p[1], p[2]);
                if (!(value > 0)) expect.fail(`skipped tile ${x},${y},${z} has material at ${p}: ${value}`);
              }
            }
          }
        }
      }
    }
    expect(insideSkipped).toBeGreaterThan(0);
    expect(outsideSkipped).toBeGreaterThan(0);
    expect(plan.stats.tilesSkipped).toBe(insideSkipped + outsideSkipped);
  });

  it('keeps every tile of an open mesh or of overlapping shells', () => {
    const open = new MeshBVH(sphere.positions.subarray(9), sphere.normals.subarray(3), sphere.triCount - 1);
    expect(signIsReliableForSkipping(open.serialize())).toBe(false);
    const closed = new MeshBVH(sphere.positions, sphere.normals, sphere.triCount);
    expect(signIsReliableForSkipping(closed.serialize())).toBe(true);

    const twoShells = (offset: number) => {
      const positions = new Float32Array(sphere.triCount * 18);
      positions.set(sphere.positions.subarray(0, sphere.triCount * 9));
      for (let i = 0; i < sphere.triCount * 9; i++) {
        positions[sphere.triCount * 9 + i] = sphere.positions[i] + (i % 3 === 0 ? offset : 0);
      }
      const normals = new Float32Array(sphere.triCount * 6);
      return new MeshBVH(positions, normals, sphere.triCount * 2).serialize();
    };
    expect(signIsReliableForSkipping(twoShells(20))).toBe(false);
    expect(signIsReliableForSkipping(twoShells(80))).toBe(true);

    // A generated UV sphere (exactly welded) is closed and oriented.
    const uvSphere = generateSphereMesh(20, 24);
    expect(signIsReliableForSkipping(
      new MeshBVH(uvSphere.positions, uvSphere.normals, uvSphere.triCount).serialize(),
    )).toBe(true);

    // A float seam is bridged on a smooth surface but not across a 90-degree
    // cube edge, where one side's pseudonormal no longer decides the sign.
    const crackedCube = generateCubeMesh(20);
    expect(signIsReliableForSkipping(
      new MeshBVH(crackedCube.positions, crackedCube.normals, crackedCube.triCount).serialize(),
    )).toBe(true);
    crackedCube.positions[0] += 1e-6;
    expect(signIsReliableForSkipping(
      new MeshBVH(crackedCube.positions, crackedCube.normals, crackedCube.triCount).serialize(),
    )).toBe(false);

    const bvh = new MeshBVH(sphere.positions.subarray(9), sphere.normals.subarray(3), sphere.triCount - 1);
    const plan = planMeshTiles({
      bvh,
      serialized: bvh.serialize(),
      params: DEFAULT_PARAMS,
      bounds: generationBounds(sphere, DEFAULT_PARAMS),
      resolution: 96,
      tileSize: TILE_SIZE,
      hasKeepOut: false,
      hasKeepIn: false,
      enableSparseSkipping: true,
    });
    expect(plan.sparseSkipping).toBe(false);
    expect(plan.stats.tilesSkipped).toBe(0);
    expect(plan.jobs.length).toBe(27);
  });
});
