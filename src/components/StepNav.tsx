// The workflow as one joined segment bar in the top bar. A tick means present and
// valid; a blocked or out-of-date step carries a glyph and its reason, never colour alone.
import { useStore } from '../store/useStore';
import { canNavigateToStep, stepStatus, visibleSteps, type WorkflowInputs } from './workflow';
import { AlertIcon, CheckIcon } from './icons';

export function StepNav({ inputs }: { inputs: WorkflowInputs }) {
  const activeStep = useStore((s) => s.workflowStep);
  const setWorkflowStep = useStore((s) => s.setWorkflowStep);
  const steps = visibleSteps(inputs);

  return (
    <nav className="step-nav" aria-label="Lattice workflow">
      <ol className="step-nav-list">
        {steps.map((step, index) => {
          const isActive = activeStep === step.id;
          const { status, reason } = stepStatus(step.id, inputs);
          const canSelect = canNavigateToStep(step.id, inputs);
          return (
            <li key={step.id} className="step-nav-item">
              <button
                type="button"
                className={`step-nav-step${isActive ? ' active' : ''}`}
                disabled={!canSelect}
                aria-current={isActive ? 'step' : undefined}
                // Where labels are clipped, the title carries the name (or the reason).
                title={reason ? `${step.label}: ${reason}` : step.label}
                aria-label={reason ? `${step.label}: ${reason}` : undefined}
                onClick={() => setWorkflowStep(step.id)}
              >
                {/* A done step trades its number for a tick; a blocked one keeps its
                    number and adds a warning after the label, never colour alone. */}
                <span className={`step-nav-mark ${status}`} aria-hidden="true">
                  {status === 'done' ? <CheckIcon size={14} strokeWidth={2.4} /> : index + 1}
                </span>
                <span className="step-nav-label">{step.label}</span>
                {status === 'done' && <span className="visually-hidden">, done</span>}
                {(status === 'blocked' || status === 'attention') && (
                  <span className="step-nav-warning" aria-hidden="true"><AlertIcon size={14} strokeWidth={2.2} /></span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
