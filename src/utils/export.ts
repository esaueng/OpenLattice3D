// Export utilities: manufacturing meshes and project JSON.
import { exportBinarySTL } from '../geometry/stl-parser';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { buildIndexedMesh, type IndexedMesh } from '../geometry/mesh-indexing';
import { decimateMesh } from '../geometry/decimate';
import { create3MF } from '../geometry/three-mf';
import { createProjectFile, type ProjectExportInput } from './project-file';
import { buildObj, type ObjOptions } from './obj';
import { formatGenerationSeed } from '../geometry/deterministic-random';

export interface MeshExportOptions {
  /** Fraction of triangles to keep. */
  simplifyRatio?: number;
  /** Largest deviation a collapse may introduce, in millimetres. */
  maxError?: number;
  /** Reproducibility seed embedded in metadata-capable exports. */
  generationSeed?: number;
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function prepareMesh(
  result: MarchingCubesResult,
  options: MeshExportOptions = {},
): IndexedMesh {
  const indexed = buildIndexedMesh(result);
  const ratio = options.simplifyRatio ?? 1;
  if (ratio >= 1) return indexed;
  return decimateMesh(indexed, {
    targetRatio: ratio,
    maxError: options.maxError,
  }).mesh;
}

/** Expand indexed output back to a triangle soup with face normals. */
function toSoup(mesh: IndexedMesh): MarchingCubesResult {
  const positions = new Float32Array(mesh.triangleCount * 9);
  const normals = new Float32Array(mesh.triangleCount * 3);
  for (let triangle = 0; triangle < mesh.triangleCount; triangle++) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = mesh.indices[triangle * 3 + corner];
      const source = vertex * 3;
      const target = triangle * 9 + corner * 3;
      positions[target] = mesh.positions[source];
      positions[target + 1] = mesh.positions[source + 1];
      positions[target + 2] = mesh.positions[source + 2];
    }

    const offset = triangle * 9;
    const e1x = positions[offset + 3] - positions[offset];
    const e1y = positions[offset + 4] - positions[offset + 1];
    const e1z = positions[offset + 5] - positions[offset + 2];
    const e2x = positions[offset + 6] - positions[offset];
    const e2y = positions[offset + 7] - positions[offset + 1];
    const e2z = positions[offset + 8] - positions[offset + 2];
    const nx = e1y * e2z - e1z * e2y;
    const ny = e1z * e2x - e1x * e2z;
    const nz = e1x * e2y - e1y * e2x;
    const length = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (length > 1e-12) {
      normals[triangle * 3] = nx / length;
      normals[triangle * 3 + 1] = ny / length;
      normals[triangle * 3 + 2] = nz / length;
    }
  }
  return { positions, normals, triCount: mesh.triangleCount };
}

function preparedSoup(
  result: MarchingCubesResult,
  options: MeshExportOptions,
): MarchingCubesResult {
  return (options.simplifyRatio ?? 1) >= 1
    ? result
    : toSoup(prepareMesh(result, options));
}

export function downloadSTL(
  result: MarchingCubesResult,
  filename: string = 'lattice-design.stl',
  options: MeshExportOptions = {},
) {
  const source = preparedSoup(result, options);
  const buffer = exportBinarySTL(
    source.positions,
    source.normals,
    source.triCount,
    options.generationSeed === undefined
      ? 'OpenLattice3D Export'
      : `OpenLattice3D seed-${formatGenerationSeed(options.generationSeed)}`,
  );
  saveBlob(new Blob([buffer], { type: 'application/octet-stream' }), filename);
}

export function download3MF(
  result: MarchingCubesResult,
  filename: string = 'lattice-design.3mf',
  options: MeshExportOptions = {},
) {
  const bytes = create3MF(preparedSoup(result, options), options.generationSeed);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  saveBlob(new Blob([buffer], { type: 'model/3mf' }), filename);
}

export function downloadOBJ(
  result: MarchingCubesResult,
  objOptions: ObjOptions,
  filename: string = 'lattice-design.obj',
  options: MeshExportOptions = {},
) {
  const bytes = buildObj(prepareMesh(result, options), {
    ...objOptions,
    generationSeed: options.generationSeed,
  });
  saveBlob(new Blob([bytes as BlobPart], { type: 'model/obj' }), filename);
}

/** Export project data as JSON (includes parameters, selections, validation). */
export function downloadProjectJSON(input: ProjectExportInput) {
  const project = createProjectFile(input);
  const json = JSON.stringify(project, null, 2);
  saveBlob(new Blob([json], { type: 'application/json' }), 'lattice-project.json');
}
