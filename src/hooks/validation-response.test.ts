import { describe, expect, it } from 'vitest';
import type { ValidationResult } from '../types/project';
import { isValidationResult, parseValidationResponse } from './validation-response';

const validation: ValidationResult = {
  passed: true,
  outerDeviation: { passed: true, maxDeviation: 0.05, tolerance: 0.2, sampled: 2000 },
  minThickness: { passed: true, minMeasured: 1, required: 0.8, absoluteMin: 0.9, sampled: 10, thinPoints: [] },
  manifold: { passed: true, details: 'Mesh is manifold and watertight' },
  disconnected: { passed: true, fragmentCount: 1, voidCount: 2, sliverCount: 0 },
  warnings: ['note'],
};

const TRAPPED = '1 enclosed void network and no escape holes: trapped powder/resin likely';
const coded: ValidationResult = {
  ...validation,
  warnings: [TRAPPED],
  warningDetails: [{ code: 'trapped-voids', message: TRAPPED }],
};

type Mutable = Record<string, unknown>;
function withField(path: string, value: unknown): unknown {
  const copy = structuredClone(validation) as unknown as Mutable;
  const keys = path.split('.');
  let target = copy;
  for (const key of keys.slice(0, -1)) target = target[key] as Mutable;
  if (value === undefined) delete target[keys.at(-1)!];
  else target[keys.at(-1)!] = value;
  return copy;
}

describe('parseValidationResponse', () => {
  it('accepts progress posts with a fraction, a message or both', () => {
    expect(parseValidationResponse({ type: 'progress', progress: 0.5 })).toEqual({ type: 'progress', progress: 0.5 });
    expect(parseValidationResponse({ type: 'progress', message: 'Validation running...' }))
      .toEqual({ type: 'progress', message: 'Validation running...' });
    expect(parseValidationResponse({ type: 'progress', progress: 1, message: 'done' }))
      .toEqual({ type: 'progress', progress: 1, message: 'done' });
  });

  it.each([
    ['empty progress', { type: 'progress' }],
    ['out-of-range progress', { type: 'progress', progress: 1.5 }],
    ['negative progress', { type: 'progress', progress: -0.1 }],
    ['NaN progress', { type: 'progress', progress: Number.NaN }],
    ['string progress', { type: 'progress', progress: '0.5' }],
    ['non-string message', { type: 'progress', message: 3 }],
  ])('rejects %s', (_name, value) => {
    expect(parseValidationResponse(value)).toBeNull();
  });

  it('accepts a complete result, including older results without deviation sample counts', () => {
    expect(parseValidationResponse({ type: 'result', validation })).toEqual({ type: 'result', validation });
    const legacy = withField('outerDeviation.sampled', undefined);
    expect(parseValidationResponse({ type: 'result', validation: legacy })).toEqual({ type: 'result', validation: legacy });
    const minimal = withField('minThickness.thinPoints', undefined);
    expect(parseValidationResponse({ type: 'result', validation: minimal })).not.toBeNull();
  });

  it('accepts coded warnings that restate the plain warnings in order', () => {
    expect(parseValidationResponse({ type: 'result', validation: coded })).toEqual({ type: 'result', validation: coded });
    const empty = { ...validation, warnings: [], warningDetails: [] };
    expect(parseValidationResponse({ type: 'result', validation: empty })).toEqual({ type: 'result', validation: empty });
  });

  it.each([
    ['non-array warning details', { ...coded, warningDetails: 'trapped-voids' }],
    ['an unknown warning code', { ...coded, warningDetails: [{ code: 'bogus', message: TRAPPED }] }],
    ['a missing warning code', { ...coded, warningDetails: [{ message: TRAPPED }] }],
    ['a detail whose message differs from warnings', { ...coded, warningDetails: [{ code: 'trapped-voids', message: 'other' }] }],
    ['fewer details than warnings', { ...coded, warnings: [TRAPPED, 'extra'] }],
    ['more details than warnings', { ...coded, warnings: [] }],
  ])('rejects a result with %s', (_name, value) => {
    expect(parseValidationResponse({ type: 'result', validation: value })).toBeNull();
    expect(isValidationResult(value)).toBe(false);
  });

  it.each([
    ['missing validation', undefined],
    ['null validation', null],
    ['array validation', []],
    ['missing passed', withField('passed', undefined)],
    ['missing outerDeviation', withField('outerDeviation', undefined)],
    ['string maxDeviation', withField('outerDeviation.maxDeviation', '0.1')],
    ['NaN maxDeviation', withField('outerDeviation.maxDeviation', Number.NaN)],
    ['negative maxDeviation', withField('outerDeviation.maxDeviation', -1)],
    ['infinite tolerance', withField('outerDeviation.tolerance', Number.POSITIVE_INFINITY)],
    ['fractional deviation sample count', withField('outerDeviation.sampled', 1.5)],
    ['missing minThickness', withField('minThickness', undefined)],
    ['missing thickness sample count', withField('minThickness.sampled', undefined)],
    ['non-triple thin points', withField('minThickness.thinPoints', [1, 2])],
    ['non-numeric thin points', withField('minThickness.thinPoints', [1, 2, 'x'])],
    ['missing manifold details', withField('manifold.details', undefined)],
    ['negative fragment count', withField('disconnected.fragmentCount', -1)],
    ['string void count', withField('disconnected.voidCount', '2')],
    ['missing warnings', withField('warnings', undefined)],
    ['non-string warning', withField('warnings', [1])],
  ])('rejects a result with %s', (_name, value) => {
    expect(parseValidationResponse({ type: 'result', validation: value })).toBeNull();
    if (value !== undefined) expect(isValidationResult(value)).toBe(false);
  });

  it('accepts errors with a message and rejects blank ones', () => {
    expect(parseValidationResponse({ type: 'error', message: 'boom' })).toEqual({ type: 'error', message: 'boom' });
    expect(parseValidationResponse({ type: 'error' })).toBeNull();
    expect(parseValidationResponse({ type: 'error', message: '  ' })).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'result'],
    ['an unknown type', { type: 'validation', validation }],
    ['no type', { validation }],
  ])('rejects %s', (_name, value) => {
    expect(parseValidationResponse(value)).toBeNull();
  });
});
