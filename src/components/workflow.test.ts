import { describe, expect, it } from 'vitest';
import { adjacentStep, canNavigateToStep, reachableStep, stepStatus, visibleSteps, type WorkflowInputs } from './workflow';

const base: WorkflowInputs = {
  hasModel: true,
  hasImportedMesh: true,
  demoModeActive: false,
  hasResult: false,
  resultStale: false,
  validationPassed: null,
  paintedFaces: 0,
  preflightBlocked: false,
};

describe('guided workflow', () => {
  it('drops the painting step for procedural samples', () => {
    expect(visibleSteps(base).map((step) => step.id)).toEqual(['model', 'regions', 'lattice', 'shell', 'generate', 'results']);
    expect(visibleSteps({ ...base, hasImportedMesh: false }).map((step) => step.id)).not.toContain('regions');
  });

  it('only opens Model before a part is loaded', () => {
    const empty = { ...base, hasModel: false, hasImportedMesh: false };
    expect(canNavigateToStep('model', empty)).toBe(true);
    for (const step of ['regions', 'lattice', 'shell', 'generate', 'results'] as const) {
      expect(canNavigateToStep(step, empty)).toBe(false);
    }
  });

  it('opens Results only once a result exists', () => {
    expect(canNavigateToStep('results', base)).toBe(false);
    expect(canNavigateToStep('results', { ...base, hasResult: true })).toBe(true);
  });

  it('lets multiview reach the lattice step without a model but never generate', () => {
    const demo = { ...base, hasModel: false, hasImportedMesh: false, demoModeActive: true };
    expect(canNavigateToStep('lattice', demo)).toBe(true);
    expect(canNavigateToStep('generate', demo)).toBe(false);
  });

  it('marks a blocked preflight with a reason instead of a tick', () => {
    const state = stepStatus('generate', { ...base, preflightBlocked: true, hasResult: true });
    expect(state.status).toBe('blocked');
    expect(state.reason).toBeTruthy();
  });

  it('never ticks the settings steps on defaults alone', () => {
    expect(stepStatus('lattice', base).status).toBe('idle');
    expect(stepStatus('shell', base).status).toBe('idle');
    expect(stepStatus('regions', { ...base, paintedFaces: 3 }).status).toBe('done');
  });

  it('flags a stale result rather than calling it done', () => {
    expect(stepStatus('generate', { ...base, hasResult: true }).status).toBe('done');
    expect(stepStatus('generate', { ...base, hasResult: true, resultStale: true }).status).toBe('attention');
    expect(stepStatus('results', { ...base, hasResult: true, validationPassed: true, resultStale: true }).status).toBe('attention');
  });

  it('ticks Results only after validation passes', () => {
    expect(stepStatus('results', { ...base, hasResult: true }).status).toBe('idle');
    expect(stepStatus('results', { ...base, hasResult: true, validationPassed: true }).status).toBe('done');
    expect(stepStatus('results', { ...base, hasResult: true, validationPassed: false }).status).toBe('blocked');
  });

  it('skips hidden steps when moving back and forth', () => {
    const sample = { ...base, hasImportedMesh: false };
    expect(adjacentStep('model', sample, 1)?.id).toBe('lattice');
    expect(adjacentStep('lattice', sample, -1)?.id).toBe('model');
    expect(adjacentStep('results', sample, 1)).toBeUndefined();
  });

  it('falls back to the nearest reachable step when the current one disappears', () => {
    const sample = { ...base, hasImportedMesh: false };
    expect(reachableStep('regions', sample)).toBe('model');
    expect(reachableStep('results', base)).toBe('generate');
    expect(reachableStep('shell', { ...base, hasModel: false, hasImportedMesh: false })).toBe('model');
  });
});
