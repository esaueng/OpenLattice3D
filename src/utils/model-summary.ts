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

export function formatVolume(volumeMm3: number | null): string {
  if (volumeMm3 === null || !Number.isFinite(volumeMm3)) return 'unknown (mesh is open)';
  if (volumeMm3 >= 1000) return `${(volumeMm3 / 1000).toFixed(2)} cm³`;
  return `${volumeMm3.toFixed(volumeMm3 >= 10 ? 1 : 2)} mm³`;
}

/** How many lattice cells fit across the shortest side of the model. */
export function cellsAcrossShortestSide(size: [number, number, number], cellSize: number): number {
  const shortest = Math.min(...size);
  if (!(cellSize > 0) || !(shortest > 0)) return 0;
  return shortest / cellSize;
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
  if (!info.isWatertight) parts.push(`open (${info.boundaryEdges.toLocaleString()} boundary edges)`);
  if (info.nonManifoldEdges > 0) parts.push(`${info.nonManifoldEdges.toLocaleString()} non-manifold edges`);
  const prefix = info.repaired ? 'Normals recomputed; mesh is still ' : 'Mesh is ';
  return { level: 'warn', message: `${prefix}${parts.join(', ')}. Generated geometry will be unreliable.` };
}
