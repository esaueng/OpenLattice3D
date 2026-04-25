import { useEffect } from 'react';
import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { useStore } from './store/useStore';
import { registerNotificationServiceWorker } from './utils/notifications';
import './App.css';

type WorkflowStep = {
  id: string;
  label: string;
  icon: string;
  complete: boolean;
  active: boolean;
};

function App() {
  const {
    originalMesh,
    sphereMode,
    resultMesh,
    validation,
    generating,
    progress,
    params,
    logs,
    meshFileName,
    demoModeActive,
  } = useStore();

  useEffect(() => {
    void registerNotificationServiceWorker();
  }, []);

  const hasModel = Boolean(originalMesh || sphereMode);
  const latestLog = logs[0]?.message ?? 'Ready';
  const workflow: WorkflowStep[] = [
    { id: 'model', label: 'Model', icon: 'M', complete: hasModel, active: !hasModel },
    { id: 'lattice', label: 'Lattice', icon: 'L', complete: hasModel, active: hasModel && !resultMesh && !generating },
    { id: 'generate', label: 'Generate', icon: 'G', complete: Boolean(resultMesh), active: generating },
    { id: 'inspect', label: 'Inspect', icon: 'I', complete: Boolean(validation), active: Boolean(resultMesh) && !validation },
    { id: 'export', label: 'Export', icon: 'E', complete: Boolean(resultMesh), active: Boolean(resultMesh) && Boolean(validation) },
  ];

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Open Lattice 3D">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 2 3.5 6.8v10.4L12 22l8.5-4.8V6.8L12 2Zm0 2.4 5.7 3.2L12 10.8 6.3 7.6 12 4.4Zm-6.3 5.1 5.2 3v6.2l-5.2-3V9.5Zm7.4 9.2v-6.2l5.2-3v6.2l-5.2 3Z" />
            </svg>
          </span>
          <span>Open Lattice 3D</span>
          <span className="version-chip">beta</span>
        </div>

        <div className="topbar-divider" />
        <div className="breadcrumb" aria-label="Project status">
          <span className="breadcrumb-chip">{meshFileName || 'Untitled lattice study'}</span>
          <span className="breadcrumb-sep">/</span>
          <span>{params.latticeType}</span>
        </div>

        <div className="topbar-tools">
          <span className={`run-pill ${generating ? 'running' : ''}`}>
            <span />
            {generating ? `${Math.round(progress * 100)}%` : demoModeActive ? 'multiview' : 'local'}
          </span>
          <a
            className="icon-button"
            href="https://github.com/esaueng/OpenLattice3D"
            target="_blank"
            rel="noreferrer"
            aria-label="Open GitHub repository"
            title="Open GitHub repository"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.24c-3.34.73-4.04-1.62-4.04-1.62-.55-1.4-1.33-1.77-1.33-1.77-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.25 1.84 1.25 1.07 1.84 2.81 1.31 3.49 1 .11-.78.42-1.31.76-1.61-2.66-.31-5.46-1.34-5.46-5.96 0-1.32.47-2.39 1.24-3.24-.12-.31-.54-1.56.12-3.26 0 0 1.01-.32 3.3 1.24a11.4 11.4 0 0 1 6 0c2.29-1.56 3.3-1.24 3.3-1.24.66 1.7.24 2.95.12 3.26.77.85 1.24 1.92 1.24 3.24 0 4.63-2.8 5.65-5.47 5.95.43.37.81 1.1.81 2.22v3.3c0 .32.22.69.82.58A12 12 0 0 0 12 .5Z" />
            </svg>
          </a>
          <a
            className="topbar-action"
            href="https://form.esauengineering.com/feedback-openlattice3d"
            target="_blank"
            rel="noreferrer"
          >
            Feedback
          </a>
        </div>
      </header>

      <main className="workspace">
        <nav className="stepbar" aria-label="Lattice workflow">
          <div className="stepbar-eyebrow">workflow</div>
          <div className="step-list">
            {workflow.map((step) => (
              <div key={step.id} className={`step ${step.active ? 'active' : ''}`}>
                <span className={`step-icon ${step.complete ? 'done' : ''}`} aria-hidden="true">
                  {step.icon}
                </span>
                <span>{step.label}</span>
                <span className="step-dot" />
              </div>
            ))}
          </div>
          <div className="stepbar-footer">
            <div><span>units</span><strong>mm</strong></div>
            <div><span>kernel</span><strong>local</strong></div>
            <div><span>mode</span><strong>{demoModeActive ? 'grid' : 'single'}</strong></div>
          </div>
        </nav>

        <section className="tool-panel left-panel" aria-label="Lattice setup">
          <LeftPanel />
        </section>

        <section className="viewer-shell" aria-label="3D lattice viewer">
          <div className="viewer-hud">
            <div className="viewer-readout">
              <span>{hasModel ? meshFileName : 'No model loaded'}</span>
              <strong>{resultMesh ? `${resultMesh.triCount.toLocaleString()} tris` : 'Viewport ready'}</strong>
            </div>
          </div>
          <Viewer3D />
        </section>

        <aside className="side-panel right-panel" aria-label="Inspection and export">
          <RightPanel />
        </aside>
      </main>

      <footer className="statusbar">
        <span className="statusbar-brand">Esau Engineering</span>
        <span className="statusbar-message">{latestLog}</span>
        <a href="https://esauengineering.com/" target="_blank" rel="noreferrer">
          esauengineering.com
        </a>
      </footer>
    </div>
  );
}

export default App;
