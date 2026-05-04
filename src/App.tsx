import { useEffect, useRef, useState, type MouseEvent, type PointerEvent } from 'react';
import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { useStore, type LogEntry } from './store/useStore';
import { registerNotificationServiceWorker } from './utils/notifications';
import { useLatticeGeneration } from './hooks/useLatticeGeneration';
import { useWorkspaceHotkeys } from './hooks/useWorkspaceHotkeys';
import './App.css';

function App() {
  const {
    originalMesh,
    sphereMode,
    resultMesh,
    generating,
    progress,
    params,
    meshFileName,
    demoModeActive,
    logs,
    clearLogs,
  } = useStore();
  const generationControls = useLatticeGeneration();

  useWorkspaceHotkeys(generationControls);

  useEffect(() => {
    void registerNotificationServiceWorker();
  }, []);

  const hasModel = Boolean(originalMesh || sphereMode);
  const modelLabel = meshFileName || (sphereMode ? 'Primitive sphere' : 'Untitled lattice study');
  const resultStats = resultMesh ? `${resultMesh.triCount.toLocaleString()} tris` : 'Mesh pending';
  const progressLabel = `${Math.round(progress * 100)}%`;
  const solverStatus = generating ? `Generating ${progressLabel}` : hasModel ? 'Ready' : 'Idle';
  const viewportMode = demoModeActive ? 'Multiview' : hasModel ? 'Interactive' : 'Standby';

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Open Lattice 3D">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2 3.5 6.8v10.4L12 22l8.5-4.8V6.8L12 2Zm0 2.4 5.7 3.2L12 10.8 6.3 7.6 12 4.4Zm-6.3 5.1 5.2 3v6.2l-5.2-3V9.5Zm7.4 9.2v-6.2l5.2-3v6.2l-5.2 3Z" />
            </svg>
          </span>
          <span>OpenLattice3D</span>
          <span className="version-chip">beta</span>
        </div>

        <div className="topbar-divider" />
        <div className="chrome-path" aria-label="Project status">
          <span className="chrome-path-root">OpenLattice3D</span>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-chip">{modelLabel}</span>
          <span className="breadcrumb-sep">/</span>
          <span className="chrome-path-leaf">{params.latticeType}</span>
        </div>
      </header>

      <main className="workspace">
        <section className="tool-panel left-panel" aria-label="Lattice setup">
          <LeftPanel generationControls={generationControls} />
        </section>

        <section className="viewer-shell" aria-label="3D lattice viewer">
          <div className="viewer-hud">
            <div className="viewer-readout">
              <span>{hasModel ? modelLabel : 'No model loaded'}</span>
              <strong>{resultMesh ? resultStats : 'Viewport ready'}</strong>
            </div>
          </div>
          <Viewer3D />
        </section>

        <aside className="side-panel right-panel" aria-label="Inspection and export">
          <RightPanel />
        </aside>
      </main>

      <footer className="statusbar">
        <BottomLogDrawer logs={logs} onClearLogs={clearLogs} />
        <div className="statusbar-group" aria-label="Model and solver status">
          <span className="statusbar-segment">Lattice: {params.latticeType}</span>
          <span className="statusbar-segment">Result: {resultStats}</span>
          <span className="statusbar-segment">Solver: {solverStatus}</span>
          <span className="statusbar-segment">Viewport: {viewportMode}</span>
        </div>
        <div className="status-links" aria-label="Project links">
          <a
            className="status-link donate-link"
            href="https://ko-fi.com/esauengineering"
            target="_blank"
            rel="noreferrer"
            title="Support OpenLattice3D on Ko-fi"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 2v2" />
              <path d="M14 2v2" />
              <path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1" />
              <path d="M6 2v2" />
            </svg>
            Buy me a coffee
          </a>
          <a
            className="status-link"
            href="https://form.esauengineering.com/feedback-openlattice3d"
            target="_blank"
            rel="noreferrer"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            feedback
          </a>
          <a
            className="status-link"
            href="https://github.com/esaueng/OpenLattice3D"
            target="_blank"
            rel="noreferrer"
            aria-label="Open GitHub repository"
            title="Open GitHub repository"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
              <path d="M9 18c-4.51 2-5-2-7-2" />
            </svg>
            github
          </a>
        </div>
      </footer>
    </div>
  );
}

function BottomLogDrawer({ logs, onClearLogs }: { logs: LogEntry[]; onClearLogs: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(320);
  const [clearPromptVisible, setClearPromptVisible] = useState(false);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const formattedLogs = logs.map(formatLogEntry);

  useEffect(() => {
    if (!clearPromptVisible) return undefined;
    const timeoutId = window.setTimeout(() => setClearPromptVisible(false), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [clearPromptVisible]);

  function toggleLogs(event: MouseEvent<HTMLButtonElement>) {
    setExpanded((current) => !current);
    event.currentTarget.blur();
  }

  function startDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragStart.current = { y: event.clientY, height: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const maxHeight = Math.max(260, window.innerHeight - 120);
    const nextHeight = dragStart.current.height + dragStart.current.y - event.clientY;
    setDrawerHeight(Math.min(maxHeight, Math.max(260, nextHeight)));
  }

  function stopDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function copyLogs() {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(formattedLogs.join('\n'));
  }

  function clearLogEntries(event: MouseEvent<HTMLButtonElement>) {
    if (!logs.length) return;
    if (clearPromptVisible || event.detail >= 2) {
      setClearPromptVisible(false);
      onClearLogs();
      event.currentTarget.blur();
      return;
    }
    setClearPromptVisible(true);
  }

  return (
    <>
      {expanded && (
        <div className="bottom-content logs-content" style={{ height: drawerHeight }}>
          <button
            type="button"
            className="bottom-resize-handle"
            aria-label="Resize drawer"
            title="Drag up to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
          />
          <div className="logs-drawer-header">
            <span>Run logs</span>
            <div className="logs-drawer-actions">
              <button type="button" className="log-copy-button" onClick={copyLogs}>Copy logs</button>
              <button
                type="button"
                className="log-clear-button"
                disabled={!logs.length}
                title="Double-click to clear run logs"
                aria-label="Clear logs. Double-click to clear."
                onClick={clearLogEntries}
              >
                {clearPromptVisible ? 'Double-click to clear' : 'Clear logs'}
              </button>
            </div>
          </div>
          <pre>{formattedLogs.length ? formattedLogs.join('\n') : 'No log entries.'}</pre>
        </div>
      )}
      <div className="status-tabs">
        <button type="button" className={expanded ? 'active' : ''} onClick={toggleLogs}>
          Logs
          <span className="count-pill">{logs.length}</span>
        </button>
      </div>
    </>
  );
}

function formatLogEntry(entry: LogEntry) {
  const level = entry.level === 'error' ? 'ERR' : entry.level === 'warn' ? 'WARN' : 'INFO';
  return `${new Date(entry.time).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, ' ')} ${entry.message}`;
}

export default App;
