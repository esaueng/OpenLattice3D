export const MAX_DEMO_GRID_RESOLUTION = 96;

export function demoGridResolution(exportResolution: number): number {
  const normalized = Number.isFinite(exportResolution)
    ? Math.max(1, Math.min(10, exportResolution))
    : 1;
  return Math.min(MAX_DEMO_GRID_RESOLUTION, Math.round(24 + normalized * 24));
}

export function demoGridWorkerLimit(hasImportedMesh: boolean, hardwareConcurrency = 2): number {
  if (hasImportedMesh) return 1;
  return Math.max(1, Math.min(2, hardwareConcurrency - 1));
}
