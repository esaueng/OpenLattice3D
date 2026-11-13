// What to do about a result: which validation warnings deserve attention and
// the next step for each failing check. Pure so the advice is unit-tested; the
// Results panel only renders it and wires the actions to the store.
import type { WorkflowStep } from '../store/useStore';
import type { LatticeParams, ValidationResult } from '../types/project';
import type { ModelExtents } from './model-summary';
import { MAX_RESOLUTION_LEVEL, minimumResolutionForFeature, resolvedFeature } from './preflight';

/** A jump to the control that fixes something, optionally applying a parameter change first. */
export interface GuidanceAction {
  label: string;
  step: WorkflowStep;
  /** Element id of the control to reveal and focus on that step. */
  controlId?: string;
  params?: Partial<LatticeParams>;
}

export type ResultNoteKind =
  | 'trapped-voids'
  | 'thin-filter-skipped'
  | 'fdm-open-lattice'
  | 'sliver'
  | 'repeats-check'
  | 'other';

export interface ResultNote {
  kind: ResultNoteKind;
  message: string;
  /** Actionable notes turn a pass into "passed with warnings"; the rest are informational. */
  actionable: boolean;
  action?: GuidanceAction;
}

export const ESCAPE_HOLES_ACTION: GuidanceAction = {
  label: 'Set up escape holes',
  step: 'shell',
  controlId: 'escape-holes',
};

// The validation workers report warnings as text; these patterns follow the
// producers in geometry/validation.ts and workers/validation-core.ts.
function classifyWarning(message: string): Omit<ResultNote, 'message' | 'action'> {
  if (/trapped/i.test(message)) return { kind: 'trapped-voids', actionable: true };
  if (/^Cannot remove features/i.test(message)) return { kind: 'thin-filter-skipped', actionable: true };
  if (/^FDM with open lattice/i.test(message)) return { kind: 'fdm-open-lattice', actionable: true };
  if (/sliver/i.test(message) && /negligible/i.test(message)) return { kind: 'sliver', actionable: false };
  // These restate a check that already failed, or a check that has nothing to compare against.
  if (/separate solid bodies detected$/.test(message)
    || /could not be measured$/.test(message)
    || /^No reference mesh/.test(message)) {
    return { kind: 'repeats-check', actionable: false };
  }
  return { kind: 'other', actionable: true };
}

/**
 * Lowest level that is both above the run's level and fine enough to resolve
 * the wall or strut, or null when the run was already at the finest level.
 */
export function suggestedResolution(runParams: LatticeParams, extents: ModelExtents | null): number | null {
  if (runParams.exportResolution >= MAX_RESOLUTION_LEVEL) return null;
  const resolving = minimumResolutionForFeature(runParams, extents) ?? MAX_RESOLUTION_LEVEL;
  return Math.min(MAX_RESOLUTION_LEVEL, Math.max(runParams.exportResolution + 1, resolving));
}

function raiseResolutionAction(level: number | null, currentParams: LatticeParams): GuidanceAction | undefined {
  if (level === null) return undefined;
  if (currentParams.exportResolution >= level) {
    return { label: 'Go to Generate', step: 'generate', controlId: 'export-resolution' };
  }
  return { label: `Raise resolution to ${level}`, step: 'generate', controlId: 'export-resolution', params: { exportResolution: level } };
}

function thickenAction(runParams: LatticeParams): GuidanceAction {
  const { label } = resolvedFeature(runParams);
  return label === 'Wall thickness'
    ? { label: 'Thicken walls', step: 'lattice', controlId: 'wall-thickness' }
    : { label: 'Thicken struts', step: 'lattice', controlId: 'strut-diameter' };
}

export interface GuidanceContext {
  /** Parameters the result was generated with. */
  runParams: LatticeParams;
  /** Parameters as they are now, so an action never lowers a level already raised. */
  currentParams: LatticeParams;
  extents: ModelExtents | null;
}

export function resultNotes(validation: ValidationResult, context?: GuidanceContext): ResultNote[] {
  return validation.warnings.map((message) => {
    const { kind, actionable } = classifyWarning(message);
    let action: GuidanceAction | undefined;
    if (kind === 'trapped-voids') action = ESCAPE_HOLES_ACTION;
    if (kind === 'thin-filter-skipped' && context) {
      action = raiseResolutionAction(suggestedResolution(context.runParams, context.extents), context.currentParams);
    }
    return { kind, message, actionable, action };
  });
}

/** Warnings that should keep a passing result from reading as an unqualified pass. */
export function actionableWarningCount(validation: ValidationResult): number {
  return validation.warnings.filter((message) => classifyWarning(message).actionable).length;
}

export type CheckId = 'outerDeviation' | 'minThickness' | 'manifold' | 'connectivity';

export interface CheckSuggestion {
  text: string;
  action?: GuidanceAction;
}

/** A short next step for a failing check, or null when it passed. */
export function checkSuggestion(check: CheckId, validation: ValidationResult, context: GuidanceContext): CheckSuggestion | null {
  const { runParams, currentParams, extents } = context;
  const nextLevel = suggestedResolution(runParams, extents);
  const raise = raiseResolutionAction(nextLevel, currentParams);
  const feature = resolvedFeature(runParams);
  const featureNoun = feature.label === 'Wall thickness' ? 'walls' : 'struts';

  switch (check) {
    case 'outerDeviation': {
      if (validation.outerDeviation.passed) return null;
      if (validation.outerDeviation.sampled === 0) {
        return { text: 'Deviation could not be measured. Regenerate at a higher resolution.', action: raise };
      }
      return raise
        ? { text: 'Finer voxels follow the outer surface more closely. Raise the resolution, or loosen the tolerance if this deviation is acceptable.', action: raise }
        : { text: 'Already at the finest resolution. Loosen the tolerance if this deviation is acceptable.', action: { label: 'Adjust tolerance', step: 'generate', controlId: 'tolerance' } };
    }
    case 'minThickness': {
      if (validation.minThickness.passed) return null;
      if (validation.minThickness.sampled === 0) {
        return { text: 'Thickness could not be measured. Regenerate at a higher resolution.', action: raise };
      }
      const required = validation.minThickness.required;
      if (!runParams.noShell && !runParams.surfaceOnly && runParams.shellThickness < required) {
        return {
          text: `The shell is ${runParams.shellThickness} mm, under the ${required} mm minimum. Thicken the shell.`,
          action: { label: 'Thicken shell', step: 'shell', controlId: 'shell-thickness' },
        };
      }
      return {
        text: feature.sizeMm < required
          ? `${feature.label} is ${feature.sizeMm} mm, under the ${required} mm minimum. Thicken the ${featureNoun}, or lower the minimum if your process allows it.`
          : `Some ${featureNoun} come out thinner than ${required} mm. Thicken them, or raise the resolution so they are not eroded by coarse voxels.`,
        action: thickenAction(runParams),
      };
    }
    case 'manifold':
      if (validation.manifold.passed) return null;
      return raise
        ? { text: 'Open or non-manifold edges usually come from features thinner than the sampling grid. Raise the resolution.', action: raise }
        : { text: `Open or non-manifold edges usually come from features thinner than the sampling grid. Thicken the ${featureNoun}.`, action: thickenAction(runParams) };
    case 'connectivity': {
      if (validation.disconnected.passed) return null;
      const why = `Loose pieces form where ${featureNoun} are too thin for the grid and break apart; they fall out of the print.`;
      return raise
        ? { text: `${why} Raise the resolution or thicken the ${featureNoun}.`, action: raise }
        : { text: `${why} Thicken the ${featureNoun}.`, action: thickenAction(runParams) };
    }
  }
}
