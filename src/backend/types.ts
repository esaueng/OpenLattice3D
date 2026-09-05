// Backend contracts for the marching-cubes parity benchmark and GPU promotion
// gate. See docs/performance/parity-gates.md.
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { Vec3 } from '../geometry/vec3';
import type { LatticeParams, SampleShape } from '../types/project';

export type GenerationBackendId = 'cpu-single' | 'cpu-tiled' | 'webgpu-mc';

/** Deterministic, self-contained generation job used by parity and benchmark runs. */
export interface BackendFixture {
  name: string;
  description: string;
  shape: SampleShape;
  sphereRadius: number;
  params: LatticeParams;
  generationSeed: number;
  bounds: { min: Vec3; max: Vec3 };
  resolution: number;
}

/**
 * End-to-end phase timings for one backend run. Phases that a backend cannot
 * separate are null: the CPU tiled path fuses field sampling, classification,
 * scan, and emission inside each tile worker, and CPU backends have no
 * GPU->CPU readback. The WebGPU backend (docs/performance/webgpu-marching-
 * cubes-design.md) reports every phase.
 */
export interface BackendPhaseTimings {
  fieldMs: number | null;
  classifyScanEmitMs: number | null;
  readbackMs: number | null;
  mergeMs: number | null;
  cleanupMs: number | null;
  totalMs: number;
}

export interface BackendRunResult {
  backend: GenerationBackendId;
  result: MarchingCubesResult;
  timings: BackendPhaseTimings;
}

export interface BackendRunHooks {
  isCancelled?: () => boolean;
}

export interface MarchingCubesBackend {
  id: GenerationBackendId;
  run(fixture: BackendFixture, hooks?: BackendRunHooks): Promise<BackendRunResult>;
}
