import type { LatticeParams, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import type { FailureCause } from '../utils/failure-cause';
import type { PackedMeshBVH } from '../geometry/bvh-serialization';
export type TileBackend = 'cpu-single' | 'cpu-tiled';

export interface LatticeTileJob {
  type: 'tile';
  tileId: number;
  params: LatticeParams;
  generationSeed: number;
  shape: SampleShape;
  sphereRadius: number;
  bounds: { min: Vec3; max: Vec3 };
  cells: Vec3;
}

/**
 * Sent once to each tile worker of an imported-mesh run, before its first
 * `mesh-tile` job. The packed BVH is shared memory when the page is
 * cross-origin isolated, otherwise a per-worker transferred copy.
 */
export interface MeshTileInit {
  type: 'mesh-init';
  bvh: PackedMeshBVH;
  /** Parameters the field is built from (escape holes off under thin filtering). */
  fieldParams: LatticeParams;
  /** Requested parameters; escape holes are cut into the sampled field from these. */
  params: LatticeParams;
  generationSeed: number;
  keepOutTris: number[];
  keepInTris: number[];
  /** The whole sampling grid; tiles are windows of it. */
  gridBounds: { min: Vec3; max: Vec3 };
  gridCells: Vec3;
}

/** One window of the imported-mesh sampling grid, in grid cell indices. */
export interface MeshTileJob {
  type: 'mesh-tile';
  tileId: number;
  origin: Vec3;
  cells: Vec3;
}

export type TileWorkerMessage = LatticeTileJob | MeshTileInit | MeshTileJob;

export interface TileSkipStats {
  tilesTotal: number;
  tilesSkipped: number;
  tilesProcessed: number;
}

export interface LatticeTileTiming {
  totalMs: number;
  triCount: number;
}

export interface LatticeTileResult {
  type: 'result';
  tileId: number;
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
  timing: LatticeTileTiming;
  /** Imported-mesh tiles: first triangle of each cube row, then triCount. */
  rowTriangleStarts?: Uint32Array;
}

export interface LatticeTileError {
  type: 'error';
  tileId: number;
  message: string;
  /** Set when the tile failed to allocate memory; classified in the tile worker. */
  diagnostic?: FailureCause;
}

export type LatticeTileResponse = LatticeTileResult | LatticeTileError;
