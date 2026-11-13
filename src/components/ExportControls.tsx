import { useResultExport, type ResultExport } from '../hooks/useResultExport';
import { DownloadIcon } from './icons';

const SIMPLIFY_LEVELS = [
  { ratio: 1, label: 'Full detail' },
  { ratio: 0.75, label: 'Light (75%)' },
  { ratio: 0.5, label: 'Medium (50%)' },
  { ratio: 0.25, label: 'Heavy (25%)' },
  { ratio: 0.05, label: 'Maximum (tolerance-limited)' },
];

export function ExportControls() {
  return <ExportControlsView exporter={useResultExport()} />;
}

/** The Results footer's primary action: the default 3MF export, with the same caution wording. */
export function ExportPrimaryButton({ exporter }: { exporter: ResultExport }) {
  const { resultMesh, source, busy, busyFormat, caution, meshLabel, exportMesh } = exporter;
  if (!resultMesh || !source) return <span />;
  const label = busyFormat === '3MF' ? 'Working...' : meshLabel('3MF');
  return (
    <button
      type="button"
      className={`btn ${caution ? 'btn-caution' : 'btn-primary'} workflow-nav-next export-primary`}
      disabled={busy}
      aria-describedby={caution ? 'export-validation-note' : undefined}
      title={`${label}: a 3MF package with millimetre units and indexed vertices, at the detail chosen under Export.`}
      onClick={() => exportMesh('3MF')}
    >
      <span className="workflow-nav-label"><DownloadIcon size={14} /><span className="export-primary-text">{label}</span></span>
    </button>
  );
}

/**
 * The Export section. With footerPrimary the 3MF button steps down to a
 * secondary style because the footer carries the same action.
 */
export function ExportControlsView({ exporter, footerPrimary = false }: { exporter: ResultExport; footerPrimary?: boolean }) {
  const {
    source,
    resultMesh,
    generating,
    staleness,
    simplifyRatio,
    setSimplifyRatio,
    busyFormat,
    busy,
    meshParams,
    estimatedTriangles,
    checks,
    checksFailed,
    caution,
    meshLabel,
    exportMesh,
    saveProject,
  } = exporter;
  if (!source) return null;

  return (
    <section className="panel-block export-section" aria-label="Export">
      <div className="panel-block-header"><h3>Export</h3></div>
      {resultMesh && (
        <div className="row export-simplify">
          <label htmlFor="export-simplify">Detail</label>
          <select
            id="export-simplify"
            title={`Simplify exports without exceeding the ${meshParams.toleranceMm}mm deviation tolerance. The viewport remains full detail.`}
            value={simplifyRatio}
            onChange={(event) => setSimplifyRatio(Number(event.target.value))}
          >
            {SIMPLIFY_LEVELS.map((level) => (
              <option key={level.ratio} value={level.ratio}>{level.label}</option>
            ))}
          </select>
          <span
            className="export-estimate"
            title={simplifyRatio < 1
              ? `Target only; the ${meshParams.toleranceMm}mm deviation tolerance may retain more triangles.`
              : 'Full extracted detail.'}
          >
            ~{estimatedTriangles.toLocaleString()} tris
          </span>
        </div>
      )}
      {resultMesh && caution && (
        <div className="warning export-warning" id="export-validation-note" role="status">
          {checksFailed && `${checks.failedCount} of ${checks.totalCount} checks failed. `}
          {generating
            ? 'A new run is in progress; exports use the previous result.'
            : staleness.stale
              ? 'Settings changed since this result was generated; exports use the previous result.'
              : 'The exported mesh may not be printable.'}
        </div>
      )}
      <div className="export-controls-actions">
        {resultMesh && (
          <>
            <button
              className={`btn btn-small ${caution ? 'btn-caution' : footerPrimary ? '' : 'btn-primary'}`}
              disabled={busy}
              aria-describedby={caution ? 'export-validation-note' : undefined}
              title="Download a 3MF package with millimetre units and indexed vertices."
              onClick={() => exportMesh('3MF')}
            >
              {busyFormat === '3MF' ? 'Working...' : meshLabel('3MF')}
            </button>
            <button
              className={`btn btn-small ${caution ? 'btn-caution' : ''}`}
              disabled={busy}
              aria-describedby={caution ? 'export-validation-note' : undefined}
              title="Download as STL. This format does not declare its units."
              onClick={() => exportMesh('STL')}
            >
              {busyFormat === 'STL' ? 'Working...' : meshLabel('STL')}
            </button>
            <button
              className={`btn btn-small ${caution ? 'btn-caution' : ''}`}
              disabled={busy}
              aria-describedby={caution ? 'export-validation-note' : undefined}
              title="Download as Wavefront OBJ. Indexed, but the format does not declare its units."
              onClick={() => exportMesh('OBJ')}
            >
              {busyFormat === 'OBJ' ? 'Working...' : meshLabel('OBJ')}
            </button>
          </>
        )}
        <button
          className="btn btn-small"
          disabled={busy}
          title="Save the source model, current parameters, face constraints, and viewer settings to a project JSON file."
          onClick={saveProject}
        >
          Save Project JSON
        </button>
      </div>
    </section>
  );
}
