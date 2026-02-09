import { useMemo, useState } from 'react';

type FeedbackStatus = 'idle' | 'sending' | 'success' | 'error';

export function FeedbackWidget() {
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [issue, setIssue] = useState('');
  const [status, setStatus] = useState<FeedbackStatus>('idle');
  const [message, setMessage] = useState('');

  const canSubmit = useMemo(() => {
    return name.trim().length > 0 && issue.trim().length > 0 && status !== 'sending';
  }, [name, issue, status]);

  const resetForm = () => {
    setName('');
    setEmail('');
    setIssue('');
  };

  const submitFeedback = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }

    setStatus('sending');
    setMessage('');

    const payload = {
      name: name.trim(),
      email: email.trim() || undefined,
      issue: issue.trim(),
      userAgent: navigator.userAgent,
      url: window.location.href,
      createdAt: new Date().toISOString(),
    };

    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        setStatus('error');
        setMessage(errorText || 'Unable to submit feedback.');
        return;
      }

      setStatus('success');
      setMessage('Thanks! Your feedback was sent.');
      resetForm();
    } catch (error) {
      setStatus('error');
      setMessage('Network error. Please try again.');
    }
  };

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
        <form className="feedback-panel" onSubmit={submitFeedback}>
          <h3>Report a bug</h3>
          <label>
            Name
            <input
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Jane Doe"
              required
            />
          </label>
          <label>
            Email (optional)
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="jane@example.com"
            />
          </label>
          <label>
            Issue
            <textarea
              value={issue}
              onChange={(event) => setIssue(event.target.value)}
              placeholder="Describe the issue you hit..."
              rows={4}
              required
            />
          </label>
          <div className="feedback-actions">
            <button className="btn btn-primary" type="submit" disabled={!canSubmit}>
              {status === 'sending' ? 'Sending...' : 'Send feedback'}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => {
                resetForm();
                setStatus('idle');
                setMessage('');
              }}
            >
              Clear
            </button>
          </div>
          {message ? <p className={`feedback-message ${status}`}>{message}</p> : null}
        </form>
      ) : null}
    </div>
  );
}
