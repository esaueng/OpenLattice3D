import type { LatticeParams, SampleShape } from '../types/project';
import type { Vec3 } from '../geometry/vec3';
import type { EscapeHole } from '../geometry/escape-holes';
import type { GenerationBackendName } from '../backend/generation-backend';

export type TileBackend = GenerationBackendName;

export interface LatticeTileJob {
  type: 'tile';
  tileId: number;
  params: LatticeParams;
  shape: SampleShape;
  sphereRadius: number;
  bounds: { min: Vec3; max: Vec3 };
  cells: Vec3;
  /** Planned once on the host worker so every tile cuts identical channels. */
  escapeHoles: EscapeHole[];
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
}

export type LatticeTileResponse = LatticeTileResult | LatticeTileError;
