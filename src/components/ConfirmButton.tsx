// A destructive button that asks first, with the shared confirm wording.
import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { confirmActionLabel, confirmHint } from './confirm';
import { useArmedConfirm } from '../hooks/useArmedConfirm';

type ConfirmButtonProps = {
  /** The action in sentence case, e.g. "Start over". */
  action: string;
  onConfirm: () => void;
  className: string;
  title?: string;
  icon?: ReactNode;
};

export function ConfirmButton({ action, onConfirm, className, title, icon }: ConfirmButtonProps) {
  const { armed, press, disarm } = useArmedConfirm(onConfirm);
  const hintId = useId();

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape' || !armed) return;
    // Escape backs out of the armed state before it reaches a surrounding menu.
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    disarm();
  };

  return (
    <>
      <button
        type="button"
        className={`${className}${armed ? ' armed' : ''}`}
        title={title}
        aria-describedby={armed ? hintId : undefined}
        onClick={press}
        onKeyDown={handleKeyDown}
      >
        {icon}
        {armed ? confirmActionLabel(action) : action}
      </button>
      <span id={hintId} className="visually-hidden" role="status" aria-live="polite">
        {armed ? confirmHint(action) : ''}
      </span>
    </>
  );
}
