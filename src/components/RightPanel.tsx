// Inspection: validation verdict and part statistics for the current result
import { useStore } from '../store/useStore';
import { useMemo } from 'react';
import { massGrams, meshVolumeMm3, proceduralSolidVolumeMm3 } from '../geometry/mesh-stats';
import { boundedNumberInput } from '../utils/numeric-input';
import { useResultStaleness } from '../store/useResultStaleness';

function formatChangeList(changes: string[]): string {
  if (changes.length === 0) return 'settings';
  if (changes.length <= 3) return changes.join(', ');
  return `${changes.slice(0, 3).join(', ')} and ${changes.length - 3} more`;
}

export function RightPanel() {
  const validation = useStore((s) => s.validation);
  const resultMesh = useStore((s) => s.resultMesh);
  const originalMesh = useStore((s) => s.originalMesh);
  const meshInfo = useStore((s) => s.meshInfo);
  const sampleShape = useStore((s) => s.sampleShape);
  const sphereRadius = useStore((s) => s.sphereRadius);
  const density = useStore((s) => s.params.materialDensityGPerCm3);
  const updateParams = useStore((s) => s.updateParams);
  const staleness = useResultStaleness();
  const statistics = useMemo(() => {
    if (!resultMesh || !validation?.manifold.passed) return null;
    const resultVolume = meshVolumeMm3(resultMesh);
    const sourceVolume = sampleShape
      ? proceduralSolidVolumeMm3(sampleShape, sphereRadius)
      : originalMesh && meshInfo?.isWatertight
        ? meshVolumeMm3(originalMesh)
        : null;
    return {
      resultVolume,
      sourceVolume,
      relativeDensity: sourceVolume && sourceVolume > 0 ? resultVolume / sourceVolume : null,
    };
  }, [meshInfo?.isWatertight, originalMesh, resultMesh, sampleShape, sphereRadius, validation?.manifold.passed]);

  const staleBanner = staleness.stale && (
    <div className="warning stale-banner" role="status">
      Out of date: {formatChangeList(staleness.changes)} changed since this run. Regenerate to refresh.
    </div>
  );

  return (
    <>
      {/* Validation Panel */}
      {validation && (
        <section className="panel-section" id="validation-panel" tabIndex={-1}>
          <h3>Validation</h3>
          {staleBanner}
          <div className={`validation-status ${validation.passed ? 'pass' : 'fail'}`}>
            {validation.passed ? 'ALL CHECKS PASSED' : 'SOME CHECKS FAILED'}
          </div>

          <div className="validation-checks">
            <div className={`check ${validation.outerDeviation.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.outerDeviation.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Outer Deviation</strong>
                <div>
                  Max {validation.outerDeviation.maxDeviation.toFixed(3)} mm · limit {validation.outerDeviation.tolerance} mm
                </div>
              </div>
            </div>

            <div className={`check ${validation.minThickness.passed ? 'pass' : 'fail'}`}>
              <span className="check-icon">{validation.minThickness.passed ? 'OK' : 'FAIL'}</span>
              <div>
                <strong>Min Thickness</strong>
                {validation.minThickness.sampled > 0 ? (
                  <>
                    {/* The verdict is decided by the thinnest ray, so that number leads. */}
                    <div>
                      Thinnest feature {(validation.minThickness.absoluteMin ?? validation.minThickness.minMeasured).toFixed(3)} mm
                      {' '}· needs ≥ {validation.minThickness.required} mm
                    </div>
                    <div>
                      1% of samples are under {validation.minThickness.minMeasured.toFixed(3)} mm
                      {' '}({validation.minThickness.sampled.toLocaleString()} rays)
                    </div>
                  </>
                ) : (
                  <div>Not measured: no usable thickness samples · needs ≥ {validation.minThickness.required} mm</div>
                )}
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
                <div>
                  {validation.disconnected.fragmentCount} solid {validation.disconnected.fragmentCount === 1 ? 'body' : 'bodies'} · needs 1
                  {(validation.disconnected.voidCount ?? 0) > 0 && ` · ${validation.disconnected.voidCount} enclosed void${validation.disconnected.voidCount === 1 ? '' : 's'}`}
                  {(validation.disconnected.sliverCount ?? 0) > 0 && ` · ${validation.disconnected.sliverCount} negligible sliver${validation.disconnected.sliverCount === 1 ? '' : 's'}`}
                </div>
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
      {resultMesh && (
        <section className="panel-section">
          <h3>Part Statistics{staleness.stale ? ' (previous run)' : ''}</h3>
          {!validation && <div>Waiting for manifold validation…</div>}
          {validation && !validation.manifold.passed && (
            <div className="warning">Volume unavailable: result mesh is not closed and manifold.</div>
          )}
          {statistics && (
            <div className="info-block">
              <div><strong>Lattice volume:</strong> {statistics.resultVolume.toFixed(1)} mm³</div>
              {statistics.sourceVolume !== null && statistics.relativeDensity !== null && (
                <>
                  <div><strong>Solid volume:</strong> {statistics.sourceVolume.toFixed(1)} mm³</div>
                  <div><strong>Relative density:</strong> {(statistics.relativeDensity * 100).toFixed(1)}%</div>
                  <div><strong>Volume reduction:</strong> {((1 - statistics.relativeDensity) * 100).toFixed(1)}%</div>
                </>
              )}
              {density > 0 && (
                <div><strong>Estimated mass:</strong> {massGrams(statistics.resultVolume, density).toFixed(2)} g</div>
              )}
            </div>
          )}
          <div className="row">
            <label htmlFor="material-density">Density (g/cm³):</label>
            <input
              id="material-density"
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={density}
              title="Enter a material density to enable mass estimation; zero disables it."
              onChange={(event) => updateParams({
                materialDensityGPerCm3: boundedNumberInput(event.target.value, density, 0, 100),
              })}
            />
          </div>
        </section>
      )}
    </>
  );
}
