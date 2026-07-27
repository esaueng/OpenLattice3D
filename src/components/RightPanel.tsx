// Inspection controls: metrics, validation and export
import { useStore } from '../store/useStore';
import { MATERIAL_PRESETS } from '../types/project';
import { massGrams } from '../geometry/metrics';

function formatVolume(mm3: number): string {
  if (mm3 >= 1000) return `${(mm3 / 1000).toFixed(2)} cm3`;
  return `${mm3.toFixed(1)} mm3`;
}

function formatMass(grams: number): string {
  if (grams >= 1000) return `${(grams / 1000).toFixed(3)} kg`;
  return `${grams.toFixed(2)} g`;
}

export function RightPanel() {
  const store = useStore();
  const { validation, metrics, materialName, materialDensity } = store;

  const latticeMass = metrics ? massGrams(metrics.latticeVolume, materialDensity) : 0;
  const solidMass = metrics ? massGrams(metrics.envelopeVolume, materialDensity) : 0;
  const savedPct = metrics && metrics.envelopeVolume > 0
    ? (1 - metrics.relativeDensity) * 100
    : 0;

  return (
    <>
      {/* Metrics */}
      {metrics && (
        <section className="panel-section">
          <h3>Metrics</h3>

          <div className="row">
            <label>Material:</label>
            <select
              title="Bulk material density, used to convert lattice volume into a printed mass."
              value={materialName}
              onChange={(e) => {
                const preset = MATERIAL_PRESETS.find((m) => m.name === e.target.value);
                if (preset) store.setMaterial(preset.name, preset.density);
                else store.setMaterial('Custom', materialDensity);
              }}
            >
              {MATERIAL_PRESETS.map((m) => (
                <option key={m.name} value={m.name}>{m.name} ({m.density} g/cm3)</option>
              ))}
              <option value="Custom">Custom</option>
            </select>
          </div>

          {materialName === 'Custom' && (
            <div className="row">
              <label>Density (g/cm3):</label>
              <input
                type="number"
                title="Bulk density of the printed material."
                value={materialDensity}
                min={0.01} max={25} step={0.01}
                onChange={(e) => store.setMaterial('Custom', parseFloat(e.target.value) || 1)}
              />
            </div>
          )}

          <div className="metric-headline">
            <span className="metric-headline-value">{savedPct.toFixed(1)}%</span>
            <span className="metric-headline-label">lighter than solid</span>
          </div>

          <div className="metric-grid">
            <div className="metric-row">
              <span>Lattice mass</span>
              <strong>{formatMass(latticeMass)}</strong>
            </div>
            <div className="metric-row metric-row-muted">
              <span>Solid mass</span>
              <strong>{formatMass(solidMass)}</strong>
            </div>
            <div className="metric-row">
              <span>Relative density</span>
              <strong>{(metrics.relativeDensity * 100).toFixed(1)}%</strong>
            </div>
            <div className="metric-row">
              <span>Lattice volume</span>
              <strong>{formatVolume(metrics.latticeVolume)}</strong>
            </div>
            <div className="metric-row metric-row-muted">
              <span>Envelope volume</span>
              <strong>{formatVolume(metrics.envelopeVolume)}</strong>
            </div>
            <div
              className="metric-row"
              title="Measured from the extracted mesh, so it rises with export resolution."
            >
              <span>Surface area</span>
              <strong>{(metrics.surfaceArea / 100).toFixed(2)} cm2</strong>
            </div>
          </div>

          <div className="metric-note">
            Volume estimated from {metrics.volumeSamplesPerAxis}&sup3; field samples; envelope volume is exact.
          </div>
        </section>
      )}

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
