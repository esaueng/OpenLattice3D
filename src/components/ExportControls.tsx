import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { downloadProjectJSON, downloadSTL } from '../utils/export';

export function ExportControls() {
  const {
    validation,
    resultMesh,
    params,
    meshFileName,
    keepOutTris,
    keepInTris,
  } = useStore(useShallow((s) => ({
    validation: s.validation,
    resultMesh: s.resultMesh,
    params: s.params,
    meshFileName: s.meshFileName,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
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
          title="Export current parameters and metadata to a project JSON file."
          onClick={() => downloadProjectJSON(params, meshFileName, keepOutTris, keepInTris, validation)}
        >
          Export Project JSON
        </button>
      </div>
    </section>
  );
}
