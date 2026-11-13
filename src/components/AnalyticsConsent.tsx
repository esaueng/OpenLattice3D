import { useState, useSyncExternalStore } from 'react';
import {
  analyticsConsentScope,
  downloadDiagnosticReport,
  privacySignal,
  setAnalyticsConsent,
  subscribeAnalyticsConsent,
} from '../analytics';
import { ANALYTICS_NOTICE } from './analytics-notice';

export function AnalyticsConsent() {
  // Display the saved choice even under DNT/GPC so withdrawal stays available.
  const scope = useSyncExternalStore(subscribeAnalyticsConsent, analyticsConsentScope, () => 'none' as const);
  const granted = scope !== 'none';
  const [error, setError] = useState('');
  const save = (enabled: boolean) => {
    const saved = setAnalyticsConsent(enabled);
    setError(saved ? '' : enabled
      ? 'Could not save your choice. Optional analytics remain as they were.'
      : 'Analytics stopped in this page. Clear site storage to remove an older saved choice before reloading.');
  };
  const signal = privacySignal();
  return (
    <section className="analytics-section" aria-labelledby="analytics-heading">
      <h3 id="analytics-heading">Privacy &amp; data</h3>
      <label className="analytics-choice">
        <input
          type="checkbox"
          checked={granted}
          aria-describedby="analytics-description analytics-status"
          onChange={(event) => save(event.target.checked)}
        />
        Allow optional usage analytics
      </label>
      <p id="analytics-description" className="analytics-description">
        {ANALYTICS_NOTICE} Off by default; using the app does not require consent. Uncheck to stop future sends
        immediately. Pending sends are cancelled; counts already received cannot be recalled.
      </p>
      {scope === 'v1' && (
        // Asked here only, where the choice lives: no pop-up, badge or reminder.
        <div className="analytics-extra">
          <p className="analytics-description">
            You allowed an earlier, narrower version of this notice. It still covers only workspace opens,
            generation and export outcomes, and operation times. Nothing else listed above is sent unless
            you allow the updated analytics.
          </p>
          <button type="button" className="btn btn-small" onClick={() => save(true)}>
            Allow updated analytics
          </button>
        </div>
      )}
      {scope === 'v2' && !signal && (
        <div className="analytics-extra">
          <button type="button" className="btn btn-small" onClick={downloadDiagnosticReport}>
            Download diagnostic report
          </button>
          <p className="analytics-description">
            Saves this page&apos;s counts as a JSON file you can inspect and share yourself. Nothing is uploaded.
          </p>
        </div>
      )}
      <p id="analytics-status" className="analytics-description" role="status">
        {error || (signal ? 'Your browser privacy signal suppresses optional sends, including when this choice is saved.'
          : scope === 'v2' ? 'Consent saved for this browser. Collection also requires the service to be enabled.'
            : scope === 'v1' ? 'Your earlier choice is saved for this browser and covers only the original counts.'
              : 'Optional analytics are off.')}
      </p>
    </section>
  );
}
