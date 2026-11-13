// What changed between the pinned run and the current result, for the pinned-run panel.
import type { GenerationSnapshot } from '../store/generation-snapshot';
import { paramValuesEqual, type LatticeParams } from '../types/project';

const DIFF_LABELS: Partial<Record<keyof LatticeParams, string>> = {
  latticeType: 'type', variant: 'layout', cellSize: 'cell', cellScale: 'stretch',
  latticeRotationDeg: 'rotation', wallThickness: 'wall', strutDiameter: 'strut',
  gradientEnabled: 'graded density', gradientStrength: 'grading strength',
  shellThickness: 'shell', exportResolution: 'resolution', minFeatureSize: 'min feature',
  toleranceMm: 'tolerance', escapeHoles: 'holes', surfaceOnly: 'surface-only', noShell: 'no shell',
  thinSectionFilter: 'remove thin features', surfaceDepth: 'depth', escapeHoleCount: 'hole count',
  escapeHoleDiameter: 'hole Ø',
};

function formatValue(value: unknown): string {
  return Array.isArray(value) ? `(${value.join(', ')})` : String(value);
}

/** Labelled "before → after" entries; array params compare by value. */
export function diffSnapshotParams(a: GenerationSnapshot | null, b: GenerationSnapshot | null): string[] {
  if (!a || !b) return [];
  const out: string[] = [];
  for (const key of Object.keys(DIFF_LABELS) as (keyof LatticeParams)[]) {
    if (!paramValuesEqual(a.params[key], b.params[key])) {
      out.push(`${DIFF_LABELS[key]} ${formatValue(a.params[key])} → ${formatValue(b.params[key])}`);
    }
  }
  if (a.generationSeed !== b.generationSeed) out.push('seed');
  if (a.keepOutCount !== b.keepOutCount || a.keepInCount !== b.keepInCount) out.push('painted faces');
  return out;
}
