import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../analytics', () => ({ trackDiagnostic: vi.fn() }));

type Request = { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; onupgradeneeded?: () => void; result?: unknown };

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

async function load() {
  const { useStore } = await import('./useStore');
  const { trackDiagnostic } = await import('../analytics');
  await expect.poll(() => useStore.getState().persistenceHydrated).toBe(true);
  return { useStore, trackDiagnostic: vi.mocked(trackDiagnostic) };
}

describe('local persistence failures', () => {
  it('reports a corrupt saved state and a failed database open as error_storage only', async () => {
    const values = new Map([['gen-lattice-1-state', '{private-part.stl']]);
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: vi.fn(), removeItem: vi.fn() },
      setTimeout, clearTimeout,
    }));
    vi.stubGlobal('indexedDB', { open: () => { const request: Request = {}; queueMicrotask(() => request.onerror?.()); return request; } });
    const { useStore, trackDiagnostic } = await load();
    expect(trackDiagnostic.mock.calls).toEqual([['error_storage'], ['error_storage']]);
    // The app still starts with defaults.
    expect(useStore.getState().sampleShape).toBeNull();
  });

  it('reports a failed save when storage is full, and keeps working', async () => {
    vi.stubGlobal('window', Object.assign(new EventTarget(), {
      localStorage: { getItem: () => null, setItem: () => { throw new DOMException('full', 'QuotaExceededError'); }, removeItem: vi.fn() },
      // Delegate so fake timers installed below apply to the store's debounce.
      setTimeout: (task: () => void, ms: number) => globalThis.setTimeout(task, ms),
      clearTimeout: (handle: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(handle),
    }));
    const { useStore, trackDiagnostic } = await load();
    expect(trackDiagnostic).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      useStore.getState().setSampleShape('cube');
      vi.advanceTimersByTime(300);
    } finally { vi.useRealTimers(); }
    expect(trackDiagnostic).toHaveBeenCalledWith('error_storage');
    expect(useStore.getState().sampleShape).toBe('cube');
  });

  it('does not report browsers without storage', async () => {
    const { trackDiagnostic } = await load();
    expect(trackDiagnostic).not.toHaveBeenCalled();
  });
});
