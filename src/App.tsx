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
        <div className="topbar-side" aria-hidden="true" />
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
