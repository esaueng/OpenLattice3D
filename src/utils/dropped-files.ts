// Which dropped file to import, decided by name alone. The file itself is read
// later by the same intake path as the file pickers, on this device only.

export type ModelFileKind = 'stl' | 'project';

export function classifyModelFile(name: string): ModelFileKind | null {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.json')) return 'project';
  return null;
}

/**
 * The file a drop should import: the first STL, else the first project JSON,
 * else the first file (so an unsupported drop still gets an explanation).
 */
export function pickDroppedFile<T extends { name: string }>(files: readonly T[]): T | null {
  return files.find((file) => classifyModelFile(file.name) === 'stl')
    ?? files.find((file) => classifyModelFile(file.name) === 'project')
    ?? files[0]
    ?? null;
}

/** Whether a drag carries files (as opposed to text or a link being dragged). */
export function dragCarriesFiles(types: readonly string[] | null | undefined): boolean {
  return Boolean(types && Array.from(types).includes('Files'));
}
