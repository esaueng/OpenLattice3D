import { useEffect } from 'react';
import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { FeedbackWidget } from './components/FeedbackWidget';
import { registerNotificationServiceWorker, sendNotification } from './utils/notifications';
import './App.css';

function App() {
  useEffect(() => {
    void registerNotificationServiceWorker();
  }, []);

  const handleTestNotification = async () => {
    const sent = await sendNotification('Notification test', {
      body: 'If you can read this, notifications are working.',
    });

    if (!sent) {
      globalThis.alert?.('Notification permission was not granted or notifications are unsupported.');
    }
  };

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <div>
          <h1>Open Lattice 3D <span className="beta-pill">beta</span></h1>
          <p>Generate manufacturable lattice geometries with live validation.</p>
        </div>
      </header>
      <div className="app">
        <LeftPanel />
        <div className="viewer-container">
          <Viewer3D />
        </div>
        <RightPanel />
      </div>
      <FeedbackWidget />
      <div className="watermark">
        <a href="https://esauengineering.com/" target="_blank" rel="noreferrer">
          Built by Esau Engineering
        </a>
      </div>
      <button className="btn btn-small notification-test-btn" onClick={handleTestNotification}>
        Test notification
      </button>
    </div>
  );
}

export default App;
