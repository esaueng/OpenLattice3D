// Two-step confirmation state shared by every destructive button.
import { useCallback, useEffect, useState } from 'react';
import { CONFIRM_TIMEOUT_MS, pressConfirm } from '../components/confirm';

export function useArmedConfirm(onConfirm: () => void, timeoutMs = CONFIRM_TIMEOUT_MS) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timeout = window.setTimeout(() => setArmed(false), timeoutMs);
    return () => window.clearTimeout(timeout);
  }, [armed, timeoutMs]);

  const press = useCallback(() => {
    const next = pressConfirm(armed);
    setArmed(next.armed);
    if (next.confirmed) onConfirm();
  }, [armed, onConfirm]);

  const disarm = useCallback(() => setArmed(false), []);
  return { armed, press, disarm };
}
