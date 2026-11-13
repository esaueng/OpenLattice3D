// CPU tile worker: builds one non-overlapping marching-cubes tile.
import { marchingCubesRectangular, type MarchingCubesResult } from '../geometry/marching-cubes';
import { buildSampleShapeLattice } from '../geometry/lattice';
import { computeMeshTile, createMeshTileContext, type MeshTileContext } from './mesh-tiles';
import type { LatticeTileJob, LatticeTileResponse, MeshTileJob, TileWorkerMessage } from './tile-types';
import { failureCause } from '../utils/failure-cause';

type SdfFunction = (x: number, y: number, z: number) => number;
type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

// Imported-mesh runs send one `mesh-init` per worker before their tile jobs.
// An init failure is reported on the first job, the only message the pool
// waits on.
let meshContext: MeshTileContext | null = null;
let meshInitError: string | null = null;

function buildShapeSdf(msg: LatticeTileJob): SdfFunction {
  return buildSampleShapeLattice(msg.shape, msg.sphereRadius, msg.params, msg.generationSeed);
}

function runTile(msg: LatticeTileJob | MeshTileJob): MarchingCubesResult & { rowTriangleStarts?: Uint32Array } {
  if (msg.type === 'mesh-tile') {
    if (!meshContext) throw new Error(meshInitError ?? 'Tile worker received a mesh tile before its mesh');
    return computeMeshTile(meshContext, msg);
  }
  // The host disables tiling whenever morphological opening is active,
  // because the distance transform must see the complete volume.
  return marchingCubesRectangular(buildShapeSdf(msg), msg.bounds, msg.cells, 0);
}

self.onmessage = (event: MessageEvent<TileWorkerMessage>) => {
  const msg = event.data;
  if (msg.type === 'mesh-init') {
    try {
      meshContext = createMeshTileContext(msg);
      meshInitError = null;
    } catch (err: unknown) {
      meshContext = null;
      meshInitError = err instanceof Error ? err.message : 'Could not load the mesh in a tile worker';
    }
    return;
  }
  if (msg.type !== 'tile' && msg.type !== 'mesh-tile') return;

  try {
    const start = performance.now();
    const result = runTile(msg);
    // A degenerate field may emit few triangles from a large upper-bound
    // allocation. Transfer only the emitted bytes, not the unused backing store.
    const positions = result.positions.byteLength === result.positions.buffer.byteLength
      ? result.positions : result.positions.slice();
    const rowTriangleStarts = result.rowTriangleStarts;
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: msg.tileId,
      positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: {
        totalMs: performance.now() - start,
        triCount: result.triCount,
      },
      ...(rowTriangleStarts ? { rowTriangleStarts } : {}),
    };
    const transfer: Transferable[] = [positions.buffer, result.normals.buffer];
    if (rowTriangleStarts) transfer.push(rowTriangleStarts.buffer);
    postWorkerMessage(response, transfer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown tile worker error';
    postMessage({ type: 'error', tileId: msg.tileId, message, diagnostic: failureCause(err) } as LatticeTileResponse);
  }
};
