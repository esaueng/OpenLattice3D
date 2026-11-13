// Glimpse optional analytics. An app-local consent preference, never an identifier.
// No queue, retries or replay: a send that cannot happen now is dropped.
import {
  cellBucket,
  durationBucket,
  isExpandedMetric,
  sizeBucket,
  USAGE_EVENTS,
  type Diagnostic,
  type FeatureCategory,
  type UsageEvent,
} from './glimpse-contract';
import { failureCause, type FailureCause } from './utils/failure-cause';

export { cellBucket, durationBucket, sizeBucket };
export type { Diagnostic, FeatureCategory, UsageEvent };

// The key name is unchanged; its value records which notice the person accepted.
export const CONSENT_KEY = 'openlattice3d.glimpse.consent.v1';
/** The original notice: workspace opens, generation/export outcomes and operation times. */
export const GRANT_V1 = 'granted-v1';
/** The updated notice (Glimpse ADR 0001): the original events plus the targeted subset. */
export const GRANT_V2 = 'granted-v2';
/** `v1` is an older grant that still covers only the original events; it is never upgraded. */
export type ConsentScope = 'none' | 'v1' | 'v2';
type Scope = 'v1' | 'v2';

const CHANGED = 'glimpse-consent-changed';
const MAX_PENDING = 4;
/** Each diagnostic code counts at most once a minute per page, so a failing loop cannot flood. */
export const DIAGNOSTIC_COOLDOWN_MS = 60_000;
const MAX_REPORT_ROWS = 128;
const MAX_REPORT_COUNT = 10_000_000;

let withdrawn = false;
let withdrawalUnpersisted = false;
const pending = new Map<AbortController, Scope>();
const reportCounts = new Map<string, { event: string; bucket: string; count: number }>();
const lastDiagnostic = new Map<Diagnostic, number>();

function stopPending(scope: 'all' | 'v2'): void {
  for (const [controller, sent] of pending) {
    if (scope === 'all' || sent === 'v2') {
      controller.abort();
      pending.delete(controller);
    }
  }
  // Report counts are targeted-subset data: they never outlive the grant that allowed them.
  reportCounts.clear();
  lastDiagnostic.clear();
}

export function analyticsConsentScope(): ConsentScope {
  if (withdrawn || typeof window === 'undefined') return 'none';
  try {
    const value = window.localStorage.getItem(CONSENT_KEY);
    return value === GRANT_V2 ? 'v2' : value === GRANT_V1 ? 'v1' : 'none';
  } catch { return 'none'; }
}
/** Any saved grant, old or current. The UI shows it so withdrawal stays available. */
export function hasAnalyticsConsent(): boolean {
  return analyticsConsentScope() !== 'none';
}
export function privacySignal(): boolean {
  return typeof navigator !== 'undefined' && (navigator.doNotTrack === '1'
    || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
}
/** The original events may be sent: either grant, and no DNT/GPC. */
export function isAnalyticsEnabled(): boolean {
  return hasAnalyticsConsent() && !privacySignal();
}
/** The targeted subset may be sent: only the current grant, and no DNT/GPC. */
export function isExpandedEnabled(): boolean {
  return analyticsConsentScope() === 'v2' && !privacySignal();
}

/** Enabling always saves the current grant; the UI shows the updated notice beside it. */
export function setAnalyticsConsent(enabled: boolean): boolean {
  if (typeof window === 'undefined') return false;
  if (!enabled) { withdrawn = true; stopPending('all'); }
  try {
    if (enabled) window.localStorage.setItem(CONSENT_KEY, GRANT_V2);
    else window.localStorage.removeItem(CONSENT_KEY);
    withdrawn = !enabled;
    withdrawalUnpersisted = false;
    window.dispatchEvent(new Event(CHANGED));
    return true;
  } catch {
    if (!enabled) withdrawalUnpersisted = true;
    // Even when storage is blocked, withdrawal suppresses this page until reload.
    window.dispatchEvent(new Event(CHANGED));
    return false;
  }
}
export function subscribeAnalyticsConsent(listener: () => void): () => void {
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}

function send(event: string, bucket: string, scope: Scope): void {
  if (pending.size >= MAX_PENDING) return;
  const controller = new AbortController();
  pending.set(controller, scope);
  try {
    void fetch('/api/glimpse/usage', {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, bucket }), signal: controller.signal,
    }).catch(() => undefined).finally(() => pending.delete(controller));
  } catch { pending.delete(controller); }
}

/** An original (v1) event. Covered by either grant. */
export function trackUsage(event: UsageEvent, elapsedMs?: number): void {
  if (!isAnalyticsEnabled() || !(USAGE_EVENTS as readonly string[]).includes(event)) return;
  const bucket = event === 'operation_latency' ? durationBucket(elapsedMs ?? NaN) : 'none';
  if (bucket) send(event, bucket, 'v1');
}

/** A targeted-subset event. Sent, and kept for the local report, only under the current grant. */
function trackExpanded(event: string, bucket: string): void {
  // Storage is rechecked on every call, so a withdrawal in any tab takes effect at once.
  if (!isExpandedEnabled() || !isExpandedMetric(event, bucket)) return;
  const key = `${event}:${bucket}`;
  const prior = reportCounts.get(key);
  if (prior) prior.count = Math.min(MAX_REPORT_COUNT, prior.count + 1);
  else if (reportCounts.size < MAX_REPORT_ROWS) reportCounts.set(key, { event, bucket, count: 1 });
  send(event, bucket, 'v2');
}

/** One fixed diagnostic code. Never a message, stack, file name or URL. */
export function trackDiagnostic(code: Diagnostic): void {
  if (!isExpandedEnabled()) return;
  const now = Date.now();
  const last = lastDiagnostic.get(code);
  if (last !== undefined && now - last < DIAGNOSTIC_COOLDOWN_MS) return;
  lastDiagnostic.set(code, now);
  trackExpanded(code, 'none');
}

/** A failed Web Worker or an allocation failure, when the failing site knows it. */
export function trackFailureCause(cause: FailureCause | undefined): void {
  if (cause === 'worker') trackDiagnostic('error_worker');
  else if (cause === 'out_of_memory') trackDiagnostic('error_out_of_memory');
}
/**
 * A failure at a known site, plus the cause the error carries (see
 * utils/failure-cause). `site` is null where the site has no code of its own:
 * a failed generation is already the v1 `generation_failed` outcome.
 */
export function trackFailure(site: Diagnostic | null, error?: unknown): void {
  if (site) trackDiagnostic(site);
  trackFailureCause(failureCause(error));
}

export function trackExportLatency(elapsedMs: number): void {
  const bucket = durationBucket(elapsedMs);
  if (bucket) trackExpanded('export_latency', bucket);
}
/** Saved project file size, as a range. The byte count never leaves the page. */
export function trackProjectSize(bytes: number): void {
  const bucket = sizeBucket(bytes);
  if (bucket) trackExpanded('project_size', bucket);
}
export function trackFeature(category: FeatureCategory): void {
  trackExpanded('feature_category', category);
}
/** Unit cells in a generated lattice, as a range. The count never leaves the page. */
export function trackLatticeCells(cells: number): void {
  const bucket = cellBucket(cells);
  if (bucket) trackExpanded('lattice_cells', bucket);
}

export type DiagnosticReport = {
  schema: 2;
  app: 'openlattice3d';
  rows: { event: string; bucket: string; count: number }[];
};
/** This page's targeted-subset counts. No timestamps, IDs, order, URLs, names or error text. */
export function diagnosticReport(): DiagnosticReport {
  return {
    schema: 2,
    app: 'openlattice3d',
    rows: isExpandedEnabled() ? [...reportCounts.values()].map((row) => ({ ...row })) : [],
  };
}
/** Saves the report locally for the person to inspect and share themselves. Nothing is uploaded. */
export function downloadDiagnosticReport(): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(diagnosticReport(), null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'openlattice3d-glimpse-report.json';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Reports a lost WebGL context on a viewer canvas. A context released because
 * the canvas was removed (React Three Fiber forces the loss on unmount) is not
 * a failure, so the check runs after the unmount has finished.
 */
export function watchContextLoss(canvas: EventTarget & { readonly isConnected?: boolean }): () => void {
  const onLost = () => {
    setTimeout(() => { if (canvas.isConnected !== false) trackDiagnostic('error_gpu_lost'); }, 0);
  };
  canvas.addEventListener('webglcontextlost', onLost);
  return () => canvas.removeEventListener('webglcontextlost', onLost);
}

export const UNRESPONSIVE_MS = 5_000;
export const WATCHDOG_TICK_MS = 500;
export type WatchdogClock = {
  now(): number;
  every(task: () => void, ms: number): unknown;
  stop(handle: unknown): void;
  visible(): boolean;
};
const browserClock: WatchdogClock = {
  now: () => performance.now(),
  every: (task, ms) => setInterval(task, ms),
  stop: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  visible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
};
/**
 * Main-thread watchdog: a heartbeat that arrives 5 s or more late (beyond its own
 * interval) means the page was blocked at least that long. It runs only while
 * the current grant is active, and ignores hidden tabs, whose timers browsers throttle.
 */
export function startUnresponsiveWatchdog(clock: WatchdogClock = browserClock): () => void {
  let handle: unknown;
  let last = 0;
  const tick = () => {
    const now = clock.now();
    const gap = now - last;
    last = now;
    if (!clock.visible()) return;
    if (gap - WATCHDOG_TICK_MS >= UNRESPONSIVE_MS) trackDiagnostic('error_unresponsive');
  };
  const sync = () => {
    const wanted = isExpandedEnabled();
    if (wanted && handle === undefined) {
      last = clock.now();
      handle = clock.every(tick, WATCHDOG_TICK_MS);
    } else if (!wanted && handle !== undefined) {
      clock.stop(handle);
      handle = undefined;
    }
  };
  // A tab coming back into view starts a fresh interval rather than a stale gap.
  const onVisibility = () => { last = clock.now(); };
  if (typeof window !== 'undefined') window.addEventListener(CHANGED, sync);
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
  sync();
  return () => {
    if (typeof window !== 'undefined') window.removeEventListener(CHANGED, sync);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (handle !== undefined) clock.stop(handle);
    handle = undefined;
  };
}

if (typeof window !== 'undefined') {
  // Uncaught errors anywhere in the page. Only the fixed code is kept, never the error.
  window.addEventListener('error', (event) => trackFailure('error_runtime', (event as ErrorEvent).error));
  window.addEventListener('unhandledrejection', (event) => trackFailure('error_runtime', (event as PromiseRejectionEvent).reason));
  window.addEventListener('storage', (event) => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    if (!withdrawalUnpersisted) withdrawn = false;
    // A failed local withdrawal remains blocked even if another tab grants.
    if (!isAnalyticsEnabled()) stopPending('all');
    else if (!isExpandedEnabled()) stopPending('v2');
    window.dispatchEvent(new Event(CHANGED));
  });
}
