// Inspection controls: validation and export
import { useStore } from '../store/useStore';
import { downloadSTL, downloadValidationReport, downloadProjectJSON } from '../utils/export';

export function RightPanel() {
  const store = useStore();
  const {
    validation,
    resultMesh,
    params,
    meshFileName,
    keepOutTris,
    keepInTris,
  } = store;

  return (
    <>
      <div className="panel-intro">
        <span className="panel-eyebrow">context</span>
        <h2>Inspect and export</h2>
        <p>Review validation, explore views, and export outputs.</p>
      </div>
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
