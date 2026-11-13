// Which dropped file to import, decided by name alone. The file itself is read
// later by the same intake path as the file pickers, on this device only, and
// the worker confirms the format from its content (a 3MF is a ZIP).
import type { MeshFileFormat } from '../geometry/mesh-limits';

export type ModelFileKind = MeshFileFormat | 'project';

/** Extensions the mesh file picker offers, matching classifyModelFile. */
export const MESH_FILE_ACCEPT = '.stl,.3mf,.obj';

export function classifyModelFile(name: string): ModelFileKind | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.json')) return 'project';
  return null;
}

export function isMeshFileKind(kind: ModelFileKind | null): kind is MeshFileFormat {
  return kind === 'stl' || kind === '3mf' || kind === 'obj';
}

/**
 * The file a drop should import: the first mesh (STL, 3MF or OBJ), else the
 * first project JSON, else the first file (so an unsupported drop still gets
 * an explanation).
 */
export function pickDroppedFile<T extends { name: string }>(files: readonly T[]): T | null {
  return files.find((file) => isMeshFileKind(classifyModelFile(file.name)))
    ?? files.find((file) => classifyModelFile(file.name) === 'project')
    ?? files[0]
    ?? null;
}

/** Whether a drag carries files (as opposed to text or a link being dragged). */
export function dragCarriesFiles(types: readonly string[] | null | undefined): boolean {
  return Boolean(types && Array.from(types).includes('Files'));
}
