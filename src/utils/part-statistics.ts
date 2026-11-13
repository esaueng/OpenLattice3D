// Volume-derived part statistics shared by the Results panel and the compare
// grid, so both report relative density the same way.
import { meshVolumeMm3, proceduralSolidVolumeMm3 } from '../geometry/mesh-stats';
import type { TriangleMesh } from '../geometry/stl-parser';
import type { MeshInfo, SampleShape } from '../types/project';

export interface SolidSource {
  sampleShape: SampleShape | null;
  sphereRadius: number;
  originalMesh: Pick<TriangleMesh, 'positions' | 'triCount'> | null;
  meshInfo: Pick<MeshInfo, 'isWatertight'> | null;
}

/** Volume of the solid part the lattice replaces, or null when it is undefined (open mesh, no model). */
export function sourceSolidVolumeMm3(source: SolidSource): number | null {
  if (source.sampleShape) return proceduralSolidVolumeMm3(source.sampleShape, source.sphereRadius);
  if (source.originalMesh && source.meshInfo?.isWatertight) return meshVolumeMm3(source.originalMesh);
  return null;
}

/** Lattice volume as a fraction of the solid part, or null when it cannot be stated honestly. */
export function relativeDensity(latticeVolumeMm3: number, sourceVolumeMm3: number | null): number | null {
  if (sourceVolumeMm3 === null || !(sourceVolumeMm3 > 0) || !Number.isFinite(latticeVolumeMm3) || latticeVolumeMm3 < 0) {
    return null;
  }
  return latticeVolumeMm3 / sourceVolumeMm3;
}

/** "45.8%" from 0.458. */
export function formatFraction(fraction: number, digits = 1): string {
  return `${(fraction * 100).toFixed(digits)}%`;
}
