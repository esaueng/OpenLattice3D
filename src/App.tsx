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
            className="btn btn-github"
            href="https://github.com/esaueng/OpenLattice3D"
            target="_blank"
            rel="noreferrer"
            aria-label="Open GitHub repository"
            title="Open GitHub repository"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 .5a12 12 0 0 0-3.79 23.39c.6.11.82-.26.82-.58v-2.24c-3.34.73-4.04-1.62-4.04-1.62-.55-1.4-1.33-1.77-1.33-1.77-1.09-.74.08-.73.08-.73 1.2.09 1.84 1.25 1.84 1.25 1.07 1.84 2.81 1.31 3.49 1 .11-.78.42-1.31.76-1.61-2.66-.31-5.46-1.34-5.46-5.96 0-1.32.47-2.39 1.24-3.24-.12-.31-.54-1.56.12-3.26 0 0 1.01-.32 3.3 1.24a11.4 11.4 0 0 1 6 0c2.29-1.56 3.3-1.24 3.3-1.24.66 1.7.24 2.95.12 3.26.77.85 1.24 1.92 1.24 3.24 0 4.63-2.8 5.65-5.47 5.95.43.37.81 1.1.81 2.22v3.3c0 .32.22.69.82.58A12 12 0 0 0 12 .5Z" />
            </svg>
            <span>GitHub Repo</span>
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
