// An app-local consent preference, never an identifier. No queue or retries.
export const CONSENT_KEY = 'openlattice3d.glimpse.consent.v1';
const CHANGED = 'glimpse-consent-changed';
const EVENTS = ['workspace_opened', 'export_completed', 'export_failed', 'generation_completed', 'generation_failed', 'operation_latency'] as const;
export type UsageEvent = typeof EVENTS[number];
let withdrawn = false;
let withdrawalUnpersisted = false;
const pending = new Set<AbortController>();

function stopPending(): void {
  for (const controller of pending) controller.abort();
  pending.clear();
}
export function hasAnalyticsConsent(): boolean {
  if (withdrawn || typeof window === 'undefined') return false;
  try { return window.localStorage.getItem(CONSENT_KEY) === 'granted-v1'; }
  catch { return false; }
}
export function privacySignal(): boolean {
  return typeof navigator !== 'undefined' && (navigator.doNotTrack === '1'
    || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true);
}
export function isAnalyticsEnabled(): boolean {
  return hasAnalyticsConsent() && !privacySignal();
}
export function setAnalyticsConsent(enabled: boolean): boolean {
  if (typeof window === 'undefined') return false;
  if (!enabled) { withdrawn = true; stopPending(); }
  try {
    if (enabled) window.localStorage.setItem(CONSENT_KEY, 'granted-v1');
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
export function durationBucket(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 0) return null;
  return ms < 100 ? 'lt_100ms' : ms < 1000 ? '100ms_1s' : ms < 10000 ? '1s_10s' : ms < 60000 ? '10s_60s' : 'gte_60s';
}
export function trackUsage(event: UsageEvent, elapsedMs?: number): void {
  if (!isAnalyticsEnabled() || !(EVENTS as readonly string[]).includes(event)) return;
  const bucket = event === 'operation_latency' ? durationBucket(elapsedMs ?? NaN) : 'none';
  if (!bucket || pending.size >= 4) return;
  const controller = new AbortController();
  pending.add(controller);
  try {
    void fetch('/api/glimpse/usage', {
      method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, bucket }), signal: controller.signal,
    }).catch(() => undefined).finally(() => pending.delete(controller));
  } catch { pending.delete(controller); }
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== CONSENT_KEY && event.key !== null) return;
    if (!withdrawalUnpersisted) withdrawn = false;
    // A failed local withdrawal remains blocked even if another tab grants.
    if (!isAnalyticsEnabled()) stopPending();
    window.dispatchEvent(new Event(CHANGED));
  });
}
