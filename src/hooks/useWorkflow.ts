import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore } from '../store/useStore';
import { useResultStaleness } from '../store/useResultStaleness';
import { modelExtents } from '../utils/model-summary';
import { buildPreflight } from '../utils/preflight';
import type { WorkflowInputs } from '../components/workflow';

export function useWorkflowInputs(): WorkflowInputs {
  const staleness = useResultStaleness();
  const s = useStore(useShallow((state) => ({
    originalMesh: state.originalMesh,
    sphereMode: state.sphereMode,
    demoModeActive: state.demoModeActive,
    resultMesh: state.resultMesh,
    validation: state.validation,
    keepOutCount: state.keepOutTris.size,
    keepInCount: state.keepInTris.size,
    params: state.params,
    meshInfo: state.meshInfo,
    sampleShape: state.sampleShape,
    sphereRadius: state.sphereRadius,
  })));
  const hasModel = Boolean(s.originalMesh || s.sphereMode);
  const preflightBlocked = useMemo(() => {
    if (!hasModel) return false;
    const extents = modelExtents(s.meshInfo, s.sampleShape, s.sphereRadius);
    return buildPreflight(s.params, extents, s.meshInfo).warnings.some((warning) => warning.level === 'block');
  }, [hasModel, s.meshInfo, s.params, s.sampleShape, s.sphereRadius]);

  return {
    hasModel,
    hasImportedMesh: Boolean(s.originalMesh),
    demoModeActive: s.demoModeActive,
    hasResult: Boolean(s.resultMesh),
    resultStale: staleness.stale,
    validationPassed: s.resultMesh && s.validation ? s.validation.passed : null,
    paintedFaces: s.keepOutCount + s.keepInCount,
    preflightBlocked,
  };
}
