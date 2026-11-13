import { describe, expect, it } from 'vitest';
import { DiagnosedError, failureCause, isOutOfMemoryError, parseFailureCause, workerFailure } from './failure-cause';

describe('failure causes', () => {
  it('classifies browser allocation failures as out of memory', () => {
    for (const error of [
      new RangeError('Array buffer allocation failed'),
      new RangeError('Out of memory'),
      Object.assign(new Error('out of memory'), { name: 'InternalError' }),
    ]) expect(failureCause(error)).toBe('out_of_memory');
  });
  it('does not treat app limits or ordinary errors as out of memory', () => {
    for (const error of [
      new Error('Generation memory limit exceeded'),
      new RangeError('Invalid typed array length: -1'),
      new Error('Free browser memory and try again'),
      'out of memory',
      null,
    ]) {
      expect(isOutOfMemoryError(error)).toBe(false);
      expect(failureCause(error)).toBeUndefined();
    }
  });
  it('keeps a cause raised at the failing site, including through a wrapping error', () => {
    expect(failureCause(workerFailure('Tile worker failed'))).toBe('worker');
    expect(failureCause(new DiagnosedError('x', 'out_of_memory'))).toBe('out_of_memory');
    expect(failureCause(new Error('wrapped', { cause: workerFailure('crashed') }))).toBe('worker');
  });
  it('accepts only the two fixed causes from an untrusted message', () => {
    expect(parseFailureCause('worker')).toBe('worker');
    expect(parseFailureCause('out_of_memory')).toBe('out_of_memory');
    for (const value of ['error_worker', 'private.stl', 1, null, undefined, {}]) expect(parseFailureCause(value)).toBeUndefined();
  });
});
