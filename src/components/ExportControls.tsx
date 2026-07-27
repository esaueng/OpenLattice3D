import { useStore } from '../store/useStore';
import { download3MF, downloadProjectJSON, downloadSTL, downloadValidationReport } from '../utils/export';

export function ExportControls() {
  const {
    validation,
    metrics,
    materialName,
    materialDensity,
    resultMesh,
    params,
    meshFileName,
    keepOutTris,
    keepInTris,
  } = useStore();

  if (!resultMesh) return null;

  return (
    <section className="export-controls-panel" aria-label="Export controls">
      <div className="export-controls-actions">
        <button
          className="btn btn-primary btn-small"
          title="Download as 3MF: indexed, carries millimetre units, and embeds the lattice parameters."
          onClick={() => void download3MF(
            resultMesh,
            {
              meshFileName,
              params,
              validation,
              metrics,
              material: { name: materialName, density: materialDensity },
            },
            `${meshFileName.replace(/\.stl$/i, '')}-lattice.3mf`
          )}
        >
          Export 3MF
        </button>
        <button
          className="btn btn-small"
          title="Download the generated lattice mesh as an STL file. Unitless; prefer 3MF where supported."
          onClick={() => downloadSTL(resultMesh, `${meshFileName.replace(/\.stl$/i, '')}-lattice.stl`)}
        >
          Export STL
        </button>
        <button
          className="btn btn-small"
          title="Export validation results and engineering metrics to a JSON report."
          disabled={!validation}
          onClick={() => validation && downloadValidationReport(
            validation,
            params,
            meshFileName,
            metrics,
            { name: materialName, density: materialDensity }
          )}
        >
          Export Report
        </button>
        <button
          className="btn btn-small"
          title="Export current parameters and metadata to a project JSON file."
          onClick={() => downloadProjectJSON(params, meshFileName, keepOutTris, keepInTris, validation)}
        >
          Export Project JSON
        </button>
      </div>
    </section>
  );
}
