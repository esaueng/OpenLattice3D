import type { MarchingCubesResult } from './marching-cubes';
import type { TriangleMesh } from './stl-parser';
import type { SampleShape } from '../types/project';

/** Enclosed triangle-mesh volume in mm^3 using signed tetrahedra.
 * The absolute value makes the result independent of consistent global winding. */
export function meshVolumeMm3(mesh: Pick<TriangleMesh, 'positions' | 'triCount'> | MarchingCubesResult): number {
  if (mesh.positions.length < mesh.triCount * 9) {
    throw new Error('Mesh position buffer is smaller than triCount requires');
  }
  let sum = 0;
  let compensation = 0;
  for (let triangle = 0; triangle < mesh.triCount; triangle++) {
    const offset = triangle * 9;
    const ax = mesh.positions[offset];
    const ay = mesh.positions[offset + 1];
    const az = mesh.positions[offset + 2];
    const bx = mesh.positions[offset + 3];
    const by = mesh.positions[offset + 4];
    const bz = mesh.positions[offset + 5];
    const cx = mesh.positions[offset + 6];
    const cy = mesh.positions[offset + 7];
    const cz = mesh.positions[offset + 8];
    const term = (
      ax * (by * cz - bz * cy)
      + ay * (bz * cx - bx * cz)
      + az * (bx * cy - by * cx)
    ) / 6;
    const corrected = term - compensation;
    const next = sum + corrected;
    compensation = (next - sum) - corrected;
    sum = next;
  }
  return Math.abs(sum);
}

export function proceduralSolidVolumeMm3(shape: SampleShape, sphereRadius: number): number {
  switch (shape) {
    case 'sphere': return (4 / 3) * Math.PI * sphereRadius ** 3;
    case 'cube': return 30 ** 3;
    case 'cylinder': return Math.PI * 15 ** 2 * 40;
    case 'torus': return 2 * Math.PI ** 2 * 20 * 8 ** 2;
    case 'capsule': return Math.PI * 12 ** 2 * 30 + (4 / 3) * Math.PI * 12 ** 3;
  }
}

export function massGrams(volumeMm3: number, densityGPerCm3: number): number {
  return (volumeMm3 / 1000) * densityGPerCm3;
}
