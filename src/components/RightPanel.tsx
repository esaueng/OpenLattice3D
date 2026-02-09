// Right Panel: Validation results, logs, export, view controls + clip plane
import { useStore } from '../store/useStore';
import { downloadSTL, downloadValidationReport, downloadProjectJSON } from '../utils/export';
import type { ViewMode, ClipAxis } from '../store/useStore';

const VIEW_LABELS: Record<ViewMode, string> = {
  original: 'Original',
  lattice: 'Solid',
  cross_section: 'Cross-Section',
  xray: 'X-Ray',
};

export function RightPanel() {
  const store = useStore();
  const {
    validation,
    resultMesh,
    params,
    viewMode,
    clipPlane,
    logs,
    meshFileName,
    keepOutTris,
    keepInTris,
    viewerBackground,
  } = store;

  return (
    <div className="panel right-panel">
      {/* View Controls */}
      <section>
        <h3>View</h3>
        <div className="view-buttons">
          {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => (
            <button
              key={mode}
              className={`btn btn-small ${viewMode === mode ? 'btn-active' : ''}`}
              onClick={() => store.setViewMode(mode)}
              disabled={
                (mode === 'lattice' && !resultMesh) ||
                (mode === 'cross_section' && !resultMesh) ||
                (mode === 'xray' && !resultMesh) ||
                (mode === 'original' && !store.originalMesh && !store.sphereMode)
              }
            >
              {VIEW_LABELS[mode]}
            </button>
          ))}
        </div>

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
            onChange={(e) => store.setViewerBackground(e.target.value)}
            aria-label="Viewer background color"
          />
          <button
            className="btn btn-tiny"
            onClick={() => store.setViewerBackground('#1a1a2e')}
            type="button"
          >
            Reset
          </button>
        </div>
      </section>

      {/* Validation Panel */}
      {validation && (
        <section>
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
        <section>
          <h3>Export</h3>
          <button
            className="btn btn-primary"
            onClick={() => downloadSTL(resultMesh, `${meshFileName.replace(/\.stl$/i, '')}-lattice.stl`)}
          >
            Export STL ({resultMesh.triCount.toLocaleString()} tris)
          </button>
          {validation && (
            <button
              className="btn btn-small"
              onClick={() => downloadValidationReport(validation, params, meshFileName)}
            >
              Export Validation Report
            </button>
          )}
          <button
            className="btn btn-small"
            onClick={() => downloadProjectJSON(params, meshFileName, keepOutTris, keepInTris, validation)}
          >
            Export Project JSON
          </button>
        </section>
      )}

      {/* Logs */}
      <section className="logs-section">
        <h3>
          Logs
          <button className="btn btn-tiny" onClick={store.clearLogs}>Clear</button>
        </h3>
        <div className="log-container">
          {logs.map((entry, i) => (
            <div key={i} className={`log-entry log-${entry.level}`}>
              <span className="log-time">
                {new Date(entry.time).toLocaleTimeString()}
              </span>
              {entry.message}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
