// CPU tile worker: builds one non-overlapping marching-cubes tile.
import { marchingCubesRectangular } from '../geometry/marching-cubes';
import {
  buildCapsuleLattice,
  buildCubeLattice,
  buildCylinderLattice,
  buildSphereLattice,
  buildTorusLattice,
} from '../geometry/lattice';
import type { SampleShape } from '../types/project';
import type { LatticeTileJob, LatticeTileResponse } from './tile-types';

type SdfFunction = (x: number, y: number, z: number) => number;
type WorkerPostMessage = (message: unknown, transfer: Transferable[]) => void;

const postWorkerMessage = self.postMessage.bind(self) as WorkerPostMessage;

function buildShapeSdf(msg: LatticeTileJob): SdfFunction {
  switch (msg.shape as SampleShape) {
    case 'sphere':
      return buildSphereLattice(msg.sphereRadius || 25, msg.params, msg.generationSeed);
    case 'cube':
      return buildCubeLattice(15, msg.params, msg.generationSeed);
    case 'cylinder':
      return buildCylinderLattice(15, 20, msg.params, msg.generationSeed);
    case 'torus':
      return buildTorusLattice(20, 8, msg.params, msg.generationSeed);
    case 'capsule':
      return buildCapsuleLattice(12, 15, msg.params, msg.generationSeed);
  }
}

self.onmessage = (event: MessageEvent<LatticeTileJob>) => {
  const msg = event.data;
  if (msg.type !== 'tile') return;

  try {
    const start = performance.now();
    // The host disables tiling whenever morphological opening is active,
    // because the distance transform must see the complete volume.
    const result = marchingCubesRectangular(
      buildShapeSdf(msg),
      msg.bounds,
      msg.cells,
      0,
    );
    const response: LatticeTileResponse = {
      type: 'result',
      tileId: msg.tileId,
      positions: result.positions,
      normals: result.normals,
      triCount: result.triCount,
      timing: {
        totalMs: performance.now() - start,
        triCount: result.triCount,
      },
    };
    postWorkerMessage(response, [result.positions.buffer, result.normals.buffer]);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown tile worker error';
    postMessage({ type: 'error', tileId: msg.tileId, message } as LatticeTileResponse);
  }
};
