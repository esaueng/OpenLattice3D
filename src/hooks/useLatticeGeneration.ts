import { useCallback, useEffect, useRef, useState } from 'react';
import {
  trackDiagnostic,
  trackFailure,
  trackFailureCause,
  trackFeature,
  trackLatticeCells,
  trackUsage,
} from '../analytics';
import { latticeCellCount, modelExtents } from '../utils/model-summary';
import { workerFailure } from '../utils/failure-cause';
import { useStore } from '../store/useStore';
import type { WorkerMessage } from '../workers/lattice-worker';
import type { ValidationWorkerMessage } from '../workers/validation-worker';
import { requestNotificationPermission, sendNotification } from '../utils/notifications';
import {
  createBackendGeometryBuffers,
  formatBrowserFeatureFlags,
  getBrowserFeatureFlags,
  isSharedFloat32Array,
} from '../utils/browser-features';
import { isSheetType } from '../geometry/lattice';
import {
  GenerationWorkerController,
  type GenerationResultResponse,
  type GenerationWorkerLike,
} from './generation-worker-controller';
import { parseValidationResponse } from './validation-response';
import { sampleShapeMaxSpan } from '../geometry/sample-shapes';
import { buildGenerationSnapshot } from '../store/generation-snapshot';
import { selectGenerationInputs } from '../store/useResultStaleness';

function buildGenerationTransferList(msg: WorkerMessage): Transferable[] {
  const transfers: Transferable[] = [];
  // Imported mesh buffers are viewer-owned in the store. Only transfer backend-owned
  // copies created for this worker message, so the original mesh remains visible.
  if (msg.meshBufferKind === 'shared') return transfers;
  if (msg.meshPositions && isSharedFloat32Array(msg.meshPositions)) return transfers;
  if (msg.meshPositions) transfers.push(msg.meshPositions.buffer);
  if (msg.meshNormals) transfers.push(msg.meshNormals.buffer);
  return transfers;
}

function buildValidationTransferList(msg: ValidationWorkerMessage): Transferable[] {
  const transfers: Transferable[] = [
    msg.positions.buffer,
    msg.normals.buffer,
  ];
  if (msg.meshPositions) transfers.push(msg.meshPositions.buffer);
  if (msg.meshNormals) transfers.push(msg.meshNormals.buffer);
  if (msg.surfaceSamplePositions) transfers.push(msg.surfaceSamplePositions.buffer);
  if (msg.surfaceSampleNormals) transfers.push(msg.surfaceSampleNormals.buffer);
  if (msg.surfaceSampleHoleScales) transfers.push(msg.surfaceSampleHoleScales.buffer);
  return transfers;
}

export type LatticeGenerationControls = {
  startGeneration: () => void;
  cancelGeneration: () => void;
  canGenerate: () => boolean;
};

export function useLatticeGeneration(): LatticeGenerationControls {
  const [workerController] = useState(() => new GenerationWorkerController());
  const generationRunRef = useRef(0);
  const validationWorkerRef = useRef<Worker | null>(null);
  const modelSubscriptionRef = useRef<(() => void) | null>(null);

  const releaseModelSubscription = useCallback(() => {
    modelSubscriptionRef.current?.();
    modelSubscriptionRef.current = null;
  }, []);

  const stopRun = useCallback(() => {
    generationRunRef.current++;
    releaseModelSubscription();
    workerController.dispose();
    validationWorkerRef.current?.terminate();
    validationWorkerRef.current = null;
    if (useStore.getState().validationProgress !== null) useStore.getState().setValidationProgress(null);
  }, [releaseModelSubscription, workerController]);

  const canGenerate = useCallback(() => {
    const store = useStore.getState();
    return !store.generating && !store.demoModeActive && Boolean(store.originalMesh || store.sphereMode);
  }, []);

  const notifyGenerationComplete = useCallback(async (triCount: number, elapsedMs: number) => {
    const elapsedSec = Math.max(0, elapsedMs / 1000);
    const elapsedLabel = elapsedSec < 60
      ? `${elapsedSec.toFixed(1)}s`
      : `${Math.floor(elapsedSec / 60)}m ${(elapsedSec % 60).toFixed(0)}s`;
    await sendNotification('Lattice generation complete', {
      body: `${triCount.toLocaleString()} triangles generated in ${elapsedLabel}.`,
    });
  }, []);

  const startGeneration = useCallback(() => {
    const store = useStore.getState();
    if (!canGenerate()) return;
    stopRun();

    // Freeze the inputs now so the result can be compared with later edits.
    const snapshot = buildGenerationSnapshot(selectGenerationInputs(store));

    void requestNotificationPermission();
    store.setGenerating(true);
    store.setProgress(0, 'Starting...');
    store.setGenerationError(null);
    store.addLog('Starting lattice generation...');
    const browserFeatures = getBrowserFeatureFlags();
    const browserFeatureSummary = formatBrowserFeatureFlags(browserFeatures);
    store.addLog(`Browser features: ${browserFeatureSummary}`, browserFeatures.threadedWasmReady ? 'info' : 'warn');
    console.info('[OpenLattice3D] Browser features at generation start', browserFeatures);
    // The previous result and its verdict stay on screen (marked as running in the
    // statusbar) until the new mesh lands, so a cancelled run loses nothing.
    // Parameter, seed and mask edits made mid-run also keep it: the new mesh
    // lands with its own snapshot and simply reads as out of date.
    store.setDemoModeActive(false);

    const runId = generationRunRef.current;

    let worker: Worker;
    try {
      worker = new Worker(
        new URL('../workers/lattice-worker.ts', import.meta.url),
        { type: 'module' }
      );
    } catch (error) {
      const detail = error instanceof Error && error.message ? `: ${error.message}` : '';
      const message = `Could not create generation worker${detail}`;
      store.addLog(message, 'error');
      store.setGenerating(false);
      store.setDemoModeActive(false);
      store.setProgress(0, 'Generation failed');
      store.setGenerationError(message);
      trackUsage('generation_failed');
      trackDiagnostic('error_worker');
      return;
    }
    const generationStartedAt = performance.now();
    // Counted from the run's own inputs: unit cells across the model's bounding box.
    const cellEstimate = latticeCellCount(
      modelExtents(store.meshInfo, store.sampleShape, store.sphereRadius)?.size ?? null,
      store.params.cellSize,
    );
    const generationSeed = store.generationSeed;
    const resolution = Math.round(24 + store.params.exportResolution * 24);
    const maxSpan = store.meshInfo
      ? Math.max(
        store.meshInfo.boundingBox.max[0] - store.meshInfo.boundingBox.min[0],
        store.meshInfo.boundingBox.max[1] - store.meshInfo.boundingBox.min[1],
        store.meshInfo.boundingBox.max[2] - store.meshInfo.boundingBox.min[2],
      )
      : sampleShapeMaxSpan(store.sampleShape, store.sphereRadius);
    const voxelSize = maxSpan / resolution;
    if (isSheetType(store.params.latticeType) && store.params.wallThickness < voxelSize * 2) {
      store.addLog(
        `Requested ${store.params.wallThickness.toFixed(2)}mm wall is under two ${(voxelSize).toFixed(2)}mm sampling voxels; increase export resolution for reliable thickness.`,
        'warn',
      );
    }

    const msg: WorkerMessage = {
      type: 'generate',
      params: store.params,
      generationSeed,
      sphereMode: store.sphereMode,
      sphereRadius: store.sphereRadius,
      sampleShape: store.sampleShape,
      resolution,
      keepOutTris: Array.from(store.keepOutTris),
      keepInTris: Array.from(store.keepInTris),
    };

    if (store.originalMesh) {
      const geometryBuffers = createBackendGeometryBuffers(
        store.originalMesh.positions,
        store.originalMesh.normals,
        store.originalMesh.triCount,
        browserFeatures
      );
      msg.meshPositions = geometryBuffers.positions;
      msg.meshNormals = geometryBuffers.normals;
      msg.meshTriCount = geometryBuffers.triCount;
      msg.meshBufferKind = geometryBuffers.kind;
      store.addLog(`Mesh buffers: ${geometryBuffers.kind === 'shared' ? 'SharedArrayBuffer' : 'ArrayBuffer transfer'} path active`);
    }

    const transferList = buildGenerationTransferList(msg);

    const startValidation = (resp: GenerationResultResponse) => {
      if (generationRunRef.current !== runId) return;
      if (validationWorkerRef.current) {
        validationWorkerRef.current.terminate();
      }

      let validationWorker: Worker;
      try {
        validationWorker = new Worker(
          new URL('../workers/validation-worker.ts', import.meta.url),
          { type: 'module' }
        );
      } catch (error) {
        throw workerFailure(error instanceof Error ? error.message : 'Could not create validation worker');
      }
      validationWorkerRef.current = validationWorker;

      const validationMsg: ValidationWorkerMessage = {
        type: 'validate',
        // The worker ships an independent copy; copying 100 MB here stalled the UI.
        positions: resp.validationPositions ?? new Float32Array(resp.positions),
        normals: resp.validationNormals ?? new Float32Array(resp.normals),
        triCount: resp.triCount,
        params: store.params,
        generationSeed,
        sphereMode: store.sphereMode,
        sphereRadius: store.sphereRadius,
        sampleShape: store.sampleShape,
        keepOutTris: Array.from(store.keepOutTris),
        keepInTris: Array.from(store.keepInTris),
        thinFilterSkipped: resp.thinFilterSkipped,
        surfaceSamplePositions: resp.surfaceSamplePositions,
        surfaceSampleNormals: resp.surfaceSampleNormals,
        surfaceSampleHoleScales: resp.surfaceSampleHoleScales,
      };

      if (store.originalMesh) {
        validationMsg.meshPositions = new Float32Array(store.originalMesh.positions);
        validationMsg.meshNormals = new Float32Array(store.originalMesh.normals);
        validationMsg.meshTriCount = store.originalMesh.triCount;
      }

      const isCurrentValidation = () => (
        generationRunRef.current === runId && validationWorkerRef.current === validationWorker
      );
      const finishValidationWorker = () => {
        releaseModelSubscription();
        validationWorker.terminate();
        if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
      };
      // Every terminal failure clears the progress indicator; otherwise the
      // statusbar keeps reading "validating" for a worker that is gone.
      const failValidation = (message: string) => {
        const current = useStore.getState();
        finishValidationWorker();
        current.setValidationProgress(null);
        current.addLog(message, 'error');
      };

      validationWorker.onmessage = (event: MessageEvent<unknown>) => {
        if (!isCurrentValidation()) return;
        const validationResp = parseValidationResponse(event.data);
        if (!validationResp) {
          failValidation('Validation worker returned a malformed response');
          trackDiagnostic('error_worker');
          return;
        }
        const current = useStore.getState();
        if (validationResp.type === 'progress') {
          if (validationResp.message) current.addLog(validationResp.message);
          if (typeof validationResp.progress === 'number') current.setValidationProgress(validationResp.progress);
        } else if (validationResp.type === 'result') {
          finishValidationWorker();
          current.setValidation(validationResp.validation);
          current.addLog('Validation complete');
          trackFeature('measure');
        } else {
          failValidation(`Validation error: ${validationResp.message}`);
          trackFailureCause(validationResp.diagnostic);
        }
      };
      validationWorker.onerror = () => {
        if (!isCurrentValidation()) return;
        failValidation('Validation worker failed');
        trackDiagnostic('error_worker');
      };
      validationWorker.onmessageerror = () => {
        if (!isCurrentValidation()) return;
        failValidation('Validation worker returned an unreadable response');
        trackDiagnostic('error_worker');
      };

      useStore.getState().setValidationProgress(0);
      try {
        validationWorker.postMessage(validationMsg, buildValidationTransferList(validationMsg));
      } catch (error) {
        failValidation('Could not send data to the validation worker');
        trackDiagnostic('error_worker');
        trackFailure(null, error);
      }
    };

    workerController.start(worker as unknown as GenerationWorkerLike, {
      onProgress: (resp) => {
        const current = useStore.getState();
        current.setProgress(resp.progress, resp.message);
        if (resp.message && !resp.transient) current.addLog(resp.message);
        // A tile worker failed and generation fell back to one thread.
        trackFailureCause(resp.diagnostic);
      },
      onResult: (resp) => {
        const current = useStore.getState();
        if (resp.triCount === 0) {
          // A failed run leaves the previous result and its verdict in place.
          stopRun();
          const message = 'Generation produced an empty mesh; adjust the parameters and regenerate';
          current.setGenerating(false);
          current.setProgress(0, 'Generation failed');
          current.setGenerationError(message);
          current.addLog(message, 'error');
          trackUsage('generation_failed');
          return;
        }
        current.setResultMesh({
          positions: resp.positions,
          normals: resp.normals,
          triCount: resp.triCount,
          vertexNormals: resp.vertexNormals,
        }, snapshot);
        current.setGenerating(false);
        current.setProgress(1, 'Complete');
        current.setGenerationError(null);
        current.setDemoModeActive(false);
        current.addLog(`Generation complete (${resp.backend || 'cpu-single'}): ${resp.triCount} triangles`);
        try {
          startValidation(resp);
        } catch (error) {
          stopRun();
          const message = error instanceof Error ? error.message : 'Unknown error';
          current.addLog(`Could not start validation: ${message}`, 'error');
          trackFailure(null, error);
        }
        const elapsedMs = performance.now() - generationStartedAt;
        trackUsage('generation_completed');
        trackUsage('operation_latency', elapsedMs);
        trackFeature('create');
        if (cellEstimate !== null) trackLatticeCells(cellEstimate);
        void notifyGenerationComplete(resp.triCount, elapsedMs);
      },
      onFailure: (message, cause) => {
        releaseModelSubscription();
        const current = useStore.getState();
        current.addLog(message, 'error');
        current.setGenerating(false);
        current.setDemoModeActive(false);
        current.setProgress(0, 'Generation failed');
        current.setGenerationError(message);
        trackUsage('generation_failed');
        trackFailureCause(cause);
      },
    });

    // A run belongs to its model. Replacing the model (import, sample, reset,
    // project restore) cancels it so an old model's lattice cannot land under the
    // new one. Subscribe synchronously so even edits before the next React effect
    // are caught. Other inputs are free to change: the result stays and reads as
    // out of date.
    modelSubscriptionRef.current = useStore.subscribe((current) => {
      if (
        current.originalMesh === store.originalMesh
        && current.sampleShape === store.sampleShape
        && current.sphereMode === store.sphereMode
        && current.sphereRadius === store.sphereRadius
      ) return;
      stopRun();
      current.setGenerating(false);
      current.setProgress(0, 'Model changed; regenerate');
      current.setGenerationError(null);
      current.addLog('Generation cancelled because the model changed', 'warn');
    });

    workerController.post(msg, transferList);
  }, [canGenerate, notifyGenerationComplete, releaseModelSubscription, stopRun, workerController]);

  const cancelGeneration = useCallback(() => {
    stopRun();
    const store = useStore.getState();
    store.setGenerating(false);
    store.setDemoModeActive(false);
    store.setProgress(0, 'Cancelled');
    store.setGenerationError(null);
    store.addLog('Generation cancelled', 'warn');
  }, [stopRun]);

  useEffect(() => stopRun, [stopRun]);

  return { startGeneration, cancelGeneration, canGenerate };
}
