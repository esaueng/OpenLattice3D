import { useState } from 'react';
import { useStore } from '../store/useStore';
import {
  download3MF,
  downloadOBJ,
  downloadProjectJSON,
  downloadSTL,
  downloadValidationReport,
} from '../utils/export';

const SIMPLIFY_LEVELS = [
  { ratio: 1, label: 'Full detail' },
  { ratio: 0.75, label: 'Light (75%)' },
  { ratio: 0.5, label: 'Medium (50%)' },
  { ratio: 0.25, label: 'Heavy (25%)' },
  // Deliberately not labelled with a percentage: the deviation tolerance stops
  // the collapse before this target is reached on most lattices, so promising a
  // number here would be promising something the tolerance forbids.
  { ratio: 0.05, label: 'Maximum (tolerance-limited)' },
];

// Bytes per triangle, measured on real exports rather than guessed. STL is
// exact by construction; 3MF is compressed so its figure is an average.
const BYTES_PER_TRIANGLE = { stl: 50, threeMf: 8.9, obj: 35 };

function formatSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

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
  const [simplifyRatio, setSimplifyRatio] = useState(1);
  const [busy, setBusy] = useState(false);

  if (!resultMesh) return null;

  const baseName = meshFileName.replace(/\.stl$/i, '') || 'lattice';
  const meshOptions = { simplifyRatio, maxError: params.toleranceMm };
  const estimatedTriangles = Math.round(resultMesh.triCount * simplifyRatio);

  // Simplification is synchronous and can take a few seconds on a large mesh,
  // so the button reports that rather than appearing to have done nothing.
  const runExport = async (task: () => void | Promise<void>) => {
    setBusy(true);
    try {
      // Yield once so the busy state paints before the main thread blocks.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await task();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="export-controls-panel" aria-label="Export controls">
      <div className="export-simplify">
        <label htmlFor="export-simplify">Detail:</label>
        <select
          id="export-simplify"
          title={`Collapse triangles that contribute least to the shape, without exceeding the ${params.toleranceMm}mm deviation tolerance. Applies to exported files only; the viewport keeps full detail.`}
          value={simplifyRatio}
          onChange={(e) => setSimplifyRatio(Number(e.target.value))}
        >
          {SIMPLIFY_LEVELS.map((level) => (
            <option key={level.ratio} value={level.ratio}>{level.label}</option>
          ))}
        </select>
        <span
          className="export-estimate"
          title={simplifyRatio < 1
            ? `Target only. Collapses that would move the surface more than ${params.toleranceMm}mm are refused, so the export may keep more triangles than this.`
            : 'Exported at full extracted detail.'}
        >
          {simplifyRatio < 1 ? 'target ' : ''}
          ~{estimatedTriangles.toLocaleString()} tris
          {' · '}3MF {formatSize(estimatedTriangles * BYTES_PER_TRIANGLE.threeMf)}
          {' · '}STL {formatSize(estimatedTriangles * BYTES_PER_TRIANGLE.stl)}
        </span>
      </div>

      <div className="export-controls-actions">
        <button
          className="btn btn-primary btn-small"
          disabled={busy}
          title="Download as 3MF: indexed, carries millimetre units, and embeds the lattice parameters."
          onClick={() => void runExport(() => download3MF(
            resultMesh,
            {
              meshFileName,
              params,
              validation,
              metrics,
              material: { name: materialName, density: materialDensity },
            },
            meshOptions,
            `${baseName}-lattice.3mf`
          ))}
        >
          {busy ? 'Working...' : 'Export 3MF'}
        </button>
        <button
          className="btn btn-small"
          disabled={busy}
          title="Download as STL. Unitless; prefer 3MF where supported."
          onClick={() => void runExport(() => downloadSTL(
            resultMesh,
            `${baseName}-lattice.stl`,
            meshOptions
          ))}
        >
          Export STL
        </button>
        <button
          className="btn btn-small"
          disabled={busy}
          title="Download as Wavefront OBJ. Indexed and readable, but carries no unit."
          onClick={() => void runExport(() => downloadOBJ(
            resultMesh,
            { meshFileName, params },
            meshOptions,
            `${baseName}-lattice.obj`
          ))}
        >
          Export OBJ
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
