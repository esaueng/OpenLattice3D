import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let analytics: typeof import('./analytics');
let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
let browser: EventTarget & { localStorage: typeof storage };
let send: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.resetModules();
  values = new Map();
  storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  browser = Object.assign(new EventTarget(), { localStorage: storage });
  send = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('window', browser);
  vi.stubGlobal('navigator', {});
  vi.stubGlobal('fetch', send);
  analytics = await import('./analytics');
});
afterEach(() => vi.unstubAllGlobals());
function storageChanged(key: string | null = analytics.CONSENT_KEY) {
  browser.dispatchEvent(Object.assign(new Event('storage'), { key }));
}

describe('optional consent and minimal sends', () => {
  it('starts off, ignores legacy preferences and requires an explicit saved grant', () => {
    values.set('analyticsEnabled', 'true');
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
    expect(analytics.setAnalyticsConsent(true)).toBe(true);
    analytics.trackUsage('export_completed');
    expect(values.get(analytics.CONSENT_KEY)).toBe('granted-v1');
    expect(send).toHaveBeenCalledWith('/api/glimpse/usage', expect.objectContaining({
      credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      body: JSON.stringify({ event: 'export_completed', bucket: 'none' }),
    }));
  });
  it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])('honors privacy signals while keeping saved consent withdrawable: %j', (signal) => {
    analytics.setAnalyticsConsent(true);
    vi.stubGlobal('navigator', signal);
    expect(analytics.hasAnalyticsConsent()).toBe(true);
    analytics.trackUsage('generation_completed');
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsConsent(false);
    expect(values.has(analytics.CONSENT_KEY)).toBe(false);
  });
  it('aborts pending requests immediately and rechecks storage on every send', () => {
    send.mockImplementation(() => new Promise(() => {}));
    analytics.setAnalyticsConsent(true);
    analytics.trackUsage('generation_completed');
    const signal = send.mock.calls[0][1].signal as AbortSignal;
    analytics.setAnalyticsConsent(false);
    expect(signal.aborted).toBe(true);
    analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledTimes(1);
    analytics.setAnalyticsConsent(true);
    values.clear(); // A storage change is effective even before its event arrives.
    analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('follows cross-tab withdrawal, clear and later re-grant', () => {
    analytics.setAnalyticsConsent(false);
    values.set(analytics.CONSENT_KEY, 'granted-v1');
    storageChanged();
    expect(analytics.isAnalyticsEnabled()).toBe(true);
    send.mockImplementation(() => new Promise(() => {}));
    analytics.trackUsage('workspace_opened');
    const signal = send.mock.calls[0][1].signal as AbortSignal;
    values.clear();
    storageChanged(null);
    expect(signal.aborted).toBe(true);
    expect(analytics.hasAnalyticsConsent()).toBe(false);
  });
  it('fails closed when storage fails, including a failed withdrawal followed by another tab grant', () => {
    storage.setItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(analytics.setAnalyticsConsent(true)).toBe(false);
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
    values.set(analytics.CONSENT_KEY, 'granted-v1');
    storage.removeItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(analytics.setAnalyticsConsent(false)).toBe(false);
    storageChanged();
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
  });
  it('handles unavailable storage and transport, rejects unknown events and bounds pending sends', async () => {
    storage.getItem.mockImplementationOnce(() => { throw new Error('blocked'); });
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.setAnalyticsConsent(true);
    analytics.trackUsage('private-name' as Parameters<typeof analytics.trackUsage>[0]);
    analytics.trackUsage('operation_latency', NaN);
    expect(send).not.toHaveBeenCalled();
    send.mockImplementationOnce(() => { throw new Error('sync'); });
    expect(() => analytics.trackUsage('export_failed')).not.toThrow();
    send.mockRejectedValueOnce(new Error('offline'));
    analytics.trackUsage('export_failed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    send.mockClear().mockImplementation(() => new Promise(() => {}));
    for (let i = 0; i < 6; i++) analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledTimes(4);
  });
  it('uses coarse durations only and never emits extra properties', () => {
    analytics.setAnalyticsConsent(true);
    analytics.trackUsage('operation_latency', 4321);
    expect(JSON.parse(send.mock.calls[0][1].body)).toEqual({ event: 'operation_latency', bucket: '1s_10s' });
    expect([0, 100, 1000, 10000, 60000, -1, Infinity].map(analytics.durationBucket))
      .toEqual(['lt_100ms', '100ms_1s', '1s_10s', '10s_60s', 'gte_60s', null, null]);
  });
});
