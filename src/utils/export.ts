// Export utilities: STL and project JSON downloads
import { exportBinarySTL } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import type { ValidationResult, LatticeParams } from '../types/project';

export function downloadSTL(result: MarchingCubesResult, filename: string = 'lattice-design.stl') {
  const buffer = exportBinarySTL(result.positions, result.normals, result.triCount);
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Export project data as JSON (includes parameters, selections, validation) */
export function downloadProjectJSON(
  params: LatticeParams,
  meshFileName: string,
  keepOutTris: Set<number>,
  keepInTris: Set<number>,
  validation: ValidationResult | null,
) {
  const project = {
    meshAssetName: meshFileName,
    selectionMask: {
      keepOut: Array.from(keepOutTris),
      keepIn: Array.from(keepInTris),
    },
    parameters: params,
    validation: validation,
  };
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lattice-project.json';
  a.click();
  URL.revokeObjectURL(url);
}
