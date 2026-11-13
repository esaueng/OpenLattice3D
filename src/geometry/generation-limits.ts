import { MAX_MESH_TRIANGLES } from './mesh-limits';
import type { Vec3 } from './vec3';
import type { LatticeParams } from '../types/project';

// Memory model and the derivation of every limit below:
// docs/performance/large-parts.md.

/**
 * Largest scalar field allocated in one piece. Bounds the cpu-single path,
 * which samples the whole grid into one Float32Array (265^3 x 4 B = 74 MB),
 * every tile field, and direct worker/library calls.
 */
export const MAX_GENERATION_FIELD_SAMPLES = 265 ** 3;

/** Grid cells per axis of the largest single-field (cpu-single) run: resolution level 10. */
export const MAX_SINGLE_GENERATION_GRID = 264;

/**
 * Hard ceiling on cells per axis for tiled runs, independent of the output
 * budget. Tiles never hold more than one tile's field, so this only bounds
 * scheduling (16^3 = 4096 tiles of 32^3 cells) and per-tile bookkeeping.
 */
export const TILED_GENERATION_GRID_CEILING = 512;

/**
 * Triangle count scales with the sampled surface, roughly grid^2. Measured on
 * the sample shapes at default settings: 434k triangles at 96^3 and 2.9M at
 * 264^3. An approximation: dense or finely celled parts can exceed it.
 */
export const ESTIMATED_TRIANGLES_PER_GRID_FACE = 44;

/** Approximate triangle count for a cubic grid of `grid` cells per axis. */
export function estimatedGenerationTriangles(grid: number): number {
  return Math.round(ESTIMATED_TRIANGLES_PER_GRID_FACE * grid * grid);
}

/**
 * Headroom on the estimate when it sets a limit. The densest default sample
 * (sphere gyroid) measured 47.5 triangles per grid face at 264-320, 8% above
 * the estimate; the other samples measured 32-42.
 */
export const TRIANGLE_ESTIMATE_HEADROOM = 1.15;

/** The estimate with headroom: what a limit must budget for. */
export function conservativeGenerationTriangles(grid: number): number {
  return Math.round(estimatedGenerationTriangles(grid) * TRIANGLE_ESTIMATE_HEADROOM);
}

/**
 * Largest tiled grid whose estimated output, with headroom, fits the
 * generated-mesh triangle budget (MAX_MESH_TRIANGLES), capped by the
 * scheduling ceiling. With the 5M-triangle budget this is 314 cells per axis
 * (resolution level 12, 312³); the ceiling binds only if the budget rises
 * above ~13.3M triangles. Tiling is never more restrictive than the
 * single-field path.
 */
export const MAX_TILED_GENERATION_GRID = Math.max(
  MAX_SINGLE_GENERATION_GRID,
  Math.min(
    TILED_GENERATION_GRID_CEILING,
    Math.floor(Math.sqrt(MAX_MESH_TRIANGLES / (ESTIMATED_TRIANGLES_PER_GRID_FACE * TRIANGLE_ESTIMATE_HEADROOM))),
  ),
);

/** Cells per axis of one tile, and the most tile workers a run starts. */
export const TILE_SIZE = 32;
export const MAX_TILE_WORKERS = 8;

/**
 * Bytes held per output triangle once a run is handed over (approximate, from
 * array sizes): generator peak 132 (merged positions/normals 48, display
 * vertex normals 36, validation copies 48), then 84 in the UI, 72 on the GPU
 * and 48 in the validation worker. Excludes validation and export temporaries.
 */
export const BYTES_PER_OUTPUT_TRIANGLE = 204;

/**
 * Approximate memory for a run: the largest scalar-field allocation (the whole
 * grid on cpu-single, one tile per worker on cpu-tiled) plus the per-triangle
 * cost of the output across the generator, UI, GPU and validation worker.
 */
export function estimateGenerationMemoryBytes(grid: number, path: GenerationPath, triangles: number): number {
  const fieldSamples = path === 'cpu-single'
    ? (grid + 1) ** 3
    : MAX_TILE_WORKERS * (Math.min(grid, TILE_SIZE) + 1) ** 3;
  return fieldSamples * Float32Array.BYTES_PER_ELEMENT + triangles * BYTES_PER_OUTPUT_TRIANGLE;
}

/** How a run is executed: one whole field, or bounded tile workers. */
export type GenerationPath = 'cpu-single' | 'cpu-tiled';

export function maxGenerationGrid(path: GenerationPath): number {
  return path === 'cpu-tiled' ? MAX_TILED_GENERATION_GRID : MAX_SINGLE_GENERATION_GRID;
}

/** Grid cells per axis for an export-resolution level (the UI's 1..N scale). */
export function gridForResolutionLevel(level: number): number {
  return Math.round(24 + level * 24);
}

/** Highest export-resolution level whose grid fits `path` (10 for cpu-single, 12 for cpu-tiled). */
export function maxResolutionLevel(path: GenerationPath): number {
  return Math.floor((maxGenerationGrid(path) - 24) / 24);
}

/** Highest export-resolution level any run accepts; project files and saved settings are checked against it. */
export const MAX_EXPORT_RESOLUTION_LEVEL = maxResolutionLevel('cpu-tiled');

/**
 * Why these parameters must run on the whole-field cpu-single path, or null
 * when they can be tiled. The generation worker selects its backend with this
 * same check, so the UI limit and the worker limit cannot disagree.
 *
 * - Thin-feature removal is a morphological opening (a whole-volume distance
 *   transform); tiling it would make neighbouring seams disagree.
 * - Conformal hexagon/triangle surface lattices are built from a global set of
 *   relaxed surface samples in the generation worker and are not tiled.
 *
 * Escape holes do not force the whole field: tile workers cut them into each
 * tile's samples from the whole grid's bounds, as the single path does.
 */
export function fullFieldRequirement(
  params: Pick<LatticeParams, 'thinSectionFilter' | 'variant' | 'latticeType'>,
): string | null {
  if (params.thinSectionFilter > 0) return 'thin-feature removal needs the whole field in memory';
  if (params.variant === 'implicit_conformal' && (params.latticeType === 'hexagon' || params.latticeType === 'triangle')) {
    return 'conformal hexagon and triangle surface lattices are generated in a single worker';
  }
  return null;
}

/** The path the generation worker will select for a model run (not the demo grid). */
export function expectedGenerationPath(
  params: Pick<LatticeParams, 'thinSectionFilter' | 'variant' | 'latticeType'>,
): GenerationPath {
  return fullFieldRequirement(params) === null ? 'cpu-tiled' : 'cpu-single';
}

function validCellCounts(cells: Vec3): void {
  if (cells.some((count) => !Number.isSafeInteger(count) || count < 1)) {
    throw new Error('Generation grid dimensions must be positive finite integers.');
  }
}

/** Validate dimensions of one field allocation (a whole cpu-single field or one tile) before sampling it. */
export function generationSampleCount(cells: Vec3): number {
  validCellCounts(cells);
  const samples = cells.reduce((product, count) => product * (count + 1), 1);
  if (!Number.isSafeInteger(samples) || samples > MAX_GENERATION_FIELD_SAMPLES) {
    throw new Error('Generation grid exceeds the supported memory limit; lower the export resolution.');
  }
  return samples;
}

/**
 * Validate a whole sampling grid for `path` before any BVH, tile scheduling or
 * typed-array allocation. Returns the grid's sample count; on cpu-tiled the
 * grid is never allocated whole, only tile by tile.
 */
export function assertGenerationGrid(cells: Vec3, path: GenerationPath, reason?: string | null): number {
  validCellCounts(cells);
  const limit = maxGenerationGrid(path);
  const samples = cells.reduce((product, count) => product * (count + 1), 1);
  if (cells.every((count) => count <= limit) && Number.isSafeInteger(samples)) return samples;
  const largest = Math.max(...cells);
  if (path === 'cpu-single') {
    throw new Error(
      `A ${largest}³ generation grid exceeds the ${limit}³ memory limit for single-worker generation`
      + `${reason ? ` (${reason})` : ''}; lower the export resolution.`,
    );
  }
  const triangles = conservativeGenerationTriangles(largest);
  throw new Error(
    `A ${largest}³ generation grid exceeds the ${limit}³ memory limit for tiled generation`
    + ` (up to about ${(triangles / 1e6).toFixed(1)} M triangles estimated against the`
    + ` ${MAX_MESH_TRIANGLES.toLocaleString('en-US')} triangle budget); lower the export resolution.`,
  );
}

/** Bound extracted output and retained tiles before allocating the merged copy. */
export function assertGenerationOutputBudget(
  triangles: number,
  positionValues = triangles * 9,
  normalValues = triangles * 3,
  retainedBytes = (positionValues + normalValues) * Float32Array.BYTES_PER_ELEMENT,
): void {
  if (!Number.isSafeInteger(triangles) || triangles < 0
    || triangles > MAX_MESH_TRIANGLES
    || !Number.isSafeInteger(positionValues) || positionValues < 0
    || !Number.isSafeInteger(normalValues) || normalValues < 0
    || positionValues + normalValues > MAX_MESH_TRIANGLES * 12
    || !Number.isSafeInteger(retainedBytes) || retainedBytes < 0
    || retainedBytes > MAX_MESH_TRIANGLES * 12 * Float32Array.BYTES_PER_ELEMENT) {
    throw new Error(`Generated mesh exceeds the ${MAX_MESH_TRIANGLES.toLocaleString()} triangle memory limit; lower the export resolution.`);
  }
}
