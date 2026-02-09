import { useState } from 'react';

export function FeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="feedback-widget">
      <button
        className="btn btn-accent feedback-toggle"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        aria-expanded={isOpen}
      >
        {isOpen ? 'Close feedback' : 'Bug report / feedback'}
      </button>

      {isOpen ? (
        <div className="feedback-panel">
          <div style={{ padding: '16px' }}>
            <p style={{ marginBottom: '12px', color: 'var(--text-dim)' }}>
              Submit feedback or bug reports using the form below.
            </p>
            <a
              className="btn btn-primary"
              href="https://form.esauengineering.com/feedback-openlattice3d"
              target="_blank"
              rel="noreferrer"
            >
              Open feedback form
            </a>
          </div>
        </div>
      ) : null}
    </div>
  );
}
