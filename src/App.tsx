import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { ViewerControls } from './components/ViewerControls';
import { ExportControls } from './components/ExportControls';
import { useStore, type LogEntry } from './store/useStore';
import { registerNotificationServiceWorker } from './utils/notifications';
import { escapeControlCharacters } from './utils/text-safety';
import { useLatticeGeneration } from './hooks/useLatticeGeneration';
import { useWorkspaceHotkeys } from './hooks/useWorkspaceHotkeys';
import './App.css';

function App() {
  const persistenceHydrated = useStore((state) => state.persistenceHydrated);
  return persistenceHydrated ? <HydratedApp /> : <AppBootShell />;
}

function AppBootShell() {
  return (
    <div className="app-shell boot-shell" aria-busy="true" data-boot-state="restoring">
      <h1 className="visually-hidden">OpenLattice3D — 3D lattice generator</h1>
      <header className="topbar">
        <div className="brand" aria-label="Open Lattice 3D">
          <span className="brand-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
          </span>
          <span>OpenLattice3D</span>
          <span className="version-chip">beta</span>
        </div>

        <div className="topbar-divider" />
        <div className="chrome-path" aria-label="Project status">
          <span className="chrome-path-root">OpenLattice3D</span>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-chip">Checking workspace</span>
        </div>
      </header>

      <main className="workspace" id="main-content">
        <section className="tool-panel left-panel" aria-label="Lattice setup">
          <div className="panel-content boot-panel-placeholder" aria-hidden="true">
            <div className="panel-intro">
              <span className="panel-eyebrow">setup</span>
              <h2>Model and lattice</h2>
              <span className="boot-skeleton-line boot-skeleton-line-wide" />
            </div>
            <section className="panel-section">
              <span className="boot-skeleton-line boot-skeleton-line-short" />
              <span className="boot-skeleton-line" />
              <span className="boot-skeleton-line boot-skeleton-line-wide" />
            </section>
            <section className="panel-section">
              <span className="boot-skeleton-line boot-skeleton-line-short" />
              <span className="boot-skeleton-line boot-skeleton-line-wide" />
            </section>
          </div>
        </section>

        <section className="viewer-shell boot-viewer-shell" aria-label="3D lattice viewer">
          <div className="boot-viewer-state" role="status" aria-live="polite">
            <strong>Checking saved preferences…</strong>
            <span>Your viewer settings will be ready in a moment.</span>
          </div>
        </section>
      </main>

      <footer className="statusbar">
        <div className="statusbar-group" aria-label="Workspace restore status">
          <span className="statusbar-segment">Preferences: Loading</span>
        </div>
      </footer>
    </div>
  );
}

function HydratedApp() {
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
    keepOutTris,
    keepInTris,
    selectionMode,
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
  const showFaceLegend = keepOutTris.size > 0 || keepInTris.size > 0 || selectionMode !== 'none';

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to main content</a>
      <h1 className="visually-hidden">OpenLattice3D — 3D lattice generator</h1>
      <header className="topbar">
        <div className="brand" aria-label="Open Lattice 3D">
          <span className="brand-mark" aria-hidden="true">
            <img src="/favicon.svg" alt="" />
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
        <ExportControls />
      </header>

      <main className="workspace" id="main-content" tabIndex={-1}>
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
          {showFaceLegend && (
            <div className="viewer-legend" role="group" aria-label="Face marking legend">
              <span className="viewer-legend-item">
                <span className="viewer-legend-swatch" style={{ background: '#3399ff' }} aria-hidden="true" />
                Keep-out (preserved surface)
              </span>
              <span className="viewer-legend-item">
                <span className="viewer-legend-swatch" style={{ background: '#ff6633' }} aria-hidden="true" />
                Keep-in (stays solid)
              </span>
            </div>
          )}
          <div className="viewer-controls-overlay">
            <ViewerControls />
          </div>
        </section>
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
            href="https://ko-fi.com/esau"
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

const MIN_DRAWER_HEIGHT = 260;
const DRAWER_RESIZE_STEP = 40;

function maxDrawerHeight() {
  const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 800;
  return Math.max(MIN_DRAWER_HEIGHT, viewportHeight - 120);
}

function BottomLogDrawer({ logs, onClearLogs }: { logs: LogEntry[]; onClearLogs: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [drawerHeight, setDrawerHeight] = useState(320);
  const [clearPromptVisible, setClearPromptVisible] = useState(false);
  const dragStart = useRef<{ y: number; height: number } | null>(null);
  const toggleButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLDivElement>(null);
  const hasToggledRef = useRef(false);
  const formattedLogs = logs.map(formatLogEntry);

  useEffect(() => {
    if (!clearPromptVisible) return undefined;
    const timeoutId = window.setTimeout(() => setClearPromptVisible(false), 2200);
    return () => window.clearTimeout(timeoutId);
  }, [clearPromptVisible]);

  // Move focus into the drawer when it opens, and back to its toggle when it closes.
  useEffect(() => {
    if (!hasToggledRef.current) return;
    if (expanded) drawerRef.current?.focus();
    else toggleButtonRef.current?.focus();
  }, [expanded]);

  function toggleLogs() {
    hasToggledRef.current = true;
    setExpanded((current) => !current);
  }

  function closeLogs() {
    hasToggledRef.current = true;
    setExpanded(false);
  }

  function handleDrawerKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      closeLogs();
    }
  }

  function clampDrawerHeight(value: number) {
    return Math.min(maxDrawerHeight(), Math.max(MIN_DRAWER_HEIGHT, value));
  }

  function startDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragStart.current = { y: event.clientY, height: drawerHeight };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: PointerEvent<HTMLButtonElement>) {
    if (!dragStart.current) return;
    const nextHeight = dragStart.current.height + dragStart.current.y - event.clientY;
    setDrawerHeight(clampDrawerHeight(nextHeight));
  }

  function stopDrawerResize(event: PointerEvent<HTMLButtonElement>) {
    dragStart.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  function handleResizeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setDrawerHeight((height) => clampDrawerHeight(height + DRAWER_RESIZE_STEP));
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setDrawerHeight((height) => clampDrawerHeight(height - DRAWER_RESIZE_STEP));
    } else if (event.key === 'Home') {
      event.preventDefault();
      setDrawerHeight(maxDrawerHeight());
    } else if (event.key === 'End') {
      event.preventDefault();
      setDrawerHeight(MIN_DRAWER_HEIGHT);
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
      return;
    }
    setClearPromptVisible(true);
  }

  return (
    <>
      <div className="status-tabs">
        <button
          ref={toggleButtonRef}
          type="button"
          className={expanded ? 'active' : ''}
          aria-expanded={expanded}
          onClick={toggleLogs}
        >
          Logs
          <span className="count-pill">{logs.length}</span>
        </button>
      </div>
      {expanded && (
        <div
          ref={drawerRef}
          className="bottom-content logs-content"
          style={{ height: drawerHeight }}
          role="group"
          aria-label="Run logs"
          tabIndex={-1}
          onKeyDown={handleDrawerKeyDown}
        >
          <button
            type="button"
            className="bottom-resize-handle"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Resize logs drawer. Use up and down arrow keys to resize."
            aria-valuenow={Math.round(drawerHeight)}
            aria-valuemin={MIN_DRAWER_HEIGHT}
            aria-valuemax={Math.round(maxDrawerHeight())}
            title="Drag, or use arrow keys, to resize"
            onPointerDown={startDrawerResize}
            onPointerMove={resizeDrawer}
            onPointerUp={stopDrawerResize}
            onPointerCancel={stopDrawerResize}
            onKeyDown={handleResizeKeyDown}
          />
          <div className="logs-drawer-header">
            <span>Run logs</span>
            <div className="logs-drawer-actions">
              <button type="button" className="log-copy-button" onClick={copyLogs}>Copy logs</button>
              <button
                type="button"
                className="log-clear-button"
                disabled={!logs.length}
                aria-live="polite"
                title={clearPromptVisible ? 'Activate again to clear run logs' : 'Clear run logs'}
                onClick={clearLogEntries}
              >
                {clearPromptVisible ? 'Click again to clear' : 'Clear logs'}
              </button>
            </div>
          </div>
          <pre>{formattedLogs.length ? formattedLogs.join('\n') : 'No log entries.'}</pre>
        </div>
      )}
    </>
  );
}

function formatLogEntry(entry: LogEntry) {
  const level = entry.level === 'error' ? 'ERR' : entry.level === 'warn' ? 'WARN' : 'INFO';
  return `${new Date(entry.time).toLocaleTimeString([], { hour12: false })} ${level.padEnd(4, ' ')} ${escapeControlCharacters(entry.message)}`;
}

export default App;
