import { useStore } from '../store/useStore';
import type { ClipAxis, ViewMode } from '../store/useStore';

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
    clipPlane,
    viewerBackground,
    demoModeActive,
  } = store;

  return (
    <section className="viewer-controls-panel" aria-label="Viewer controls">
      <div className="viewer-controls-header">View</div>
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

      <button
        className="btn btn-small btn-full"
        title="Reset the 3D viewport to the standard Z-up isometric view (H)."
        onClick={store.resetViewport}
        type="button"
      >
        Reset Viewport
      </button>

      {viewMode === 'cross_section' && (
        <div className="clip-controls">
          <div className="row">
            <label>Cut axis:</label>
            <div className="axis-buttons">
              {(['x', 'y', 'z'] as ClipAxis[]).map((a) => (
                <button
                  key={a}
                  className={`btn btn-tiny ${clipPlane.axis === a ? 'btn-active' : ''}`}
                  title={`Set cross-section clipping axis to ${a.toUpperCase()}.`}
                  onClick={() => store.setClipPlane({ axis: a })}
                >
                  {a.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <label>Position:</label>
            <input
              type="range"
              title="Move the clipping plane through the model in cross-section mode."
              min={0}
              max={1}
              step={0.005}
              value={clipPlane.position}
              onChange={(e) => store.setClipPlane({ position: parseFloat(e.target.value) })}
            />
            <span>{(clipPlane.position * 100).toFixed(0)}%</span>
          </div>
          <div className="row checkbox-row">
            <label>
              <input
                type="checkbox"
                title="Reverse which side of the clipping plane is shown."
                checked={clipPlane.flipped}
                onChange={(e) => store.setClipPlane({ flipped: e.target.checked })}
              />
              Flip direction
            </label>
          </div>
        </div>
      )}

      {viewMode === 'xray' && (
        <div className="info-text viewer-controls-hint">
          Shell rendered transparent. Orbit to see internal lattice structure.
        </div>
      )}

      <div className="row viewer-background-row">
        <label>Background:</label>
        <input
          type="color"
          value={viewerBackground}
          title="Set the 3D viewer background color."
          onChange={(e) => store.setViewerBackground(e.target.value)}
          aria-label="Viewer background color"
        />
        <button
          className="btn btn-tiny"
          title="Reset viewer background to default black."
          onClick={() => store.setViewerBackground('#000000')}
          type="button"
        >
          Reset
        </button>
      </div>
    </section>
  );
}
