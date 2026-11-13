// Rotated and stretched lattices are part of the field builders, so tiled and
// single-worker generation must agree on them exactly like they do for
// axis-aligned lattices.
import { describe, expect, it } from 'vitest';
import { MeshBVH } from '../geometry/bvh';
import { cutEscapeHolesInField } from '../geometry/escape-holes';
import { buildSampleShapeLattice } from '../geometry/lattice';
import {
  marchingCubesFromField,
  marchingCubesRectangular,
  sampleSdfField,
  sealFieldBoundary,
  type MarchingCubesResult,
} from '../geometry/marching-cubes';
import { generateSphereMesh } from '../geometry/mesh-analysis';
import type { Vec3 } from '../geometry/vec3';
import { DEFAULT_PARAMS, type LatticeParams } from '../types/project';
import { buildImportedMeshSdf, computeMeshTile, createMeshTileContext, type MeshTileContext } from './mesh-tiles';
import type { LatticeTileJob, LatticeTileResponse, TileWorkerMessage } from './tile-types';
import { runMeshTiledGeneration, runTiledGeneration, type TileWorkerLike } from './tiled-generation';

function hash(result: MarchingCubesResult): string {
  let value = 2166136261;
  for (const array of [result.positions.subarray(0, result.triCount * 9), result.normals.subarray(0, result.triCount * 3)]) {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (const byte of bytes) value = Math.imul((value ^ byte) >>> 0, 16777619) >>> 0;
  }
  return `${result.triCount}:${value.toString(16)}`;
}

/** Mirrors lattice-tile-worker.ts for sample shapes; replies out of tile order. */
class ShapeTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  postMessage(message: LatticeTileJob): void {
    const job = structuredClone(message);
    const result = marchingCubesRectangular(
      buildSampleShapeLattice(job.shape, job.sphereRadius, job.params, job.generationSeed),
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
    setTimeout(() => this.onmessage?.({ data: response }), (7 - job.tileId % 8) % 4);
  }
  terminate(): void {}
}

/** Mirrors lattice-tile-worker.ts for imported meshes. */
class MeshTileWorker implements TileWorkerLike {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessageerror: ((event: unknown) => void) | null = null;
  private context: MeshTileContext | null = null;
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
      timing: { totalMs: 1, triCount: result.triCount },
    };
    setTimeout(() => this.onmessage?.({ data: structuredClone(response) }), (7 - msg.tileId % 8) % 4);
  }
  terminate(): void {}
}

const ORIENTED: Partial<LatticeParams> = { latticeRotationDeg: [20, -35, 45], cellScale: [1, 1.25, 2] };

describe('rotated and stretched lattices across generation paths', () => {
  it.each(['gyroid', 'octet', 'voronoi'] as const)(
    'keeps a transformed %s sample shape byte-identical across tile worker counts',
    async (latticeType) => {
      const params: LatticeParams = { ...DEFAULT_PARAMS, latticeType, cellSize: 7, noShell: true, ...ORIENTED };
      const hashes = new Set<string>();
      let triCount = 0;
      for (const workerCount of [1, 3, 8]) {
        const { result, stats } = await runTiledGeneration(
          params, 0x0123abcd, 'sphere', 20,
          { min: [-24, -24, -24], max: [24, 24, 24] }, 72,
          () => undefined, () => false,
          { workerCount, createWorker: () => new ShapeTileWorker() },
        );
        expect(stats.tilesProcessed).toBeGreaterThan(1);
        hashes.add(hash(result));
        triCount = result.triCount;
      }
      expect(hashes.size).toBe(1);
      expect(triCount).toBeGreaterThan(1000);
    },
  );

  it('matches the single-worker imported-mesh path byte for byte', async () => {
    const mesh = generateSphereMesh(18, 32);
    const params: LatticeParams = { ...DEFAULT_PARAMS, latticeType: 'gyroid', cellSize: 6, ...ORIENTED };
    const seed = 77;
    const resolution = 60;
    const bounds = { min: [-21, -21, -21] as Vec3, max: [21, 21, 21] as Vec3 };
    const cells: Vec3 = [resolution, resolution, resolution];

    const singleBvh = new MeshBVH(mesh.positions, mesh.normals, mesh.triCount);
    const field = sampleSdfField(buildImportedMeshSdf(singleBvh, params, seed, [], []), bounds, cells);
    cutEscapeHolesInField(field, bounds, cells, params);
    sealFieldBoundary(field, cells, 0);
    const single = marchingCubesFromField(field, bounds, cells, 0);
    expect(single.triCount).toBeGreaterThan(1000);

    for (const workerCount of [1, 4]) {
      const { result } = await runMeshTiledGeneration(
        {
          bvh: new MeshBVH(mesh.positions, mesh.normals, mesh.triCount),
          params,
          fieldParams: params,
          generationSeed: seed,
          keepOutTris: [],
          keepInTris: [],
          bounds,
          resolution,
        },
        () => undefined,
        () => false,
        { workerCount, shareMemory: false, createWorker: () => new MeshTileWorker() },
      );
      expect(hash(result), `${workerCount} workers`).toBe(hash(single));
    }
  });
});
