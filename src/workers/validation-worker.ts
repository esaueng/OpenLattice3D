// Runs expensive mesh validation after generation has already returned geometry.
// The pipeline itself lives in validation-core.ts so it can be tested without a Worker.
import {
  validateGeneratedResult,
  type ValidationWorkerMessage,
  type ValidationWorkerResponse,
} from './validation-core';

export type { ValidationWorkerMessage, ValidationWorkerResponse } from './validation-core';

let lastProgressPost = 0;
function reportValidationProgress(fraction: number) {
  const now = performance.now();
  if (fraction < 1 && now - lastProgressPost < 120) return;
  lastProgressPost = now;
  postMessage({ type: 'progress', progress: fraction } as ValidationWorkerResponse);
}

self.onmessage = (event: MessageEvent<ValidationWorkerMessage>) => {
  const msg = event.data;
  if (msg.type !== 'validate') return;

  try {
    postMessage({ type: 'progress', message: 'Validation running...' } as ValidationWorkerResponse);
    const validation = validateGeneratedResult(msg, reportValidationProgress);
    postMessage({ type: 'result', validation } as ValidationWorkerResponse);
  } catch (err: unknown) {
    const message = err instanceof Error && err.message ? err.message : 'Unknown validation error';
    postMessage({ type: 'error', message } as ValidationWorkerResponse);
  }
};
