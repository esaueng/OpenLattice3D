import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { FeedbackWidget } from './components/FeedbackWidget';
import './App.css';

function App() {
  const handleTestNotification = async () => {
    if (!('Notification' in window)) {
      window.alert('Notifications are not supported in this browser.');
      return;
    }

    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;

    if (permission !== 'granted') {
      window.alert('Notification permission was not granted.');
      return;
    }

    new Notification('Notification test', {
      body: 'If you can read this, notifications are working.',
    });
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
