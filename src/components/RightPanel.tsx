// Inspection controls: validation and export
import { useStore } from '../store/useStore';

export function RightPanel() {
  const validation = useStore((s) => s.validation);

  return (
    <>
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
    </>
  );
}
