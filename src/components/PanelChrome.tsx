// Shared chrome for the step panels: the question header, the Back/Continue footer,
// sections and fold-away "More options".
import type { ReactNode } from 'react';
import { useStore } from '../store/useStore';
import { adjacentStep, canNavigateToStep, visibleSteps, type WorkflowInputs } from './workflow';
import { ChevronDownIcon } from './icons';
import type { WorkflowStep } from '../store/useStore';

type StepPanelProps = {
  step: WorkflowStep;
  inputs: WorkflowInputs;
  /** Replaces the question as the heading (Results leads with its verdict). */
  heading?: ReactNode;
  children: ReactNode;
  /** Replaces "Continue to …" as the footer's one primary action. */
  primaryAction?: ReactNode;
};

export function StepPanel({ step, inputs, heading, children, primaryAction }: StepPanelProps) {
  const setWorkflowStep = useStore((s) => s.setWorkflowStep);
  const steps = visibleSteps(inputs);
  const index = steps.findIndex((entry) => entry.id === step);
  const info = steps[index];
  const previous = adjacentStep(step, inputs, -1);
  const next = adjacentStep(step, inputs, 1);
  const canGoNext = Boolean(next && canNavigateToStep(next.id, inputs));

  return (
    <div className="step-panel">
      <header className="step-panel-header">
        <div className="step-panel-eyebrow">Step {index + 1} of {steps.length} · {info?.label}</div>
        {heading ?? <h2 className="step-panel-question">{info?.question ?? info?.label}</h2>}
        {info?.helper && <p className="step-panel-helper">{info.helper}</p>}
      </header>
      <div className="step-panel-body">{children}</div>
      <footer className="workflow-nav" aria-label="Workflow navigation">
        {/* Back keeps its place (disabled, not hidden) so the primary action never moves. */}
        <button
          type="button"
          className="workflow-nav-back"
          disabled={!previous}
          title="Previous step (B)"
          aria-label={previous ? `Back to ${previous.label}. Shortcut B` : 'Back. Shortcut B'}
          onClick={() => previous && setWorkflowStep(previous.id)}
        >
          <span>Back</span>
          <kbd>B</kbd>
        </button>
        {primaryAction ?? (next ? (
          <button
            type="button"
            className="btn btn-primary workflow-nav-next"
            disabled={!canGoNext}
            title="Next step (N)"
            aria-label={`Continue to ${next.label}. Shortcut N`}
            onClick={() => canGoNext && setWorkflowStep(next.id)}
          >
            <span className="workflow-nav-label">Continue to {next.label.toLowerCase()}</span>
            <kbd>N</kbd>
          </button>
        ) : <span />)}
      </footer>
    </div>
  );
}

export function PanelSection({ title, aside, children, id, className }: {
  title?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <section className={`panel-block${className ? ` ${className}` : ''}`} id={id} tabIndex={id ? -1 : undefined}>
      {(title || aside) && (
        <div className="panel-block-header">
          {title && <h3>{title}</h3>}
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function Collapsible({ title, subtitle, children, defaultOpen = false }: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details className="collapsible" open={defaultOpen || undefined}>
      <summary className="collapsible-summary">
        <span className="collapsible-title">{title}</span>
        {subtitle && <span className="collapsible-subtitle">{subtitle}</span>}
        <ChevronDownIcon className="icon collapsible-chevron" size={14} />
      </summary>
      <div className="collapsible-body">{children}</div>
    </details>
  );
}

/** A labelled choice that reads as one control: a radio group styled as segments. */
export function Segmented<T extends string>({ label, value, options, onChange, disabled }: {
  label: string;
  value: T;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label} style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? 'active' : ''}
          title={option.title}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
