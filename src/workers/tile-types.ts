import type { LatticeParams, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import type { FailureCause } from '../utils/failure-cause';
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
}

export interface LatticeTileError {
  type: 'error';
  tileId: number;
  message: string;
  /** Set when the tile failed to allocate memory; classified in the tile worker. */
  diagnostic?: FailureCause;
}

export type LatticeTileResponse = LatticeTileResult | LatticeTileError;
