// Shape checks for messages coming back from the validation worker. Anything
// that does not match is rejected rather than rendered as a verdict.
import { isValidationWarningCode, type ValidationResult } from '../types/project';
import { parseFailureCause, type FailureCause } from '../utils/failure-cause';

export type ValidationProgressResponse = {
  type: 'progress';
  /** 0..1 thickness-sampling progress; absent on message-only posts. */
  progress?: number;
  message?: string;
};

export type ValidationResultResponse = {
  type: 'result';
  validation: ValidationResult;
};

export type ValidationErrorResponse = {
  type: 'error';
  message: string;
  diagnostic?: FailureCause;
};

export type ParsedValidationResponse =
  | ValidationProgressResponse
  | ValidationResultResponse
  | ValidationErrorResponse;

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalCount(value: unknown): boolean {
  return value === undefined || isCount(value);
}

function isOuterDeviation(value: unknown): boolean {
  return isRecord(value)
    && typeof value.passed === 'boolean'
    && isFiniteNumber(value.maxDeviation)
    && value.maxDeviation >= 0
    && isFiniteNumber(value.tolerance)
    && isOptionalCount(value.sampled);
}

function isMinThickness(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const { thinPoints } = value;
  return typeof value.passed === 'boolean'
    && isFiniteNumber(value.minMeasured)
    && isFiniteNumber(value.required)
    && isFiniteNumber(value.absoluteMin)
    && isCount(value.sampled)
    && (thinPoints === undefined || (
      Array.isArray(thinPoints)
      && thinPoints.length % 3 === 0
      && thinPoints.every(isFiniteNumber)
    ));
}

function isManifold(value: unknown): boolean {
  return isRecord(value) && typeof value.passed === 'boolean' && typeof value.details === 'string';
}

function isDisconnected(value: unknown): boolean {
  return isRecord(value)
    && typeof value.passed === 'boolean'
    && isCount(value.fragmentCount)
    && isOptionalCount(value.voidCount)
    && isOptionalCount(value.sliverCount);
}

function isWarningList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((warning) => typeof warning === 'string');
}

/**
 * Coded warnings are optional (older results have none), but when present
 * every entry needs a known code and they must restate `warnings` in order,
 * so classifying by code and showing the text can never disagree.
 */
function isWarningDetails(value: unknown, warnings: string[]): boolean {
  if (value === undefined) return true;
  return Array.isArray(value)
    && value.length === warnings.length
    && value.every((detail, index) => isRecord(detail)
      && isValidationWarningCode(detail.code)
      && detail.message === warnings[index]);
}

export function isValidationResult(value: unknown): value is ValidationResult {
  return isRecord(value)
    && typeof value.passed === 'boolean'
    && isOuterDeviation(value.outerDeviation)
    && isMinThickness(value.minThickness)
    && isManifold(value.manifold)
    && isDisconnected(value.disconnected)
    && isWarningList(value.warnings)
    && isWarningDetails(value.warningDetails, value.warnings);
}

/**
 * Parse one validation-worker message, mirroring `parseGenerationResponse`.
 * Returns null for anything malformed so the caller can fail the run instead
 * of storing a partial or invented verdict.
 */
export function parseValidationResponse(value: unknown): ParsedValidationResponse | null {
  if (!isRecord(value)) return null;
  if (value.type === 'progress') {
    const { progress, message } = value;
    if (progress !== undefined && (!isFiniteNumber(progress) || progress < 0 || progress > 1)) return null;
    if (message !== undefined && typeof message !== 'string') return null;
    if (progress === undefined && message === undefined) return null;
    return {
      type: 'progress',
      ...(progress !== undefined ? { progress } : {}),
      ...(message !== undefined ? { message } : {}),
    };
  }
  if (value.type === 'result') {
    if (!isValidationResult(value.validation)) return null;
    return { type: 'result', validation: value.validation };
  }
  if (value.type === 'error') {
    if (typeof value.message !== 'string' || value.message.trim().length === 0) return null;
    const diagnostic = parseFailureCause(value.diagnostic);
    return { type: 'error', message: value.message, ...(diagnostic ? { diagnostic } : {}) };
  }
  return null;
}
