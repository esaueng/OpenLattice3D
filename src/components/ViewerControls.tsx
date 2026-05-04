import { useStore } from '../store/useStore';
import type { ViewMode } from '../store/useStore';

const VIEW_LABELS: Record<ViewMode, string> = {
  original: 'Original',
  lattice: 'Solid',
  cross_section: 'Cross-Section',
  xray: 'X-Ray',
};

const VIEW_HOTKEYS: Record<ViewMode, string> = {
  original: '1',
  lattice: '2',
  cross_section: '3',
  xray: '4',
};

export function ViewerControls() {
  const store = useStore();
  const {
    resultMesh,
    viewMode,
    viewerBackground,
    demoModeActive,
  } = store;

  return (
    <div className="viewer-controls-panel" aria-label="Viewer controls">
      <div className="view-buttons">
        {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
          <button
            key={mode}
            className={`btn btn-small ${viewMode === mode ? 'btn-active' : ''}`}
            title={`Switch viewer to ${VIEW_LABELS[mode]} mode (${VIEW_HOTKEYS[mode]}).`}
            onClick={() => store.setViewMode(mode)}
            disabled={
              !demoModeActive && (
                (mode === 'lattice' && !resultMesh) ||
                (mode === 'cross_section' && !resultMesh) ||
                (mode === 'xray' && !resultMesh) ||
                (mode === 'original' && !store.originalMesh && !store.sphereMode)
              )
            }
          >
            {VIEW_LABELS[mode]}
          </button>
        ))}
      </div>
      <div className="viewer-background-swatch" title="Set the 3D viewer background color.">
        <input
          type="color"
          value={viewerBackground}
          title="Set the 3D viewer background color."
          onChange={(e) => store.setViewerBackground(e.target.value)}
          aria-label="Viewer background color"
        />
      </div>
    </div>
  );
}
