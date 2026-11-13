import type { ValidationResult } from '../types/project';
import { actionableWarningCount } from './result-guidance';

/** 'warn' is a pass that still carries warnings worth acting on (e.g. trapped powder). */
export type ValidationTone = 'idle' | 'running' | 'stale' | 'unvalidated' | 'pass' | 'warn' | 'fail';

export interface ValidationSummary {
  tone: ValidationTone;
  /** Compact statusbar label, e.g. "Checks: 3 of 4 failed". */
  label: string;
  /** Long form, used as the title/description. */
  detail: string;
  failedCount: number;
  totalCount: number;
  failedLabels: string[];
  /** Actionable warnings on a result whose checks all passed. */
  warningCount: number;
}

export const VALIDATION_CHECK_COUNT = 4;

function failingChecks(validation: ValidationResult): string[] {
  const failed: string[] = [];
  if (!validation.outerDeviation.passed) failed.push('outer deviation');
  if (!validation.minThickness.passed) failed.push('min thickness');
  if (!validation.manifold.passed) failed.push('manifold/watertight');
  if (!validation.disconnected.passed) failed.push('connectivity');
  return failed;
}

/**
 * One derivation of the manufacturability verdict, shared by the statusbar and
 * the export button so the two can never disagree.
 */
export function summarizeValidation(
  validation: ValidationResult | null,
  hasResult: boolean,
  generating: boolean,
  stale = false,
  validationProgress: number | null = null,
): ValidationSummary {
  const base = { failedCount: 0, totalCount: VALIDATION_CHECK_COUNT, failedLabels: [] as string[], warningCount: 0 };

  if (!generating && hasResult && validationProgress !== null) {
    return {
      ...base,
      tone: 'running',
      label: `Checks: validating ${Math.round(validationProgress * 100)}%`,
      detail: 'Measuring thickness, deviation and topology of the new result.',
    };
  }

  if (generating) {
    return {
      ...base,
      tone: 'running',
      label: 'Checks: running',
      detail: 'Generating. Checks run when the new result lands; anything exported right now is the previous result.',
    };
  }

  if (!hasResult) {
    return {
      ...base,
      tone: 'idle',
      label: 'Checks: no result yet',
      detail: 'No lattice generated yet. Generate a lattice to run the manufacturability checks.',
    };
  }

  if (stale) {
    const failedLabels = validation ? failingChecks(validation) : [];
    const previous = !validation
      ? 'It was never validated.'
      : failedLabels.length === 0
        ? 'The previous run passed all checks.'
        : `The previous run failed ${failedLabels.length} of ${VALIDATION_CHECK_COUNT} checks (${failedLabels.join(', ')}).`;
    return {
      tone: 'stale',
      label: 'Checks: out of date',
      detail: `Settings changed since this result was generated; exports still use the previous result. ${previous} Regenerate to refresh.`,
      failedCount: failedLabels.length,
      totalCount: VALIDATION_CHECK_COUNT,
      failedLabels,
      warningCount: 0,
    };
  }

  if (!validation) {
    return {
      ...base,
      tone: 'unvalidated',
      label: 'Checks: not validated',
      detail: 'This result was never validated — the last run was cancelled or failed before the checks completed.',
    };
  }

  const failedLabels = failingChecks(validation);

  if (failedLabels.length === 0) {
    const warningCount = actionableWarningCount(validation);
    if (warningCount > 0) {
      const warnings = `${warningCount} warning${warningCount === 1 ? '' : 's'}`;
      return {
        ...base,
        tone: 'warn',
        label: `Checks: passed, ${warnings}`,
        detail: `All ${VALIDATION_CHECK_COUNT} manufacturability checks passed, with ${warnings} to review before printing.`,
        warningCount,
      };
    }
    return {
      ...base,
      tone: 'pass',
      label: `Checks: all ${VALIDATION_CHECK_COUNT} passed`,
      detail: `All ${VALIDATION_CHECK_COUNT} manufacturability checks passed.`,
    };
  }

  return {
    tone: 'fail',
    label: `Checks: ${failedLabels.length} of ${VALIDATION_CHECK_COUNT} failed`,
    detail: `${failedLabels.length} of ${VALIDATION_CHECK_COUNT} manufacturability checks failed (${failedLabels.join(', ')}). The exported mesh may not be printable.`,
    failedCount: failedLabels.length,
    totalCount: VALIDATION_CHECK_COUNT,
    failedLabels,
    warningCount: 0,
  };
}
