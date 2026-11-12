// One wording and one behaviour for destructive actions that ask first: the
// first activation arms ("Yes, start over"), the second within the timeout acts.

/** The confirmation shown before another model replaces work in progress. */
export const REPLACE_MODEL_ACTION = 'Replace model';

/** How long an armed confirmation waits before it quietly disarms. */
export const CONFIRM_TIMEOUT_MS = 4000;

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

/** The armed label: "Start over" → "Yes, start over". */
export function confirmActionLabel(action: string): string {
  return `Yes, ${lowerFirst(action)}`;
}

/** What screen readers hear (and the log records) once a confirmation is armed. */
export function confirmHint(action: string, timeoutMs: number | null = CONFIRM_TIMEOUT_MS): string {
  const label = `“${confirmActionLabel(action)}”`;
  if (timeoutMs === null) return `Choose ${label} to continue.`;
  return `Click ${label} to confirm. It cancels by itself after ${Math.round(timeoutMs / 1000)} seconds.`;
}

export type ConfirmPress = { armed: boolean; confirmed: boolean };

/** The press transition: an unarmed press arms; an armed press confirms and disarms. */
export function pressConfirm(armed: boolean): ConfirmPress {
  return armed ? { armed: false, confirmed: true } : { armed: true, confirmed: false };
}
