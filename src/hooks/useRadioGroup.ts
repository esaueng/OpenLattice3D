// Roving-tabindex radio group behaviour for button-based option pickers.
import { useRef, type KeyboardEvent } from 'react';
import { radioGroupKeyAction, radioGroupTabStop } from '../components/radio-group';

type RadioGroupOptions<T> = {
  values: readonly T[];
  selected: T;
  onSelect: (value: T) => void;
  /** Disables every option, or the options for which it returns true. */
  disabled?: boolean | ((value: T) => boolean);
};

export function useRadioGroup<T>({ values, selected, onSelect, disabled = false }: RadioGroupOptions<T>) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const disabledFlags = values.map((value) => (typeof disabled === 'function' ? disabled(value) : disabled));
  const tabStop = radioGroupTabStop(values.indexOf(selected), disabledFlags);

  const handleKeyDown = (index: number, event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const action = radioGroupKeyAction(event.key, index, disabledFlags);
    if (!action) return;
    // Arrows would otherwise scroll the panel; Space would also fire a click.
    event.preventDefault();
    buttons.current[action.index]?.focus();
    if (action.select) onSelect(values[action.index]);
  };

  return (value: T, index: number) => ({
    role: 'radio' as const,
    'aria-checked': value === selected,
    tabIndex: index === tabStop ? 0 : -1,
    disabled: disabledFlags[index],
    ref: (element: HTMLButtonElement | null) => { buttons.current[index] = element; },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => handleKeyDown(index, event),
    onClick: () => onSelect(value),
  });
}
