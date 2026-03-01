import { useEffect } from 'react';
import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { registerNotificationServiceWorker } from './utils/notifications';
import './App.css';

function App() {
  useEffect(() => {
    void registerNotificationServiceWorker();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div className="topbar-side">
          <a
            className="topbar-github-link"
            href="https://github.com/esaueng/OpenLattice3D"
            target="_blank"
            rel="noreferrer"
            aria-label="Open GitHub repository"
            title="Open GitHub repository"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 0C3.58 0 0 3.58 0 8a8.01 8.01 0 0 0 5.47 7.59c.4.07.55-.17.55-.38v-1.34c-2.23.49-2.7-.94-2.7-.94-.36-.92-.9-1.16-.9-1.16-.73-.5.06-.49.06-.49.82.06 1.25.84 1.25.84.71 1.22 1.87.87 2.33.67.08-.52.28-.87.5-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.58.82-2.14-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82a7.57 7.57 0 0 1 4 0c1.53-1.03 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.14 0 3.07-1.86 3.75-3.65 3.95.29.25.54.73.54 1.49v2.2c0 .21.15.46.55.38A8 8 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
            </svg>
          </a>
        </div>
        <div className="topbar-center">
          <h1>Open Lattice 3D <span className="beta-pill">beta</span></h1>
          <p>Generate manufacturable lattice geometries with live validation.</p>
        </div>
        <div className="topbar-side topbar-side-right">
          <a
            className="btn btn-feedback btn-feedback-compact"
            href="https://form.esauengineering.com/feedback-openlattice3d"
            target="_blank"
            rel="noreferrer"
          >
            Bug report / feedback
          </a>
        </div>
      </header>
      <div className="app">
        <LeftPanel />
        <div className="viewer-container">
          <Viewer3D />
        </div>
        <RightPanel />
      </div>
      <div className="watermark">
        <a href="https://esauengineering.com/" target="_blank" rel="noreferrer">
          Built by Esau Engineering
        </a>
      </div>
    </div>
  );
}

export default App;
