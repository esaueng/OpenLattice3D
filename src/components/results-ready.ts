// What happens on screen when a generation run finishes, depending on where the
// user was. Pure so the rules are unit-tested without a DOM.
import type { WorkflowStep } from '../store/useStore';

/**
 * - 'show-results': go straight to Results (the run was watched from Generate).
 * - 'offer-results': stay put, but offer a "Results ready" shortcut. Runs
 *   started from the top bar while tweaking Model, Regions, Lattice or Shell
 *   must not yank the user away from what they were editing.
 * - 'none': nothing to announce.
 */
export type RunFinishAction = 'show-results' | 'offer-results' | 'none';

/** Steps whose purpose is the run and its result; finishing there needs no shortcut. */
const RUN_STEPS: ReadonlySet<WorkflowStep> = new Set<WorkflowStep>(['generate', 'results']);

export interface RunFinish {
  /** The step the user was on when the run started. */
  startedOnStep: WorkflowStep;
  /** The step the user is on now that it has finished. */
  currentStep: WorkflowStep;
  /** A result is on screen after the run (possibly the previous one). */
  hasResult: boolean;
  /** The run produced a new result (not cancelled, failed or empty). */
  newResult: boolean;
}

export function runFinishAction({ startedOnStep, currentStep, hasResult, newResult }: RunFinish): RunFinishAction {
  if (!hasResult) return 'none';
  // Unchanged rule: finishing while on Generate lands on the result.
  if (currentStep === 'generate') return 'show-results';
  if (!newResult || currentStep === 'results') return 'none';
  if (RUN_STEPS.has(startedOnStep)) return 'none';
  return 'offer-results';
}

/** The offer goes away once the user is on Results, a new run starts, or the result is gone. */
export function keepResultsOffer({ currentStep, generating, hasResult }: {
  currentStep: WorkflowStep;
  generating: boolean;
  hasResult: boolean;
}): boolean {
  return hasResult && !generating && currentStep !== 'results';
}
