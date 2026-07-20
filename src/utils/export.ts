// Export utilities: STL and project JSON downloads
import { exportBinarySTL } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { createProjectFile, type ProjectExportInput } from './project-file';
import { create3MF } from '../geometry/three-mf';

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

export function download3MF(result: MarchingCubesResult, filename: string = 'lattice-design.3mf') {
  const bytes = create3MF(result);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const blob = new Blob([buffer], { type: 'model/3mf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Export project data as JSON (includes parameters, selections, validation) */
export function downloadProjectJSON(input: ProjectExportInput) {
  const project = createProjectFile(input);
  const json = JSON.stringify(project, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'lattice-project.json';
  a.click();
  URL.revokeObjectURL(url);
}
