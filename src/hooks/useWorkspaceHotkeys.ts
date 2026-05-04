import { useEffect } from 'react';
import { useStore, type ViewMode } from '../store/useStore';
import type { LatticeGenerationControls } from './useLatticeGeneration';

const VIEW_HOTKEYS: Record<string, ViewMode> = {
  '1': 'original',
  '2': 'lattice',
  '3': 'cross_section',
  '4': 'xray',
};

const VIEW_LABELS: Record<ViewMode, string> = {
  original: 'Original',
  lattice: 'Solid',
  cross_section: 'Cross-Section',
  xray: 'X-Ray',
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target instanceof HTMLInputElement) return true;
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLSelectElement) return true;
  return Boolean(target.closest('[contenteditable="true"]'));
}

function canSelectView(mode: ViewMode): boolean {
  const store = useStore.getState();
  if (store.demoModeActive) return true;
  if (mode === 'original') return Boolean(store.originalMesh || store.sphereMode);
  return Boolean(store.resultMesh);
}

export function useWorkspaceHotkeys({ startGeneration, canGenerate }: LatticeGenerationControls) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      const key = event.key.toLowerCase();
      const store = useStore.getState();

      if (key === 'h') {
        event.preventDefault();
        store.resetViewport();
        store.addLog('Viewport reset (H)');
        return;
      }

      if (key === 'g') {
        if (!canGenerate()) return;
        event.preventDefault();
        startGeneration();
        return;
      }

      const viewMode = VIEW_HOTKEYS[key];
      if (!viewMode || !canSelectView(viewMode)) return;

      event.preventDefault();
      store.setViewMode(viewMode);
      store.addLog(`View: ${VIEW_LABELS[viewMode]} (${key})`);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canGenerate, startGeneration]);
}
