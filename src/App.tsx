import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import { FeedbackWidget } from './components/FeedbackWidget';
import './App.css';

function App() {
  return (
    <div className="app">
      <LeftPanel />
      <div className="viewer-container">
        <Viewer3D />
      </div>
      <RightPanel />
      <FeedbackWidget />
    </div>
  );
}

export default App;
