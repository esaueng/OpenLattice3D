import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { trackUsage } from '../analytics';
import { useStore } from '../store/useStore';
import { useResultStaleness } from '../store/useResultStaleness';
import { summarizeValidation } from '../utils/validation-summary';
import {
  download3MF,
  downloadOBJ,
  downloadProjectJSON,
  downloadSTL,
} from '../utils/export';

export type MeshFormat = '3MF' | 'STL' | 'OBJ';

/**
 * Export state shared by the Export section and the Results footer button, so
 * both use the same detail level, busy state and caution wording.
 */
export function useResultExport() {
  const {
    validation,
    resultMesh,
    resultSnapshot,
    params,
    meshFileName,
    keepOutTris,
    keepInTris,
    originalMesh,
    sampleShape,
    sphereRadius,
    clipPlane,
    viewerBackground,
    generationSeed,
    generating,
  } = useStore(useShallow((s) => ({
    validation: s.validation,
    resultMesh: s.resultMesh,
    resultSnapshot: s.resultSnapshot,
    params: s.params,
    meshFileName: s.meshFileName,
    keepOutTris: s.keepOutTris,
    keepInTris: s.keepInTris,
    originalMesh: s.originalMesh,
    sampleShape: s.sampleShape,
    sphereRadius: s.sphereRadius,
    clipPlane: s.clipPlane,
    viewerBackground: s.viewerBackground,
    generationSeed: s.generationSeed,
    generating: s.generating,
  })));
  const staleness = useResultStaleness();
  const [simplifyRatio, setSimplifyRatio] = useState(1);
  const [busyFormat, setBusyFormat] = useState<MeshFormat | null>(null);
  const busy = busyFormat !== null;
  const meshParams = resultSnapshot?.params ?? params;
  const meshSeed = resultSnapshot?.generationSeed ?? generationSeed;

  const source = originalMesh
    ? { kind: 'mesh' as const, fileName: meshFileName, mesh: originalMesh }
    : sampleShape
      ? { kind: 'sample' as const, fileName: meshFileName, shape: sampleShape, sphereRadius }
      : null;
  const baseName = meshFileName.replace(/\.[^.]+$/i, '') || 'lattice';
  const meshOptions = {
    simplifyRatio,
    maxError: meshParams.toleranceMm,
    generationSeed: meshSeed,
  };
  const estimatedTriangles = resultMesh ? Math.round(resultMesh.triCount * simplifyRatio) : 0;
  // Never blocks the export -- wanting the mesh anyway is legitimate -- but the
  // risk must not be silent on a print-preparation tool.
  const checks = summarizeValidation(validation, Boolean(resultMesh), false, staleness.stale);
  const checksFailed = checks.tone === 'fail' || (checks.tone === 'stale' && checks.failedCount > 0);
  const previousResult = staleness.stale || generating;
  const caution = checksFailed || previousResult;
  const meshLabel = (format: string) => (
    checksFailed ? `Export ${format} anyway` : previousResult ? `Export previous ${format}` : `Export ${format}`
  );
  const saveProject = () => {
    if (!source) return;
    const started = performance.now();
    try {
      downloadProjectJSON({ params, generationSeed, source, keepOutTris, keepInTris, validation, clipPlane, viewerBackground });
      trackUsage('export_completed');
      trackUsage('operation_latency', performance.now() - started);
    } catch {
      trackUsage('export_failed');
      useStore.getState().addLog('Project export failed. Try again or free browser memory.', 'error');
    }
  };
  const runExport = async (format: MeshFormat, task: () => void) => {
    setBusyFormat(format);
    const started = performance.now();
    try {
      // Paint the busy state before synchronous decimation starts.
      await new Promise((resolve) => setTimeout(resolve, 0));
      task();
      trackUsage('export_completed');
      trackUsage('operation_latency', performance.now() - started);
    } catch {
      trackUsage('export_failed');
      // Event handlers have no caller to catch a rejected promise.
      useStore.getState().addLog('Mesh export failed; try a lower detail setting.', 'error');
    } finally {
      setBusyFormat(null);
    }
  };
  const exportMesh = (format: MeshFormat) => {
    if (!resultMesh) return;
    if (format === '3MF') {
      void runExport('3MF', () => download3MF(resultMesh, `${baseName}-lattice.3mf`, meshOptions));
    } else if (format === 'STL') {
      void runExport('STL', () => downloadSTL(resultMesh, `${baseName}-lattice.stl`, meshOptions));
    } else {
      void runExport('OBJ', () => downloadOBJ(
        resultMesh,
        { meshFileName, params: meshParams },
        `${baseName}-lattice.obj`,
        meshOptions,
      ));
    }
  };

  return {
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
  };
}

export type ResultExport = ReturnType<typeof useResultExport>;
