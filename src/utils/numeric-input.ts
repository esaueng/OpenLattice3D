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
