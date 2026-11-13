// Carries out a GuidanceAction: apply its parameter change, open the step, then
// reveal and focus the control (opening a collapsed section around it).
import { useStore } from '../store/useStore';
import type { GuidanceAction } from '../utils/result-guidance';

const REVEAL_ATTEMPTS = 6;

export function revealControl(controlId: string, attempt = 0): void {
  if (typeof window === 'undefined') return;
  window.requestAnimationFrame(() => {
    const target = document.getElementById(controlId);
    if (!target) {
      // The step panel mounts on the next render; retry for a few frames.
      if (attempt < REVEAL_ATTEMPTS) revealControl(controlId, attempt + 1);
      return;
    }
    const details = target.closest('details');
    if (details && !details.open) details.open = true;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
    target.focus({ preventScroll: true });
  });
}

export function runGuidanceAction(action: GuidanceAction): void {
  const store = useStore.getState();
  if (action.params) store.updateParams(action.params);
  store.setWorkflowStep(action.step);
  if (action.controlId) revealControl(action.controlId);
}
