// What a run will cost and whether the settings make sense for this part,
// computed before Generate so the user is not surprised after it.
import type { LatticeParams, MeshInfo } from '../types/project';
import { isSheetType } from '../geometry/lattice';
import {
  estimateGenerationMemoryBytes,
  estimatedGenerationTriangles,
  expectedGenerationPath,
  fullFieldRequirement,
  gridForResolutionLevel,
  MAX_SINGLE_GENERATION_GRID,
  maxResolutionLevel,
  type GenerationPath,
} from '../geometry/generation-limits';
import { MAX_MESH_TRIANGLES } from '../geometry/mesh-limits';
import { estimateGenerationTimings, formatDuration } from '../workers/generation-estimate';
import type { ModelExtents } from './model-summary';

export interface PreflightWarning {
  /** 'block' means the run is very unlikely to produce a usable lattice. */
  level: 'warn' | 'block';
  message: string;
  /** A one-click parameter change that clears this warning, when one exists. */
  fix?: PreflightFix;
}

export interface PreflightFix {
  label: string;
  params: Partial<LatticeParams>;
}

export const MIN_RESOLUTION_LEVEL = 1;
/**
 * Highest level suggested by fixes and result guidance: the single-field
 * limit (264³). Levels above it run only on the tiled path and are offered,
 * never suggested, because of their memory and time cost.
 */
export const MAX_RESOLUTION_LEVEL = 10;

export interface Preflight {
  /** Samples per axis of the marching-cubes grid. */
  grid: number;
  voxelMm: number;
  estimatedTriangles: number;
  estimatedSeconds: number;
  /** Approximate peak across the generator, viewer and validation (docs/performance/large-parts.md). */
  estimatedMemoryMb: number;
  /** The path generation will take, and the highest resolution level it accepts. */
  path: GenerationPath;
  maxResolutionLevel: number;
  warnings: PreflightWarning[];
}

/** Grid divisions per axis for a resolution level, mirrored from useLatticeGeneration. */
export function gridForResolution(exportResolution: number): number {
  return gridForResolutionLevel(exportResolution);
}

/** Longest span the sampling grid covers, in mm: the part plus half a cell of padding each side. */
export function sampledSpanMm(params: Pick<LatticeParams, 'cellSize'>, extents: ModelExtents | null): number {
  return extents ? Math.max(...extents.size) + params.cellSize : 50;
}

/**
 * Lowest resolution level whose voxels are no larger than maxVoxelMm over this
 * span, or null when even the finest level is too coarse.
 */
export function minimumResolutionForVoxel(spanMm: number, maxVoxelMm: number): number | null {
  if (!(spanMm > 0) || !(maxVoxelMm > 0)) return null;
  for (let level = MIN_RESOLUTION_LEVEL; level <= MAX_RESOLUTION_LEVEL; level++) {
    if (spanMm / gridForResolution(level) <= maxVoxelMm) return level;
  }
  return null;
}

/** The wall or strut that must span two voxels, by lattice family. */
export function resolvedFeature(params: LatticeParams): { label: string; sizeMm: number } {
  return isSheetType(params.latticeType)
    ? { label: 'Wall thickness', sizeMm: params.wallThickness }
    : { label: 'Strut diameter', sizeMm: params.strutDiameter };
}

/** Lowest level that puts two voxels across the wall or strut, or null when none does. */
export function minimumResolutionForFeature(params: LatticeParams, extents: ModelExtents | null): number | null {
  return minimumResolutionForVoxel(sampledSpanMm(params, extents), resolvedFeature(params).sizeMm / 2);
}

function raiseResolutionFix(level: number | null, current: number): PreflightFix | undefined {
  if (level === null || level <= current) return undefined;
  return { label: `Raise resolution to ${level}`, params: { exportResolution: level } };
}

export function buildPreflight(
  params: LatticeParams,
  extents: ModelExtents | null,
  meshInfo: MeshInfo | null,
): Preflight {
  const grid = gridForResolution(params.exportResolution);
  const maxSpan = sampledSpanMm(params, extents);
  const voxelMm = maxSpan / grid;
  const timings = estimateGenerationTimings(params, grid, Boolean(meshInfo));
  // Triangle count scales with the sampled surface, roughly grid².
  const estimatedTriangles = estimatedGenerationTriangles(grid);
  const path = expectedGenerationPath(params);
  const maxLevel = maxResolutionLevel(path);
  const estimatedMemoryMb = Math.round(estimateGenerationMemoryBytes(grid, path, estimatedTriangles) / 1e6);

  const warnings: PreflightWarning[] = [];
  if (params.exportResolution > maxLevel) {
    const singleFieldReason = fullFieldRequirement(params);
    warnings.push({
      level: 'block',
      message: singleFieldReason
        ? `Resolution ${params.exportResolution} (${grid}³) is above the ${gridForResolution(maxLevel)}³ limit because ${singleFieldReason}. Levels above ${maxLevel} need tiled generation.`
        : `Resolution ${params.exportResolution} (${grid}³) is above the ${gridForResolution(maxLevel)}³ limit: its mesh would likely exceed the ${MAX_MESH_TRIANGLES.toLocaleString('en-US')} triangle memory budget.`,
      fix: { label: `Lower resolution to ${maxLevel}`, params: { exportResolution: maxLevel } },
    });
  } else if (grid > MAX_SINGLE_GENERATION_GRID) {
    warnings.push({
      level: 'warn',
      message: `Large run: the ${grid}³ grid is above the ${MAX_SINGLE_GENERATION_GRID}³ single-worker limit and is generated in tiles. Expect about ${(estimatedTriangles / 1e6).toFixed(1)} M triangles, ~${formatDuration(timings.totalSeconds)} or longer, and roughly ${(estimatedMemoryMb / 1000).toFixed(1)} GB of memory; close other tabs first. The run stops if the mesh exceeds ${MAX_MESH_TRIANGLES.toLocaleString('en-US')} triangles.`,
    });
  }
  if (meshInfo && !meshInfo.isWatertight) {
    warnings.push({
      level: 'block',
      message: meshInfo.boundaryEdges > 0
        ? `The mesh is open (${meshInfo.boundaryEdges.toLocaleString()} boundary edges); inside and outside are undefined. Close the holes first.`
        : `The mesh has ${meshInfo.nonManifoldEdges.toLocaleString()} non-manifold edges (shared by three or more triangles); inside and outside are undefined. Repair it in a mesh editor first.`,
    });
  }
  if (extents) {
    const shortest = Math.min(...extents.size);
    if (params.cellSize >= shortest) {
      warnings.push({
        level: 'block',
        message: `Cell size ${params.cellSize} mm is not smaller than the part's shortest side (${shortest.toFixed(1)} mm); no lattice cell fits.`,
      });
    } else if (shortest / params.cellSize < 2) {
      warnings.push({
        level: 'warn',
        message: `Only ${(shortest / params.cellSize).toFixed(1)} cells fit across the shortest side; expect mostly shell.`,
      });
    }
    if (!params.noShell && !params.surfaceOnly && params.shellThickness * 2 >= shortest) {
      warnings.push({
        level: 'block',
        message: `Shell thickness ${params.shellThickness} mm on both sides fills the part's shortest side (${shortest.toFixed(1)} mm); the result will be solid.`,
      });
    }
    if (params.escapeHoles && !params.noShell && !params.surfaceOnly && params.escapeHoleDiameter >= shortest) {
      warnings.push({
        level: 'warn',
        message: `Escape hole diameter ${params.escapeHoleDiameter} mm is wider than the part's shortest side.`,
      });
    }
  }
  const { label: featureLabel, sizeMm: feature } = resolvedFeature(params);
  if (feature < voxelMm * 2) {
    warnings.push({
      level: 'warn',
      message: `${featureLabel} ${feature.toFixed(2)} mm is under two ${voxelMm.toFixed(2)} mm voxels; raise the resolution or thicken it for reliable geometry.`,
      fix: raiseResolutionFix(minimumResolutionForVoxel(maxSpan, feature / 2), params.exportResolution),
    });
  }
  if (params.thinSectionFilter > 0 && params.thinSectionFilter / 2 < voxelMm) {
    warnings.push({
      level: 'warn',
      message: `Thin-feature removal under ${params.thinSectionFilter} mm cannot be resolved at ${voxelMm.toFixed(2)} mm voxels and will be skipped.`,
      fix: raiseResolutionFix(minimumResolutionForVoxel(maxSpan, params.thinSectionFilter / 2), params.exportResolution),
    });
  }
  if (estimatedTriangles > 2_000_000 && grid <= MAX_SINGLE_GENERATION_GRID) {
    warnings.push({
      level: 'warn',
      message: `About ${(estimatedTriangles / 1e6).toFixed(1)} M triangles; the viewer and exports will be slow.`,
    });
  }

  return {
    grid,
    voxelMm,
    estimatedTriangles,
    estimatedSeconds: timings.totalSeconds,
    estimatedMemoryMb,
    path,
    maxResolutionLevel: maxLevel,
    warnings,
  };
}

export function formatPreflight(preflight: Preflight): string {
  const tris = preflight.estimatedTriangles >= 1e6
    ? `${(preflight.estimatedTriangles / 1e6).toFixed(1)} M`
    : `${Math.round(preflight.estimatedTriangles / 1e3)} k`;
  return `${preflight.grid}³ grid · ${preflight.voxelMm.toFixed(2)} mm voxels · ~${tris} triangles · ~${formatDuration(preflight.estimatedSeconds)} · ~${preflight.estimatedMemoryMb} MB`;
}
