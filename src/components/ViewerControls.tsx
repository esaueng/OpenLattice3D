import { useState } from 'react';
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
  const [crossSectionSettingsOpen, setCrossSectionSettingsOpen] = useState(false);
  const store = useStore();
  const {
    resultMesh,
    viewMode,
    viewerBackground,
    demoModeActive,
    clipPlane,
  } = store;
  const crossSectionDisabled = !demoModeActive && !resultMesh;

  return (
    <div className="viewer-controls-panel" aria-label="Viewer controls">
      <div className="view-buttons">
        {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => {
          const disabled = !demoModeActive && (
            (mode === 'lattice' && !resultMesh) ||
            (mode === 'cross_section' && !resultMesh) ||
            (mode === 'xray' && !resultMesh) ||
            (mode === 'original' && !store.originalMesh && !store.sphereMode)
          );

          if (mode !== 'cross_section') {
            return (
              <button
                key={mode}
                className={`btn btn-small ${viewMode === mode ? 'btn-active' : ''}`}
                title={`Switch viewer to ${VIEW_LABELS[mode]} mode (${VIEW_HOTKEYS[mode]}).`}
                onClick={() => store.setViewMode(mode)}
                disabled={disabled}
              >
                {VIEW_LABELS[mode]}
              </button>
            );
          }

          return (
            <div key={mode} className="view-mode-slot view-mode-slot-settings">
              <button
                className={`btn btn-small ${viewMode === mode ? 'btn-active' : ''}`}
                title={`Switch viewer to ${VIEW_LABELS[mode]} mode (${VIEW_HOTKEYS[mode]}).`}
                onClick={() => store.setViewMode(mode)}
                disabled={disabled}
              >
                {VIEW_LABELS[mode]}
              </button>
              <button
                className={`btn btn-small view-settings-button ${viewMode === mode || crossSectionSettingsOpen ? 'btn-active' : ''}`}
                type="button"
                title="Cross-section settings"
                aria-label="Cross-section settings"
                aria-expanded={crossSectionSettingsOpen}
                onClick={() => setCrossSectionSettingsOpen((open) => !open)}
                disabled={crossSectionDisabled}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3 4h10" />
                  <path d="M3 8h10" />
                  <path d="M3 12h10" />
                  <path d="M6 2.75v2.5" />
                  <path d="M10 6.75v2.5" />
                  <path d="M7.5 10.75v2.5" />
                </svg>
              </button>
              {crossSectionSettingsOpen && !crossSectionDisabled && (
                <div className="cross-section-popover" role="menu" aria-label="Cross-section settings">
                  <div className="popover-row">
                    <span>Cut axis</span>
                    <div className="axis-buttons">
                      {(['x', 'y', 'z'] as const).map((axis) => (
                        <button
                          key={axis}
                          type="button"
                          className={`btn btn-tiny ${clipPlane.axis === axis ? 'btn-active' : ''}`}
                          onClick={() => store.setClipPlane({ axis })}
                        >
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="popover-row">
                    <span>Position</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={clipPlane.position}
                      onChange={(e) => store.setClipPlane({ position: Number(e.target.value) })}
                    />
                    <strong>{Math.round(clipPlane.position * 100)}%</strong>
                  </label>
                  <label className="popover-row popover-checkbox-row">
                    <input
                      type="checkbox"
                      checked={clipPlane.flipped}
                      onChange={(e) => store.setClipPlane({ flipped: e.target.checked })}
                    />
                    <span>Flip direction</span>
                  </label>
                </div>
              )}
            </div>
          );
        })}
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
