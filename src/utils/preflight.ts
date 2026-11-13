// What a run will cost and whether the settings make sense for this part,
// computed before Generate so the user is not surprised after it.
import type { LatticeParams, MeshInfo } from '../types/project';
import { isSheetType } from '../geometry/lattice';
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
export const MAX_RESOLUTION_LEVEL = 10;

export interface Preflight {
  /** Samples per axis of the marching-cubes grid. */
  grid: number;
  voxelMm: number;
  estimatedTriangles: number;
  estimatedSeconds: number;
  estimatedMemoryMb: number;
  warnings: PreflightWarning[];
}

/** Grid divisions per axis for a resolution level, mirrored from useLatticeGeneration. */
export function gridForResolution(exportResolution: number): number {
  return Math.round(24 + exportResolution * 24);
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

// Triangle count scales with the sampled surface, roughly grid². The constant
// comes from measured runs: 434k tris at 96³ and 2.9M at 264³ on the samples.
const TRIANGLES_PER_GRID_CELL_FACE = 44;
const BYTES_PER_FIELD_SAMPLE = 4;
const BYTES_PER_TRIANGLE_IN_VIEWER = 9 * 4 + 3 * 4 + 9 * 4; // positions, face normal, vertex normals

export function buildPreflight(
  params: LatticeParams,
  extents: ModelExtents | null,
  meshInfo: MeshInfo | null,
): Preflight {
  const grid = gridForResolution(params.exportResolution);
  const maxSpan = sampledSpanMm(params, extents);
  const voxelMm = maxSpan / grid;
  const timings = estimateGenerationTimings(params, grid, Boolean(meshInfo));
  const estimatedTriangles = Math.round(TRIANGLES_PER_GRID_CELL_FACE * grid * grid);
  const estimatedMemoryMb = Math.round(
    ((grid + 1) ** 3 * BYTES_PER_FIELD_SAMPLE + estimatedTriangles * BYTES_PER_TRIANGLE_IN_VIEWER) / 1e6,
  );

  const warnings: PreflightWarning[] = [];
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
  if (estimatedTriangles > 2_000_000) {
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
    warnings,
  };
}

export function formatPreflight(preflight: Preflight): string {
  const tris = preflight.estimatedTriangles >= 1e6
    ? `${(preflight.estimatedTriangles / 1e6).toFixed(1)} M`
    : `${Math.round(preflight.estimatedTriangles / 1e3)} k`;
  return `${preflight.grid}³ grid · ${preflight.voxelMm.toFixed(2)} mm voxels · ~${tris} triangles · ~${formatDuration(preflight.estimatedSeconds)} · ~${preflight.estimatedMemoryMb} MB`;
}
