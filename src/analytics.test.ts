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
    expect(values.get(analytics.CONSENT_KEY)).toBe('granted-v2');
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

function sent(): { event: string; bucket: string }[] {
  return send.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe('consent versions: the targeted subset needs the current grant', () => {
  const subset = () => {
    analytics.trackDiagnostic('error_export');
    analytics.trackExportLatency(250);
    analytics.trackProjectSize(5_000_000);
    analytics.trackFeature('import');
    analytics.trackLatticeCells(12_345);
  };
  it('keeps an older grant to the original events and never upgrades it', () => {
    values.set(analytics.CONSENT_KEY, analytics.GRANT_V1);
    expect(analytics.analyticsConsentScope()).toBe('v1');
    expect(analytics.isAnalyticsEnabled()).toBe(true);
    expect(analytics.isExpandedEnabled()).toBe(false);
    subset();
    analytics.trackUsage('generation_completed');
    expect(sent()).toEqual([{ event: 'generation_completed', bucket: 'none' }]);
    expect(analytics.diagnosticReport().rows).toEqual([]);
    expect(values.get(analytics.CONSENT_KEY)).toBe(analytics.GRANT_V1);
    expect(storage.setItem).not.toHaveBeenCalled();
  });
  it('sends the subset, in fixed ranges only, after the current grant', () => {
    expect(analytics.setAnalyticsConsent(true)).toBe(true);
    expect(analytics.analyticsConsentScope()).toBe('v2');
    subset();
    expect(sent()).toEqual([
      { event: 'error_export', bucket: 'none' },
      { event: 'export_latency', bucket: '100ms_1s' },
      { event: 'project_size', bucket: '1_10mib' },
      { event: 'feature_category', bucket: 'import' },
    ]); // The fifth send is dropped: at most four requests are pending.
    analytics.trackUsage('workspace_opened');
    expect(send).toHaveBeenCalledTimes(4);
    expect(analytics.diagnosticReport()).toEqual({
      schema: 2,
      app: 'openlattice3d',
      rows: [
        { event: 'error_export', bucket: 'none', count: 1 },
        { event: 'export_latency', bucket: '100ms_1s', count: 1 },
        { event: 'project_size', bucket: '1_10mib', count: 1 },
        { event: 'feature_category', bucket: 'import', count: 1 },
        { event: 'lattice_cells', bucket: '10k_100k', count: 1 },
      ],
    });
  });
  it('asks a v1 user again by saving the current grant only on an explicit choice', () => {
    values.set(analytics.CONSENT_KEY, analytics.GRANT_V1);
    analytics.trackDiagnostic('error_import');
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsConsent(true);
    analytics.trackDiagnostic('error_import');
    expect(sent()).toEqual([{ event: 'error_import', bucket: 'none' }]);
  });
  it.each([{ doNotTrack: '1' }, { globalPrivacyControl: true }])('suppresses every subset event under %j', (signal) => {
    analytics.setAnalyticsConsent(true);
    vi.stubGlobal('navigator', signal);
    subset();
    analytics.trackFailure('error_runtime', new RangeError('Array buffer allocation failed'));
    expect(send).not.toHaveBeenCalled();
    expect(analytics.diagnosticReport().rows).toEqual([]);
  });
  it('withdrawal aborts pending subset sends and clears report counts', () => {
    send.mockImplementation(() => new Promise(() => {}));
    analytics.setAnalyticsConsent(true);
    analytics.trackFeature('create');
    const signal = send.mock.calls[0][1].signal as AbortSignal;
    analytics.setAnalyticsConsent(false);
    expect(signal.aborted).toBe(true);
    analytics.trackFeature('create');
    expect(send).toHaveBeenCalledTimes(1);
    analytics.setAnalyticsConsent(true);
    expect(analytics.diagnosticReport().rows).toEqual([]);
  });
  it('a cross-tab change to an older grant aborts only pending subset sends', () => {
    send.mockImplementation(() => new Promise(() => {}));
    analytics.setAnalyticsConsent(true);
    analytics.trackUsage('workspace_opened');
    analytics.trackDiagnostic('error_storage');
    const [v1Signal, v2Signal] = send.mock.calls.map((call) => call[1].signal as AbortSignal);
    values.set(analytics.CONSENT_KEY, analytics.GRANT_V1);
    storageChanged();
    expect(v2Signal.aborted).toBe(true);
    expect(v1Signal.aborted).toBe(false);
    analytics.trackDiagnostic('error_render');
    expect(send).toHaveBeenCalledTimes(2);
  });
  it('a cross-tab withdrawal stops the subset on the next call', () => {
    analytics.setAnalyticsConsent(true);
    values.clear(); // Effective before the storage event arrives.
    analytics.trackDiagnostic('error_import');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('fixed codes, causes and ranges', () => {
  beforeEach(() => { analytics.setAnalyticsConsent(true); });
  it('adds a cause code only from a classified error, never its text', () => {
    analytics.trackFailure('error_import', new RangeError('Array buffer allocation failed for private.stl'));
    analytics.trackFailure(null, Object.assign(new Error('crashed'), { name: 'Other' }));
    expect(sent()).toEqual([
      { event: 'error_import', bucket: 'none' },
      { event: 'error_out_of_memory', bucket: 'none' },
    ]);
    expect(JSON.stringify(send.mock.calls)).not.toContain('private');
  });
  it('counts each diagnostic code at most once a minute per page', () => {
    vi.useFakeTimers();
    try {
      analytics.trackDiagnostic('error_storage');
      analytics.trackDiagnostic('error_storage');
      analytics.trackDiagnostic('error_render');
      vi.advanceTimersByTime(analytics.DIAGNOSTIC_COOLDOWN_MS);
      analytics.trackDiagnostic('error_storage');
      expect(sent().map((row) => row.event)).toEqual(['error_storage', 'error_render', 'error_storage']);
    } finally { vi.useRealTimers(); }
  });
  it('rejects categories and buckets outside the OpenLattice3D scope', () => {
    analytics.trackFeature('edit' as Parameters<typeof analytics.trackFeature>[0]);
    analytics.trackDiagnostic('error_mesh' as Parameters<typeof analytics.trackDiagnostic>[0]);
    analytics.trackProjectSize(-1);
    analytics.trackProjectSize(1.5);
    analytics.trackLatticeCells(NaN);
    analytics.trackExportLatency(-5);
    expect(send).not.toHaveBeenCalled();
  });
  it('maps range edges exactly', () => {
    expect([0, 999, 1_000, 9_999, 10_000, 99_999, 100_000, 1e12, -1, Infinity].map(analytics.cellBucket))
      .toEqual(['lt_1k', 'lt_1k', '1k_10k', '1k_10k', '10k_100k', '10k_100k', 'gte_100k', 'gte_100k', null, null]);
    expect([0, 1_048_575, 1_048_576, 10_485_759, 10_485_760, 104_857_599, 104_857_600, -1, 0.5].map(analytics.sizeBucket))
      .toEqual(['lt_1mib', 'lt_1mib', '1_10mib', '1_10mib', '10_100mib', '10_100mib', 'gte_100mib', null, null]);
    expect([99.9, 999.9, 9_999.9, 59_999.9].map(analytics.durationBucket))
      .toEqual(['lt_100ms', '100ms_1s', '1s_10s', '10s_60s']);
  });
  it('counts uncaught page errors and rejections as error_runtime only', () => {
    browser.dispatchEvent(Object.assign(new Event('error'), { error: new Error('private stack') }));
    vi.useFakeTimers();
    try {
      vi.advanceTimersByTime(analytics.DIAGNOSTIC_COOLDOWN_MS);
      browser.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new RangeError('Out of memory') }));
    } finally { vi.useRealTimers(); }
    expect(sent()).toEqual([
      { event: 'error_runtime', bucket: 'none' },
      { event: 'error_runtime', bucket: 'none' },
      { event: 'error_out_of_memory', bucket: 'none' },
    ]);
  });
});

describe('GPU context loss', () => {
  beforeEach(() => { vi.useFakeTimers(); analytics.setAnalyticsConsent(true); });
  afterEach(() => vi.useRealTimers());
  it('reports a lost context on a mounted canvas', () => {
    const canvas = Object.assign(new EventTarget(), { isConnected: true });
    analytics.watchContextLoss(canvas);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    vi.runAllTimers();
    expect(sent()).toEqual([{ event: 'error_gpu_lost', bucket: 'none' }]);
  });
  it('ignores the loss forced when a canvas unmounts', () => {
    const canvas = Object.assign(new EventTarget(), { isConnected: true });
    analytics.watchContextLoss(canvas);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    canvas.isConnected = false;
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });
  it('sends nothing without the current grant', () => {
    values.set(analytics.CONSENT_KEY, analytics.GRANT_V1);
    const canvas = Object.assign(new EventTarget(), { isConnected: true });
    analytics.watchContextLoss(canvas);
    canvas.dispatchEvent(new Event('webglcontextlost'));
    vi.runAllTimers();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('main-thread watchdog', () => {
  function fakeClock() {
    const clock = {
      time: 0,
      visibleNow: true,
      task: null as (() => void) | null,
      now: () => clock.time,
      every: (task: () => void) => { clock.task = task; return 1; },
      stop: () => { clock.task = null; },
      visible: () => clock.visibleNow,
      // The heartbeat fires `late` ms after its scheduled interval.
      beat: (late = 0) => { clock.time += analytics.WATCHDOG_TICK_MS + late; clock.task?.(); },
    };
    return clock;
  }
  it('runs only under the current grant and reports a 5 s block once', () => {
    const clock = fakeClock();
    const stop = analytics.startUnresponsiveWatchdog(clock);
    expect(clock.task).toBeNull();
    analytics.setAnalyticsConsent(true);
    expect(clock.task).not.toBeNull();
    clock.beat(4_999);
    expect(send).not.toHaveBeenCalled();
    clock.beat(5_000);
    clock.beat(9_000); // Within the cooldown.
    expect(sent()).toEqual([{ event: 'error_unresponsive', bucket: 'none' }]);
    analytics.setAnalyticsConsent(false);
    expect(clock.task).toBeNull();
    stop();
  });
  it('ignores gaps while the tab is hidden', () => {
    const clock = fakeClock();
    analytics.setAnalyticsConsent(true);
    const stop = analytics.startUnresponsiveWatchdog(clock);
    clock.visibleNow = false;
    clock.beat(60_000);
    clock.visibleNow = true;
    clock.beat();
    expect(send).not.toHaveBeenCalled();
    stop();
  });
});
