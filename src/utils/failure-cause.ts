// Classifies a failure into a fixed cause so it can be reported as a diagnostic
// code. Error text is read here only to classify; it never leaves the page.

export type FailureCause = 'worker' | 'out_of_memory';

/** A failure whose cause is already known at the site that raised it. */
export class DiagnosedError extends Error {
  readonly diagnostic: FailureCause;
  constructor(message: string, diagnostic: FailureCause) {
    super(message);
    this.name = 'DiagnosedError';
    this.diagnostic = diagnostic;
  }
}

/** A Web Worker crashed, returned an unreadable or malformed response, or could not start. */
export function workerFailure(message: string): DiagnosedError {
  return new DiagnosedError(message, 'worker');
}

// V8: RangeError "Array buffer allocation failed"; Safari: RangeError "Out of memory";
// Firefox: "out of memory". A size the app itself refuses (a generation budget) is not one.
const OUT_OF_MEMORY = /array buffer allocation failed|out of memory|failed to allocate|cannot allocate memory/i;

export function isOutOfMemoryError(error: unknown): boolean {
  return error instanceof Error && OUT_OF_MEMORY.test(error.message);
}

export function failureCause(error: unknown, depth = 0): FailureCause | undefined {
  if (error instanceof DiagnosedError) return error.diagnostic;
  if (isOutOfMemoryError(error)) return 'out_of_memory';
  if (depth < 4 && error instanceof Error && error.cause !== undefined && error.cause !== error) {
    return failureCause(error.cause, depth + 1);
  }
  return undefined;
}

/** Accepts only the two fixed causes from an untrusted worker message. */
export function parseFailureCause(value: unknown): FailureCause | undefined {
  return value === 'worker' || value === 'out_of_memory' ? value : undefined;
}
