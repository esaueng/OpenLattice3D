// CPU tile worker: builds one non-overlapping marching-cubes tile.
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { computeMeshTile, createMeshTileContext, type MeshTileContext } from './mesh-tiles';
import { computeShapeTile } from './shape-tiles';
import type { LatticeTileResponse, TileWorkerMessage } from './tile-types';
import { failureCause } from '../utils/failure-cause';

type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

type TileJob = Extract<TileWorkerMessage, { type: 'tile' | 'mesh-tile' }>;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

// Imported-mesh runs send one `mesh-init` per worker before their tile jobs.
// An init failure is reported on the first job, the only message the pool
// waits on.
let meshContext: MeshTileContext | null = null;
let meshInitError: string | null = null;

function runTile(msg: TileJob): MarchingCubesResult & { rowTriangleStarts?: Uint32Array } {
  if (msg.type === 'mesh-tile') {
    if (!meshContext) throw new Error(meshInitError ?? 'Tile worker received a mesh tile before its mesh');
    return computeMeshTile(meshContext, msg);
  }
  // The host disables tiling whenever morphological opening is active,
  // because the distance transform must see the complete volume.
  return computeShapeTile(msg);
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
    // Mesh tiles: grid vertex ids, trimmed to the emitted references like the
    // positions above. Procedural tiles have none (they merge by tile id).
    const gridIds = result.vertexIds?.ids;
    const vertexIds = gridIds && gridIds.byteLength !== gridIds.buffer.byteLength ? gridIds.slice() : gridIds;
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
      ...(vertexIds ? { vertexIds } : {}),
    };
    const transfer: Transferable[] = [positions.buffer, result.normals.buffer];
    if (rowTriangleStarts) transfer.push(rowTriangleStarts.buffer);
    if (vertexIds) transfer.push(vertexIds.buffer);
    postWorkerMessage(response, transfer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown tile worker error';
    postMessage({ type: 'error', tileId: msg.tileId, message, diagnostic: failureCause(err) } as LatticeTileResponse);
  }
};
