// Does loading another model throw away work? Loading a sample, an STL or a full
// project clears the result, painted faces, pinned run and undo history, and
// none of that can be undone, so the UI asks first when any of it exists.

export interface ReplaceableWorkState {
  originalMesh: unknown;
  sphereMode: boolean;
  resultMesh: unknown;
  pinnedRun: unknown;
  keepOutTris: { readonly size: number };
  keepInTris: { readonly size: number };
  demoModeActive: boolean;
}

export interface WorkAtRisk {
  result: boolean;
  paintedFaces: number;
  pinnedRun: boolean;
  comparison: boolean;
}

/** What replacing the current model would discard, or null when nothing would be lost. */
export function workLostByReplacingModel(state: ReplaceableWorkState): WorkAtRisk | null {
  if (!state.originalMesh && !state.sphereMode) return null;
  const risk: WorkAtRisk = {
    result: Boolean(state.resultMesh),
    paintedFaces: state.keepOutTris.size + state.keepInTris.size,
    pinnedRun: Boolean(state.pinnedRun),
    comparison: state.demoModeActive,
  };
  return risk.result || risk.paintedFaces > 0 || risk.pinnedRun || risk.comparison ? risk : null;
}

function joinList(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** "the generated lattice, 120 painted faces and the pinned run" */
export function describeWorkAtRisk(risk: WorkAtRisk): string {
  const items: string[] = [];
  if (risk.result) items.push('the generated lattice');
  if (risk.comparison) items.push('the comparison grid');
  if (risk.paintedFaces > 0) {
    items.push(`${risk.paintedFaces.toLocaleString('en-US')} painted face${risk.paintedFaces === 1 ? '' : 's'}`);
  }
  if (risk.pinnedRun) items.push('the pinned run');
  return joinList(items);
}
