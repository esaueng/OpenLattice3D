// The status bar's solver readout and the checks chip while comparing, pure so
// the finished-compare state cannot regress into a permanent busy dot.
import type { GenerationProgressView } from './generation-progress';
import type { ValidationSummary } from './validation-summary';

export interface CompareQueue {
  done: number;
  running: number;
  total: number;
}

export interface SolverStatus {
  text: string;
  tone: 'busy' | 'ready' | 'idle';
}

export function solverStatus(input: {
  generating: boolean;
  progressView: GenerationProgressView;
  demoModeActive: boolean;
  demoQueue: CompareQueue;
  hasModel: boolean;
}): SolverStatus {
  if (input.generating) return { text: input.progressView.text, tone: 'busy' };
  const { demoQueue } = input;
  if (input.demoModeActive && demoQueue.total > 0) {
    if (demoQueue.done < demoQueue.total) {
      return { text: `Comparing ${demoQueue.done} of ${demoQueue.total}`, tone: 'busy' };
    }
    return { text: `Compared ${demoQueue.total} lattices`, tone: 'ready' };
  }
  if (input.demoModeActive) return { text: 'Comparing', tone: 'ready' };
  return input.hasModel ? { text: 'Ready', tone: 'ready' } : { text: 'Idle', tone: 'idle' };
}

/**
 * Compare tiles are coarse previews that are never validated, so the chip
 * says so instead of "no result yet" (the parked result returns on close).
 */
export function compareChecksSummary(): Pick<ValidationSummary, 'tone' | 'label' | 'detail'> {
  return {
    tone: 'idle',
    label: 'Checks: previews not checked',
    detail: 'Compare tiles are low-resolution previews and are not validated. Pick a lattice, close the comparison and generate to run the checks.',
  };
}
