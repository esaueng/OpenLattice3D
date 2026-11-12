// Keyboard model for WAI-ARIA radio groups (https://www.w3.org/WAI/ARIA/apg/patterns/radio/):
// one tab stop, arrows move and select (wrapping), Home/End jump, Space selects.

export type RadioKeyAction = { index: number; select: boolean } | null;

function step(from: number, delta: 1 | -1, disabled: readonly boolean[]): number {
  const count = disabled.length;
  for (let i = 1; i <= count; i++) {
    const candidate = (((from + delta * i) % count) + count) % count;
    if (!disabled[candidate]) return candidate;
  }
  return from;
}

/**
 * Where a key press inside a radio group moves focus, and whether it selects.
 * `disabled` has one entry per option. Returns null for keys the group ignores.
 */
export function radioGroupKeyAction(key: string, focused: number, disabled: readonly boolean[]): RadioKeyAction {
  const count = disabled.length;
  if (count === 0 || disabled.every(Boolean)) return null;
  const current = Math.min(Math.max(focused, 0), count - 1);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return { index: step(current, 1, disabled), select: true };
    case 'ArrowLeft':
    case 'ArrowUp':
      return { index: step(current, -1, disabled), select: true };
    case 'Home':
      return { index: disabled.indexOf(false), select: true };
    case 'End':
      return { index: disabled.lastIndexOf(false), select: true };
    case ' ':
      return disabled[current] ? null : { index: current, select: true };
    default:
      return null;
  }
}

/** The option that takes the group's single tab stop: the checked one, else the first enabled. */
export function radioGroupTabStop(selected: number, disabled: readonly boolean[]): number {
  if (selected >= 0 && selected < disabled.length && !disabled[selected]) return selected;
  return disabled.indexOf(false);
}
