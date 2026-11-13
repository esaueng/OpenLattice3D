import { describe, expect, it } from 'vitest';
import { keepResultsOffer, runFinishAction, type RunFinish } from './results-ready';
import type { WorkflowStep } from '../store/useStore';

const finished = (overrides: Partial<RunFinish>): RunFinish => ({
  startedOnStep: 'lattice',
  currentStep: 'lattice',
  hasResult: true,
  newResult: true,
  ...overrides,
});

describe('runFinishAction', () => {
  it('offers the result, without navigating, after a top-bar run from an editing step', () => {
    for (const step of ['model', 'regions', 'lattice', 'shell'] as WorkflowStep[]) {
      expect(runFinishAction(finished({ startedOnStep: step, currentStep: step })), step).toBe('offer-results');
    }
    // Also when the user moved to another editing step during the run.
    expect(runFinishAction(finished({ startedOnStep: 'lattice', currentStep: 'shell' }))).toBe('offer-results');
  });

  it('still lands on Results when the run finishes on the Generate step', () => {
    expect(runFinishAction(finished({ startedOnStep: 'generate', currentStep: 'generate' }))).toBe('show-results');
    expect(runFinishAction(finished({ startedOnStep: 'lattice', currentStep: 'generate' }))).toBe('show-results');
    // Unchanged from before: any result on screen counts there.
    expect(runFinishAction(finished({ currentStep: 'generate', newResult: false }))).toBe('show-results');
  });

  it('offers nothing when the user is already on Results', () => {
    expect(runFinishAction(finished({ startedOnStep: 'lattice', currentStep: 'results' }))).toBe('none');
    expect(runFinishAction(finished({ startedOnStep: 'results', currentStep: 'results' }))).toBe('none');
  });

  it('offers nothing for runs started from Generate or Results', () => {
    expect(runFinishAction(finished({ startedOnStep: 'generate', currentStep: 'lattice' }))).toBe('none');
    expect(runFinishAction(finished({ startedOnStep: 'results', currentStep: 'shell' }))).toBe('none');
  });

  it('offers nothing when the run left no new result (cancelled, failed or empty)', () => {
    expect(runFinishAction(finished({ newResult: false }))).toBe('none');
    expect(runFinishAction(finished({ hasResult: false, newResult: false }))).toBe('none');
    expect(runFinishAction(finished({ currentStep: 'generate', hasResult: false, newResult: false }))).toBe('none');
  });
});

describe('keepResultsOffer', () => {
  it('keeps the offer while the user stays off Results with the result in place', () => {
    expect(keepResultsOffer({ currentStep: 'lattice', generating: false, hasResult: true })).toBe(true);
    expect(keepResultsOffer({ currentStep: 'generate', generating: false, hasResult: true })).toBe(true);
  });

  it('drops the offer on Results, when a new run starts, or when the result is cleared', () => {
    expect(keepResultsOffer({ currentStep: 'results', generating: false, hasResult: true })).toBe(false);
    expect(keepResultsOffer({ currentStep: 'lattice', generating: true, hasResult: true })).toBe(false);
    expect(keepResultsOffer({ currentStep: 'lattice', generating: false, hasResult: false })).toBe(false);
  });
});
