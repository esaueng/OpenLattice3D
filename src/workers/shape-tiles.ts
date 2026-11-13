// Procedural (sample-shape) tile kernel, shared by tile workers and tests.
//
// Each tile samples its own bounds, then applies the two whole-field steps of
// the single-worker path to the samples it holds: escape holes placed from the
// whole grid's bounds (`cutEscapeHolesInField`) and the seal of the grid's
// outer faces (`sealFieldBoundary`). Neither needs neighbouring samples, so the
// grid never has to exist in one piece. When neither changes a sample (escape
// holes off and padded bounds, the default), the tile is bit-identical to
// `marchingCubesRectangular` over the same bounds.
import { escapeHolesSdf, resolveEscapeHoleCenters, shouldApplyEscapeHoles } from '../geometry/escape-holes';
import { buildSampleShapeLattice } from '../geometry/lattice';
import {
  marchingCubesFromField,
  sampleSdfField,
  type MarchingCubesResult,
} from '../geometry/marching-cubes';
import type { LatticeTileJob } from './tile-types';

export function computeShapeTile(job: LatticeTileJob): MarchingCubesResult {
  const sdf = buildSampleShapeLattice(job.shape, job.sphereRadius, job.params, job.generationSeed);
  const field = sampleSdfField(sdf, job.bounds, job.cells);
  const [cx, cy, cz] = job.cells;
  const [ox, oy, oz] = job.origin;
  const { min, max } = job.bounds;
  const dx = (max[0] - min[0]) / cx;
  const dy = (max[1] - min[1]) / cy;
  const dz = (max[2] - min[2]) / cz;

  if (shouldApplyEscapeHoles(job.params)) {
    const centers = resolveEscapeHoleCenters(job.gridBounds, job.params);
    let index = 0;
    for (let z = 0; z <= cz; z++) {
      const pz = min[2] + z * dz;
      for (let y = 0; y <= cy; y++) {
        const py = min[1] + y * dy;
        for (let x = 0; x <= cx; x++, index++) {
          const hole = escapeHolesSdf(
            min[0] + x * dx, py, pz, centers, job.params.escapeHoleAxis, job.params.escapeHoleDiameter,
          );
          field[index] = Math.max(field[index], -hole);
        }
      }
    }
  }

  // Seal only samples on the whole grid's outer faces (iso 0 -> outside = 1).
  const [nx, ny, nz] = job.gridCells;
  let index = 0;
  for (let z = 0; z <= cz; z++) {
    const zFace = oz + z === 0 || oz + z === nz;
    for (let y = 0; y <= cy; y++) {
      const yFace = oy + y === 0 || oy + y === ny;
      for (let x = 0; x <= cx; x++, index++) {
        if (!(zFace || yFace || ox + x === 0 || ox + x === nx)) continue;
        if (field[index] <= 0) field[index] = 1;
      }
    }
  }

  return marchingCubesFromField(field, job.bounds, job.cells, 0);
}
