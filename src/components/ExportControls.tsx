import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { download3MF, downloadProjectJSON, downloadSTL } from '../utils/export';

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

  if (!resultMesh) return null;

  return (
    <section className="export-controls-panel" aria-label="Export controls">
      <div className="export-controls-actions">
        <button
          className="btn btn-primary btn-small"
          title="Download the generated lattice mesh as an STL file."
          onClick={() => downloadSTL(resultMesh, `${meshFileName.replace(/\.stl$/i, '')}-lattice.stl`)}
        >
          Export STL
        </button>
        <button
          className="btn btn-small"
          title="Download a 3MF package with millimetre units and indexed vertices."
          onClick={() => download3MF(resultMesh, `${meshFileName.replace(/\.[^.]+$/i, '')}-lattice.3mf`)}
        >
          Export 3MF
        </button>
        <button
          className="btn btn-small"
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
