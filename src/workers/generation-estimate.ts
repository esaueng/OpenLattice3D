import type { LatticeParams } from '../types/project';

const LATTICE_COMPLEXITY: Record<LatticeParams['latticeType'], number> = {
  gyroid: 1,
  schwarzP: 1,
  schwarzD: 1.15,
  neovius: 1.2,
  iwp: 1.25,
  bcc: 1.1,
  octet: 1.2,
  diamond: 1.25,
  hexagon: 1.15,
  triangle: 1.1,
  voronoi: 1.7,
  spinodal: 2,
};

export type GenerationEstimate = {
  preSeconds: number;
  marchSeconds: number;
  validationSeconds: number;
  totalSeconds: number;
};

export function estimateGenerationTimings(
  params: LatticeParams,
  resolution: number,
  hasCustomMesh: boolean,
): GenerationEstimate {
  const samples = (resolution + 1) ** 3;
  const cubes = resolution ** 3;
  const latticeFactor = LATTICE_COMPLEXITY[params.latticeType] ?? 1;
  const gradientFactor = params.gradientEnabled ? 1.1 : 1;
  const preSeconds = samples * 2.2e-6 * latticeFactor * gradientFactor;
  const marchSeconds = cubes * 0.9e-6;
  const validationSeconds = (preSeconds + marchSeconds) * (hasCustomMesh ? 0.55 : 0.35);
  return {
    preSeconds,
    marchSeconds,
    validationSeconds,
    totalSeconds: Math.max(0.5, preSeconds + marchSeconds + validationSeconds),
  };
}

export function formatDuration(seconds: number): string {
  if (seconds < 90) return `${Math.round(seconds)}s`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}
