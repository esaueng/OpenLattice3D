// Inspection controls: validation, export, view controls + clip plane
import { useStore } from '../store/useStore';
import { downloadSTL, downloadValidationReport, downloadProjectJSON } from '../utils/export';
import type { ViewMode, ClipAxis } from '../store/useStore';

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

export function RightPanel() {
  const store = useStore();
  const {
    validation,
    resultMesh,
    params,
    viewMode,
    clipPlane,
    meshFileName,
    keepOutTris,
    keepInTris,
    viewerBackground,
    demoModeActive,
  } = store;

  return (
    <>
      <div className="panel-intro">
        <span className="panel-eyebrow">context</span>
        <h2>Inspect and export</h2>
        <p>Review validation, explore views, and export outputs.</p>
      </div>
      {/* View Controls */}
      <section className="panel-section">
        <h3>View</h3>
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

        {/* Clip plane controls – only shown in cross-section mode */}
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

        {/* Hint when in xray mode */}
        {viewMode === 'xray' && (
          <div className="info-text" style={{ marginTop: 6 }}>
            Shell rendered transparent. Orbit to see internal lattice structure.
          </div>
        )}

        <div className="row" style={{ marginTop: 8 }}>
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

      {/* Validation Panel */}
      {validation && (
        <section className="panel-section">
          <h3>Validation</h3>
          <div className={`validation-status ${validation.passed ? 'pass' : 'fail'}`}>
            {validation.passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}
          </div>

          <div className="validation-checks">
            <div className={`check ${validation.outerDeviation.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.outerDeviation.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Outer Deviation</strong>
                <div>Max: {validation.outerDeviation.maxDeviation.toFixed(3)}mm (tolerance: {validation.outerDeviation.tolerance}mm)</div>
              </div>
            </div>

            <div className={`check ${validation.minThickness.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.minThickness.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Min Thickness</strong>
                <div>Measured: {validation.minThickness.minMeasured.toFixed(3)}mm (required: {validation.minThickness.required}mm)</div>
              </div>
            </div>

            <div className={`check ${validation.manifold.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.manifold.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Manifold/Watertight</strong>
                <div>{validation.manifold.details}</div>
              </div>
            </div>

            <div className={`check ${validation.disconnected.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.disconnected.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Connectivity</strong>
                <div>{validation.disconnected.fragmentCount} fragment(s)</div>
              </div>
            </div>
          </div>

          {validation.warnings.length > 0 && (
            <div className="warnings">
              <strong>Warnings:</strong>
              {validation.warnings.map((w, i) => (
                <div key={i} className="warning">{w}</div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Export */}
      {resultMesh && (
        <section className="panel-section">
          <h3>Export</h3>
          <button
            className="btn btn-primary"
            title="Download the generated lattice mesh as an STL file."
            onClick={() => downloadSTL(resultMesh, `${meshFileName.replace(/\.stl$/i, '')}-lattice.stl`)}
          >
            Export STL ({resultMesh.triCount.toLocaleString()} tris)
          </button>
          {validation && (
            <button
              className="btn btn-small"
              title="Download a text report of validation checks and outcomes."
              onClick={() => downloadValidationReport(validation, params, meshFileName)}
            >
              Export Validation Report
            </button>
          )}
          <button
            className="btn btn-small"
            title="Export current parameters and metadata to a project JSON file."
            onClick={() => downloadProjectJSON(params, meshFileName, keepOutTris, keepInTris, validation)}
          >
            Export Project JSON
          </button>
        </section>
      )}

    </>
  );
}
