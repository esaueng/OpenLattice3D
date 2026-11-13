import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { analyticsConsentScope, privacySignal, trackDiagnostic, type ConsentScope } from '../analytics';
import { AnalyticsConsent } from './AnalyticsConsent';
import { ANALYTICS_NOTICE } from './analytics-notice';
import { ViewportErrorBoundary } from './ViewportErrorBoundary';

vi.mock('../analytics', () => ({
  analyticsConsentScope: vi.fn(() => 'none'),
  privacySignal: vi.fn(() => false),
  setAnalyticsConsent: vi.fn(() => true),
  subscribeAnalyticsConsent: vi.fn(() => () => undefined),
  downloadDiagnosticReport: vi.fn(),
  trackDiagnostic: vi.fn(),
}));
// Render the client snapshot (the saved choice) rather than the server default.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot() };
});

function render(scope: ConsentScope, signal = false): string {
  vi.mocked(analyticsConsentScope).mockReturnValue(scope);
  vi.mocked(privacySignal).mockReturnValue(signal);
  return renderToStaticMarkup(createElement(AnalyticsConsent));
}

beforeEach(() => vi.clearAllMocks());

describe('analytics consent notice', () => {
  it('names every category sent and what is never sent', () => {
    for (const phrase of ['workspace opens', 'five ranges', 'four ranges', 'unit cells', 'create, import, export or measure',
      'graphics context', 'background worker', '5 s', 'file names', 'error messages', 'stack traces', 'exact sizes or counts',
      'graphics hardware names']) expect(ANALYTICS_NOTICE).toContain(phrase);
    expect(render('none')).toContain('Optional analytics are off.');
  });
  it('asks a person with an older grant again, in place, without changing it', () => {
    const html = render('v1');
    expect(html).toContain('checked=""');
    expect(html).toContain('Allow updated analytics');
    expect(html).toContain('covers only the original counts');
    expect(html).not.toContain('Download diagnostic report');
  });
  it('offers the local report only under the current grant and without a privacy signal', () => {
    expect(render('v2')).toContain('Download diagnostic report');
    expect(render('v2')).not.toContain('Allow updated analytics');
    expect(render('v2', true)).not.toContain('Download diagnostic report');
    expect(render('none')).not.toContain('Download diagnostic report');
  });
});

describe('viewport error boundary', () => {
  it('counts error_render and shows a contained fallback', () => {
    expect(ViewportErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
    const boundary = new ViewportErrorBoundary({ children: 'viewer' });
    boundary.componentDidCatch();
    expect(trackDiagnostic).toHaveBeenCalledExactlyOnceWith('error_render');
    expect(boundary.render()).toBe('viewer');
    boundary.state = { failed: true };
    expect(renderToStaticMarkup(boundary.render() as ReactElement)).toContain('The 3D view could not be drawn');
  });
});
