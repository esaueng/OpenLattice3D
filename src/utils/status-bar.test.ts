import { describe, expect, it } from 'vitest';
import { describeGenerationProgress } from './generation-progress';
import { compareChecksSummary, solverStatus } from './status-bar';

const idleProgress = describeGenerationProgress(0, '');
const base = { generating: false, progressView: idleProgress, demoModeActive: false, demoQueue: { done: 0, running: 0, total: 0 }, hasModel: true };

describe('solverStatus', () => {
  it('shows the generation phase while generating', () => {
    const progressView = describeGenerationProgress(0.6, 'Marching cubes: 40% (~3s remaining)');
    expect(solverStatus({ ...base, generating: true, progressView })).toEqual({ text: 'Building surface · 60%', tone: 'busy' });
  });

  it('is busy while compare tiles are still running', () => {
    expect(solverStatus({ ...base, demoModeActive: true, demoQueue: { done: 5, running: 2, total: 12 } }))
      .toEqual({ text: 'Comparing 5 of 12', tone: 'busy' });
  });

  it('settles to a completed state once every tile has finished', () => {
    expect(solverStatus({ ...base, demoModeActive: true, demoQueue: { done: 12, running: 0, total: 12 } }))
      .toEqual({ text: 'Compared 12 lattices', tone: 'ready' });
  });

  it('reports ready or idle outside compare', () => {
    expect(solverStatus(base)).toEqual({ text: 'Ready', tone: 'ready' });
    expect(solverStatus({ ...base, hasModel: false })).toEqual({ text: 'Idle', tone: 'idle' });
  });
});

describe('compareChecksSummary', () => {
  it('explains that previews are not validated instead of claiming no result', () => {
    const summary = compareChecksSummary();
    expect(summary.label).toBe('Checks: previews not checked');
    expect(summary.label).not.toMatch(/no result/);
    expect(summary.tone).toBe('idle');
  });
});
