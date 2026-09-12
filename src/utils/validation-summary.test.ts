import { describe, expect, it } from 'vitest';
import type { ValidationResult } from '../types/project';
import { summarizeValidation } from './validation-summary';

function makeValidation(overrides: Partial<Record<'outer' | 'thickness' | 'manifold' | 'connected', boolean>> = {}): ValidationResult {
  const { outer = true, thickness = true, manifold = true, connected = true } = overrides;
  return {
    passed: outer && thickness && manifold && connected,
    outerDeviation: { passed: outer, maxDeviation: 0.1, tolerance: 0.2 },
    minThickness: { passed: thickness, minMeasured: 0.9, required: 0.8, absoluteMin: 0.5, sampled: 100 },
    manifold: { passed: manifold, details: 'ok' },
    disconnected: { passed: connected, fragmentCount: connected ? 1 : 3 },
    warnings: [],
  };
}

describe('summarizeValidation', () => {
  it('reports no result before anything is generated', () => {
    const s = summarizeValidation(null, false, false);
    expect(s.tone).toBe('idle');
    expect(s.label).toBe('Checks: no result yet');
  });

  it('reports a run in progress ahead of any stale verdict', () => {
    const s = summarizeValidation(makeValidation(), true, true);
    expect(s.tone).toBe('running');
    expect(s.label).toBe('Checks: running');
  });

  it('distinguishes a result that was never validated from one that passed', () => {
    const s = summarizeValidation(null, true, false);
    expect(s.tone).toBe('unvalidated');
    expect(s.label).toBe('Checks: not validated');
  });

  it('reports a clean pass', () => {
    const s = summarizeValidation(makeValidation(), true, false);
    expect(s.tone).toBe('pass');
    expect(s.label).toBe('Checks: all 4 passed');
    expect(s.failedCount).toBe(0);
  });

  it('counts and names every failing check', () => {
    const s = summarizeValidation(
      makeValidation({ thickness: false, manifold: false, connected: false }),
      true,
      false,
    );
    expect(s.tone).toBe('fail');
    expect(s.label).toBe('Checks: 3 of 4 failed');
    expect(s.failedCount).toBe(3);
    expect(s.failedLabels).toEqual(['min thickness', 'manifold/watertight', 'connectivity']);
    expect(s.detail).toContain('may not be printable');
  });

  it('reports an out-of-date result ahead of its previous verdict', () => {
    const s = summarizeValidation(makeValidation({ connected: false }), true, false, true);
    expect(s.tone).toBe('stale');
    expect(s.label).toBe('Checks: out of date');
    expect(s.detail).toContain('exports still use the previous result');
    expect(s.detail).toContain('failed 1 of 4 checks (connectivity)');
    expect(s.failedCount).toBe(1);

    const unvalidated = summarizeValidation(null, true, false, true);
    expect(unvalidated.tone).toBe('stale');
    expect(unvalidated.detail).toContain('never validated');
  });

  it('lets a running generation outrank a stale flag', () => {
    expect(summarizeValidation(makeValidation(), true, true, true).tone).toBe('running');
  });

  it('reports validation progress once the mesh has landed', () => {
    const s = summarizeValidation(null, true, false, false, 0.4);
    expect(s.tone).toBe('running');
    expect(s.label).toBe('Checks: validating 40%');
  });
});
