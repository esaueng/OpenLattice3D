// The workflow as a numbered stepper in the top bar. A tick means present and valid;
// a blocked or out-of-date step carries a glyph and its reason, never colour alone.
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
                <span className={`step-nav-dot ${status}`} aria-hidden="true">
                  {index + 1}
                  {status === 'done' && <span className="step-nav-status"><CheckIcon size={9} strokeWidth={3.2} /></span>}
                  {(status === 'blocked' || status === 'attention') && (
                    <span className="step-nav-status"><AlertIcon size={9} strokeWidth={2.8} /></span>
                  )}
                </span>
                <span className="step-nav-label">{step.label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
