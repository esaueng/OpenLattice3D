import { LeftPanel } from './components/LeftPanel';
import { Viewer3D } from './components/Viewer3D';
import { RightPanel } from './components/RightPanel';
import './App.css';

function App() {
  return (
    <div className="app">
      <LeftPanel />
      <div className="viewer-container">
        <Viewer3D />
      </div>
      <RightPanel />
    </div>
  );
}

export default App;
