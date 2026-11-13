// App-wide model intake: drop an STL (or project) anywhere on the workspace, and
// the one prompt that asks before another model replaces work in progress.
// Dropped files are read by the same local intake path as the file pickers.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from '../store/useStore';
import { useModelImport } from '../hooks/useModelImport';
import { isPendingCurrent, pendingReplacementLabel, usePendingReplacement } from '../hooks/pending-model-replacement';
import { describeWorkAtRisk, workLostByReplacingModel } from '../utils/model-replacement';
import { dragCarriesFiles, pickDroppedFile } from '../utils/dropped-files';
import { confirmActionLabel, REPLACE_MODEL_ACTION } from './confirm';
import { UploadIcon } from './icons';

export function ModelIntakeLayer() {
  const intake = useModelImport();
  const dragging = useFileDrop((file) => {
    // The Model step shows the import notice and any unit prompt.
    useStore.getState().setWorkflowStep('model');
    void intake.importFile(file);
  });

  return (
    <>
      {dragging && (
        <div className="file-drop-overlay" aria-hidden="true">
          <div className="file-drop-card">
            <UploadIcon size={22} />
            <strong>Drop an STL, 3MF or OBJ to import it</strong>
            <span>Millimetres. The file is read on this device and never uploaded.</span>
          </div>
        </div>
      )}
      <ReplaceModelPrompt onConfirm={intake.confirmReplacement} onCancel={intake.cancelReplacement} />
    </>
  );
}

/** Window-level file drag tracking; returns whether files are being dragged over the page. */
function useFileDrop(onDrop: (file: File) => void): boolean {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const onDropRef = useRef(onDrop);
  useEffect(() => { onDropRef.current = onDrop; }, [onDrop]);

  useEffect(() => {
    const carriesFiles = (event: DragEvent) => dragCarriesFiles(event.dataTransfer ? Array.from(event.dataTransfer.types) : null);
    const handleEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const handleOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser would open the file in the tab instead.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const handleLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const handleDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = pickDroppedFile(Array.from(event.dataTransfer?.files ?? []));
      if (file) onDropRef.current(file);
    };
    window.addEventListener('dragenter', handleEnter);
    window.addEventListener('dragover', handleOver);
    window.addEventListener('dragleave', handleLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleEnter);
      window.removeEventListener('dragover', handleOver);
      window.removeEventListener('dragleave', handleLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  return dragging;
}

function ReplaceModelPrompt({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const pending = usePendingReplacement((s) => s.pending);
  const epoch = useStore((s) => s.modelIntakeEpoch);
  const currentName = useStore((s) => s.meshFileName);
  const originalMesh = useStore((s) => s.originalMesh);
  const sphereMode = useStore((s) => s.sphereMode);
  const resultMesh = useStore((s) => s.resultMesh);
  const pinnedRun = useStore((s) => s.pinnedRun);
  const keepOutTris = useStore((s) => s.keepOutTris);
  const keepInTris = useStore((s) => s.keepInTris);
  const demoModeActive = useStore((s) => s.demoModeActive);
  const risk = workLostByReplacingModel({ originalMesh, sphereMode, resultMesh, pinnedRun, keepOutTris, keepInTris, demoModeActive });
  const keepRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const visible = isPendingCurrent(pending, epoch);

  // Like a dialog: focus the safe choice on open, hand focus back on close.
  useEffect(() => {
    if (!visible) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    keepRef.current?.focus();
    return () => {
      const target = returnFocus.current;
      if (target && target.isConnected) target.focus();
    };
  }, [visible]);

  if (!visible || !pending) return null;
  const nextName = pendingReplacementLabel(pending);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    onCancel();
  };

  return (
    <div
      className="replace-prompt"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="replace-prompt-title"
      aria-describedby="replace-prompt-detail"
      onKeyDown={handleKeyDown}
    >
      <strong id="replace-prompt-title">Replace {currentName || 'the current model'} with {nextName}?</strong>
      <p id="replace-prompt-detail">
        {risk
          ? <>This discards {describeWorkAtRisk(risk)}, and clears the undo history. It cannot be undone.</>
          : <>This clears the undo history for the current model.</>}
      </p>
      <div className="replace-prompt-actions">
        <button ref={keepRef} type="button" className="btn" onClick={onCancel}>Keep current model</button>
        <button type="button" className="btn btn-danger" onClick={onConfirm}>{confirmActionLabel(REPLACE_MODEL_ACTION)}</button>
      </div>
    </div>
  );
}
