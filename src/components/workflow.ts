// The guided workflow: which steps exist, what each asks, and when each is done.
// Pure so the stepper's state rules are unit-tested without a DOM.
import type { WorkflowStep } from '../store/useStore';

export interface WorkflowStepInfo {
  id: WorkflowStep;
  label: string;
  /** The question the step answers; Results leads with its verdict instead. */
  question?: string;
  helper: string;
}

export const WORKFLOW_STEPS: readonly WorkflowStepInfo[] = [
  { id: 'model', label: 'Model', question: 'Which part gets the lattice?', helper: 'Import an STL, open a saved project, or start from a sample part.' },
  { id: 'regions', label: 'Regions', question: 'What must stay solid?', helper: 'Optional. Paint faces that must keep their surface or stay solid below it.' },
  { id: 'lattice', label: 'Lattice', question: 'What structure fills it?', helper: 'Pick a cell type and size. Unsure? Compare all twelve on this part.' },
  { id: 'shell', label: 'Shell', question: 'How is the outside finished?', helper: 'Keep a solid skin, leave the lattice open, or fill only a band under the surface.' },
  { id: 'generate', label: 'Generate', question: 'Ready to generate?', helper: 'Check the estimate and quality, then build the lattice on this device.' },
  { id: 'results', label: 'Results', helper: 'Manufacturability checks, part statistics and export.' },
];

export interface WorkflowInputs {
  /** An imported mesh or a procedural sample is loaded. */
  hasModel: boolean;
  /** Painting needs real triangles; procedural samples have none. */
  hasImportedMesh: boolean;
  demoModeActive: boolean;
  hasResult: boolean;
  resultStale: boolean;
  /** Null until validation has reported for the current result. */
  validationPassed: boolean | null;
  paintedFaces: number;
  preflightBlocked: boolean;
}

export type StepStatus = 'done' | 'blocked' | 'attention' | 'idle';

export function visibleSteps(inputs: WorkflowInputs): WorkflowStepInfo[] {
  return WORKFLOW_STEPS.filter((step) => step.id !== 'regions' || inputs.hasImportedMesh);
}

export function canNavigateToStep(step: WorkflowStep, inputs: WorkflowInputs): boolean {
  if (step === 'model') return true;
  if (step === 'results') return inputs.hasResult;
  if (step === 'regions') return inputs.hasImportedMesh;
  if (step === 'generate') return inputs.hasModel;
  return inputs.hasModel || inputs.demoModeActive;
}

/** Done means present and valid; blocked carries a reason, never colour alone. */
export function stepStatus(step: WorkflowStep, inputs: WorkflowInputs): { status: StepStatus; reason?: string } {
  switch (step) {
    case 'model':
      return { status: inputs.hasModel ? 'done' : 'idle' };
    case 'regions':
      return { status: inputs.paintedFaces > 0 ? 'done' : 'idle' };
    case 'lattice':
    case 'shell':
      // Defaults are always valid, so a tick here would claim progress nobody made.
      return { status: 'idle' };
    case 'generate':
      if (inputs.preflightBlocked) return { status: 'blocked', reason: 'The estimate is over the safe limit for this browser.' };
      if (inputs.hasResult && inputs.resultStale) return { status: 'attention', reason: 'Settings changed since the last run.' };
      return { status: inputs.hasResult ? 'done' : 'idle' };
    case 'results':
      if (!inputs.hasResult || inputs.validationPassed === null) return { status: 'idle' };
      if (!inputs.validationPassed) return { status: 'blocked', reason: 'Some checks failed.' };
      return { status: inputs.resultStale ? 'attention' : 'done', reason: inputs.resultStale ? 'The result is out of date.' : undefined };
  }
}

export function adjacentStep(step: WorkflowStep, inputs: WorkflowInputs, direction: 1 | -1): WorkflowStepInfo | undefined {
  const steps = visibleSteps(inputs);
  const index = steps.findIndex((entry) => entry.id === step);
  if (index < 0) return direction === 1 ? steps[0] : undefined;
  return steps[index + direction];
}

/** A hidden or unreachable step falls back to the nearest reachable one before it. */
export function reachableStep(step: WorkflowStep, inputs: WorkflowInputs): WorkflowStep {
  const order = WORKFLOW_STEPS.map((entry) => entry.id);
  for (let index = order.indexOf(step); index > 0; index--) {
    const candidate = order[index];
    const visible = visibleSteps(inputs).some((entry) => entry.id === candidate);
    if (visible && canNavigateToStep(candidate, inputs)) return candidate;
  }
  return 'model';
}
