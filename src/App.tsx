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
    <div className="app">
      <LeftPanel />
      <div className="viewer-container">
        <Viewer3D />
      </div>
      <RightPanel />
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
