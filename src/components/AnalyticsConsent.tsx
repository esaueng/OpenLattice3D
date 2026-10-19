import { useState, useSyncExternalStore } from 'react';
import { hasAnalyticsConsent, privacySignal, setAnalyticsConsent, subscribeAnalyticsConsent } from '../analytics';

export function AnalyticsConsent() {
  // Display the saved choice even under DNT/GPC so withdrawal stays available.
  const granted = useSyncExternalStore(subscribeAnalyticsConsent, hasAnalyticsConsent, () => false);
  const [error, setError] = useState('');
  return (
    <section className="analytics-section" aria-labelledby="analytics-heading">
      <h3 id="analytics-heading">Privacy &amp; data</h3>
      <label className="analytics-choice">
        <input type="checkbox" checked={granted} aria-describedby="analytics-description analytics-status" onChange={(event) => {
          const enabled = event.target.checked;
          const saved = setAnalyticsConsent(enabled);
          setError(saved ? '' : enabled
            ? 'Could not save your choice. Optional analytics remain off.'
            : 'Analytics stopped in this page. Clear site storage to remove an older saved choice before reloading.');
        }} />
        Allow optional usage analytics
      </label>
      <p id="analytics-description" className="analytics-description">
        Share daily counts of workspace opens, completed or failed lattice generations and exports,
        and coarse operation times through Glimpse. No model data, names, URLs or visitor identifiers.
        Off by default; using the app does not require consent. Uncheck to stop future sends immediately.
        Pending sends are cancelled; counts already received cannot be recalled.
      </p>
      <p id="analytics-status" className="analytics-description" role="status">
        {error || (privacySignal() ? 'Your browser privacy signal suppresses optional sends, including when this choice is saved.'
          : granted ? 'Consent saved for this browser. Collection also requires the service to be enabled.' : 'Optional analytics are off.')}
      </p>
    </section>
  );
}
