import { useEffect, useState } from 'react';

export function FeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    const scriptSrc = 'https://tally.so/widgets/embed.js';
    const existing = document.querySelector(`script[src="${scriptSrc}"]`);

    const loadEmbeds = () => {
      if (typeof window !== 'undefined' && 'Tally' in window) {
        // @ts-expect-error - Tally is a global injected by the embed script
        window.Tally.loadEmbeds();
      }
    };

    if (existing) {
      loadEmbeds();
      return;
    }

    const script = document.createElement('script');
    script.src = scriptSrc;
    script.async = true;
    script.onload = loadEmbeds;
    script.onerror = loadEmbeds;
    document.body.appendChild(script);

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, []);

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
          <iframe
            data-tally-src="https://tally.so/embed/rjAOQ2?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
            src="https://tally.so/embed/rjAOQ2?alignLeft=1&hideTitle=1&transparentBackground=1&dynamicHeight=1"
            loading="lazy"
            title="Feedback - OpenLattice3D"
          />
        </div>
      ) : null}
    </div>
  );
}
