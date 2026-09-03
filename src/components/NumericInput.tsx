import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type KeyboardEvent } from 'react';
import { boundedNumberInput, committableNumber, isCommittableNumber } from '../utils/numeric-input';

type NumericInputProps = {
  id: string;
  title: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onCommit: (value: number) => void;
};

/**
 * A number field that stays typeable. The store always holds a bounded value;
 * the input shows the raw text while it is being edited, so a partial entry is
 * never rewritten under the cursor. The bound is applied on blur.
 */
export function NumericInput({ id, title, value, min, max, step, onCommit }: NumericInputProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const lastCommitted = useRef(value);
  const editStart = useRef<number | null>(null);

  useEffect(() => {
    // Only a write we did not make (lattice type, preset, import) discards an edit.
    if (value === lastCommitted.current) return;
    lastCommitted.current = value;
    setDraft(null);
  }, [value]);

  const text = draft ?? String(value);
  const invalid = draft !== null && !isCommittableNumber(draft, min, max);

  function commit(next: number) {
    lastCommitted.current = next;
    onCommit(next);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    setDraft(next);
    const committable = committableNumber(next, min, max);
    if (committable !== null) commit(committable);
  }

  function handleFocus() {
    editStart.current = value;
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>) {
    editStart.current = null;
    const bounded = boundedNumberInput(event.target.value, value, min, max);
    setDraft(null);
    if (bounded !== value) commit(bounded);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Escape') return;
    const started = editStart.current;
    const hasEdit = draft !== null || (started !== null && started !== value);
    if (!hasEdit) return;
    // Only claim Escape when there is an edit to cancel, so an idle field still
    // lets it reach the log drawer.
    event.stopPropagation();
    setDraft(null);
    if (started !== null && started !== value) commit(started);
  }

  return (
    <input
      id={id}
      type="number"
      title={title}
      value={text}
      min={min}
      max={max}
      step={step}
      aria-invalid={invalid}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    />
  );
}
