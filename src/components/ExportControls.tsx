import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import {
  download3MF,
  downloadOBJ,
  downloadProjectJSON,
  downloadSTL,
} from '../utils/export';

const SIMPLIFY_LEVELS = [
  { ratio: 1, label: 'Full detail' },
  { ratio: 0.75, label: 'Light (75%)' },
  { ratio: 0.5, label: 'Medium (50%)' },
  { ratio: 0.25, label: 'Heavy (25%)' },
  { ratio: 0.05, label: 'Maximum (tolerance-limited)' },
];

export function ExportControls() {
  const {
    validation,
    resultMesh,
    params,
    meshFileName,
    keepOutTris,
    keepInTris,
    originalMesh,
    sampleShape,
    sphereRadius,
    clipPlane,
    viewerBackground,
  } = useStore(useShallow((s) => ({
    validation: s.validation,
    resultMesh: s.resultMesh,
    params: s.params,
    meshFileName: s.meshFileName,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
    originalMesh: s.originalMesh,
    sampleShape: s.sampleShape,
    sphereRadius: s.sphereRadius,
    clipPlane: s.clipPlane,
    viewerBackground: s.viewerBackground,
  })));
  const [simplifyRatio, setSimplifyRatio] = useState(1);
  const [busy, setBusy] = useState(false);

  if (!resultMesh) return null;

  const baseName = meshFileName.replace(/\.[^.]+$/i, '') || 'lattice';
  const meshOptions = {
    simplifyRatio,
    maxError: params.toleranceMm,
  };
  const estimatedTriangles = Math.round(resultMesh.triCount * simplifyRatio);
  const runExport = async (task: () => void) => {
    setBusy(true);
    try {
      // Paint the busy state before synchronous decimation starts.
      await new Promise((resolve) => setTimeout(resolve, 0));
      task();
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
          title={`Simplify exports without exceeding the ${params.toleranceMm}mm deviation tolerance. The viewport remains full detail.`}
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
            ? `Target only; the ${params.toleranceMm}mm deviation tolerance may retain more triangles.`
            : 'Full extracted detail.'}
        >
          ~{estimatedTriangles.toLocaleString()} triangles
        </span>
      </div>
      <div className="export-controls-actions">
        <button
          className="btn btn-primary btn-small"
          disabled={busy}
          title="Download a 3MF package with millimetre units and indexed vertices."
          onClick={() => void runExport(() => download3MF(
            resultMesh,
            `${baseName}-lattice.3mf`,
            meshOptions,
          ))}
        >
          {busy ? 'Working...' : 'Export 3MF'}
        </button>
        <button
          className="btn btn-small"
          disabled={busy}
          title="Download as STL. This format does not declare its units."
          onClick={() => void runExport(() => downloadSTL(
            resultMesh,
            `${baseName}-lattice.stl`,
            meshOptions,
          ))}
        >
          Export STL
        </button>
        <button
          className="btn btn-small"
          disabled={busy}
          title="Download as Wavefront OBJ. Indexed, but the format does not declare its units."
          onClick={() => void runExport(() => downloadOBJ(
            resultMesh,
            { meshFileName, params },
            `${baseName}-lattice.obj`,
            meshOptions,
          ))}
        >
          Export OBJ
        </button>
        <button
          className="btn btn-small"
          disabled={busy}
          title="Export current parameters and metadata to a project JSON file."
          onClick={() => {
            const source = originalMesh
              ? { kind: 'mesh' as const, fileName: meshFileName, mesh: originalMesh }
              : sampleShape
                ? { kind: 'sample' as const, fileName: meshFileName, shape: sampleShape, sphereRadius }
                : null;
            if (!source) return;
            downloadProjectJSON({
              params,
              source,
              keepOutTris,
              keepInTris,
              validation,
              clipPlane,
              viewerBackground,
            });
          }}
        >
          Export Project JSON
        </button>
      </div>
    </section>
  );
}
