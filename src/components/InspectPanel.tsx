// Right-hand column: what the last run produced and how to get it out.
import { useStore } from '../store/useStore';
import { RightPanel } from './RightPanel';
import { ExportControls } from './ExportControls';
import { PinnedRunPanel } from './PinnedRunPanel';

export function InspectPanel() {
  const hasModel = useStore((s) => Boolean(s.originalMesh || s.sphereMode));
  const resultMesh = useStore((s) => s.resultMesh);
  const generating = useStore((s) => s.generating);
  const demoModeActive = useStore((s) => s.demoModeActive);
  const validationProgress = useStore((s) => s.validationProgress);

  return (
    <div className="panel-content">
      <div className="panel-intro">
        <span className="panel-eyebrow">inspect</span>
        <h2>Result</h2>
        <p>
          {!hasModel
            ? 'Load a model to begin.'
            : demoModeActive
              ? 'Comparing lattice types. Close the comparison and generate to validate one.'
              : resultMesh && validationProgress !== null
                ? `Validating the new result… ${Math.round(validationProgress * 100)}%`
                : resultMesh
                  ? 'Checks, part statistics, and export for the current result.'
                : generating
                  ? 'Generating. Checks run as soon as the mesh lands.'
                  : 'Generate a lattice to run the manufacturability checks.'}
        </p>
      </div>
      <PinnedRunPanel />
      <RightPanel />
      <ExportControls />
    </div>
  );
}
