export function boundedNumberInput(
  rawValue: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (rawValue.trim() === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * True when a partially-typed value is already a usable number in range.
 *
 * Clamping every keystroke makes some values untypeable: in a min=0.3 field the
 * leading "0" of "0.35" clamps to 0.3 and the rest of the entry is appended to
 * that instead. Editing therefore keeps the raw text and only commits when it
 * passes this check; the clamp still runs on blur.
 */
export function isCommittableNumber(rawValue: string, min: number, max: number): boolean {
  if (rawValue.trim() === '') return false;
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

/** The value to push to the store mid-edit, or null to leave the store untouched. */
export function committableNumber(rawValue: string, min: number, max: number): number | null {
  return isCommittableNumber(rawValue, min, max) ? Number(rawValue) : null;
}
