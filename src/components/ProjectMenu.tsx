// The top bar's ⋯ menu: project actions, privacy and shortcuts, out of the step panels.
import { useEffect, useRef, useState } from 'react';
import { useModelImport } from '../hooks/useModelImport';
import { AnalyticsConsent } from './AnalyticsConsent';
import { FolderOpenIcon, MoreIcon, UploadIcon, XIcon } from './icons';

const SHORTCUTS: readonly [string, string][] = [
  ['G', 'Generate'],
  ['B / N', 'Previous / next step'],
  ['1–4', 'Original, Solid, Cross-section, X-ray'],
  ['H', 'Reset view'],
  ['Ctrl/⌘ Z', 'Undo (Shift to redo)'],
];

export function ProjectMenu() {
  const [open, setOpen] = useState(false);
  const intake = useModelImport();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    popoverRef.current?.querySelector<HTMLElement>('button, input, a')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  const run = (action: () => void) => () => {
    action();
    setOpen(false);
  };

  return (
    <div className="project-menu-anchor">
      {intake.fileInputs}
      <button
        ref={triggerRef}
        type="button"
        className="icon-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? 'project-menu' : undefined}
        aria-label="Project menu"
        title="Project, privacy and shortcuts"
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon size={18} />
      </button>
      {open && (
        <div ref={popoverRef} id="project-menu" className="project-menu" role="dialog" aria-label="Project menu">
          <div className="project-menu-header">
            <span>Project</span>
            <button type="button" className="icon-button" aria-label="Close project menu" onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
              <XIcon size={15} />
            </button>
          </div>
          <div className="project-menu-actions">
            <button type="button" className="menu-row" onClick={run(intake.pickStl)}><UploadIcon size={15} />Import STL…</button>
            <button type="button" className="menu-row" onClick={run(intake.pickProject)}><FolderOpenIcon size={15} />Open project…</button>
            <button
              type="button"
              className={`menu-row menu-row-danger${intake.clearAllArmed ? ' armed' : ''}`}
              aria-live="polite"
              title="Reset the project, parameters, and generated results."
              // The first click arms; only the confirming click resets and closes.
              onClick={() => { intake.reset(); if (intake.clearAllArmed) setOpen(false); }}
            >
              <XIcon size={15} />
              {intake.clearAllArmed ? 'Click again to start over' : 'Start over'}
            </button>
          </div>
          <div className="project-menu-section">
            <AnalyticsConsent />
          </div>
          <div className="project-menu-section">
            <h3>Keyboard shortcuts</h3>
            <dl className="shortcut-list">
              {SHORTCUTS.map(([keys, action]) => (
                <div key={keys}><dt><kbd>{keys}</kbd></dt><dd>{action}</dd></div>
              ))}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}
