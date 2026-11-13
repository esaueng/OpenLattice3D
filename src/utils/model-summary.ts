// Human-facing facts about the loaded model: size, volume, cells across, and
// the brush radius that suits it. Pure so the panel copy can be unit-tested.
import type { BoundingBox, MeshInfo, SampleShape } from '../types/project';

export interface ModelExtents {
  /** Size along X, Y, Z in mm. */
  size: [number, number, number];
  volumeMm3: number | null;
}

const SAMPLE_EXTENTS: Record<SampleShape, (radius: number) => ModelExtents> = {
  sphere: (r) => ({ size: [2 * r, 2 * r, 2 * r], volumeMm3: (4 / 3) * Math.PI * r ** 3 }),
  cube: () => ({ size: [30, 30, 30], volumeMm3: 27_000 }),
  cylinder: () => ({ size: [30, 30, 40], volumeMm3: Math.PI * 15 ** 2 * 40 }),
  torus: () => ({ size: [56, 56, 16], volumeMm3: 2 * Math.PI ** 2 * 20 * 8 ** 2 }),
  capsule: () => ({ size: [24, 24, 54], volumeMm3: Math.PI * 12 ** 2 * 30 + (4 / 3) * Math.PI * 12 ** 3 }),
};

export function boundingBoxSize(box: BoundingBox): [number, number, number] {
  return [box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]];
}

export function modelExtents(
  meshInfo: MeshInfo | null,
  sampleShape: SampleShape | null,
  sphereRadius: number,
): ModelExtents | null {
  if (meshInfo) return { size: boundingBoxSize(meshInfo.boundingBox), volumeMm3: meshInfo.volumeMm3 };
  if (sampleShape) return SAMPLE_EXTENTS[sampleShape](sphereRadius || 25);
  return null;
}

/** "50.0 × 50.0 × 50.0 mm" with a sensible precision for the magnitude. */
export function formatDimensions(size: [number, number, number]): string {
  const largest = Math.max(...size.map(Math.abs));
  const digits = largest >= 100 ? 0 : largest >= 10 ? 1 : 2;
  return `${size.map((value) => value.toFixed(digits)).join(' × ')} mm`;
}

/** Volumes at or above this many mm³ read in cm³ (1 cm³ = 1000 mm³). */
export const CM3_THRESHOLD_MM3 = 1000;

function groupedFixed(value: number, digits: number): string {
  return value.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * The one volume formatter for every panel: cm³ from 1000 mm³ up, mm³ below,
 * with thousands separators, split so a KPI can style the unit separately.
 */
export function volumeParts(volumeMm3: number): { value: string; unit: 'mm³' | 'cm³' } {
  if (Math.abs(volumeMm3) >= CM3_THRESHOLD_MM3) return { value: groupedFixed(volumeMm3 / 1000, 2), unit: 'cm³' };
  return { value: groupedFixed(volumeMm3, Math.abs(volumeMm3) >= 10 ? 1 : 2), unit: 'mm³' };
}

export function formatVolume(volumeMm3: number | null): string {
  if (volumeMm3 === null || !Number.isFinite(volumeMm3)) return 'unknown (mesh is open)';
  const { value, unit } = volumeParts(volumeMm3);
  return `${value} ${unit}`;
}

/**
 * Cell sizes once per-axis stretch is applied. `largest` is the longest
 * stretched cell edge: the worst case for "does a cell fit" checks, since a
 * rotated lattice can put any axis across the part's shortest side.
 * `volumeEquivalent` keeps one cell's volume, for cell-count estimates. With no
 * stretch both equal `cellSize`.
 */
export function effectiveCellSizes(
  cellSize: number,
  cellScale: readonly [number, number, number] = [1, 1, 1],
): { largest: number; volumeEquivalent: number } {
  const [sx, sy, sz] = cellScale;
  if (sx === 1 && sy === 1 && sz === 1) return { largest: cellSize, volumeEquivalent: cellSize };
  return {
    largest: cellSize * Math.max(sx, sy, sz),
    volumeEquivalent: cellSize * Math.cbrt(sx * sy * sz),
  };
}

/** How many lattice cells fit across the shortest side of the model. */
export function cellsAcrossShortestSide(size: [number, number, number], cellSize: number): number {
  const shortest = Math.min(...size);
  if (!(cellSize > 0) || !(shortest > 0)) return 0;
  return shortest / cellSize;
}

/**
 * Unit cells spanning the model's bounding box at a cell size: whole cells per
 * axis, at least one each. An upper-bound estimate of the lattice's cell count
 * (the shell, keep-in regions and the part's own shape are not subtracted), used
 * only to pick a coarse size range. Null when the inputs cannot give a count.
 */
export function latticeCellCount(size: readonly [number, number, number] | null, cellSize: number): number | null {
  if (!size || !(cellSize > 0) || !Number.isFinite(cellSize)) return null;
  if (size.some((extent) => !Number.isFinite(extent) || extent < 0)) return null;
  return size.reduce((cells, extent) => cells * Math.max(1, Math.ceil(extent / cellSize - 1e-9)), 1);
}

/**
 * Brush radius for a first stroke: about 4% of the bounding-box diagonal,
 * never below half a millimetre, rounded to a tenth.
 */
export function defaultBrushRadius(box: BoundingBox): number {
  const [w, d, h] = boundingBoxSize(box);
  const diagonal = Math.sqrt(w * w + d * d + h * h);
  if (!Number.isFinite(diagonal) || diagonal <= 0) return 0.5;
  return Math.max(0.5, Math.round(diagonal * 0.04 * 10) / 10);
}

/** One line describing how sound an imported mesh is, without overstating repair. */
export function describeMeshCondition(info: MeshInfo): { level: 'ok' | 'warn'; message: string } {
  if (info.isWatertight && info.isManifold) {
    return { level: 'ok', message: 'Closed and manifold' };
  }
  const parts: string[] = [];
  if (info.boundaryEdges > 0) parts.push(`open (${info.boundaryEdges.toLocaleString()} boundary edges)`);
  if (info.nonManifoldEdges > 0) parts.push(`${info.nonManifoldEdges.toLocaleString()} non-manifold edges`);
  const prefix = info.repaired ? 'Normals recomputed; mesh is still ' : 'Mesh is ';
  return { level: 'warn', message: `${prefix}${parts.join(', ')}. Generated geometry will be unreliable.` };
}
