import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store/useStore';
import type { WorkerMessage } from '../workers/lattice-worker';
import type { ValidationWorkerMessage, ValidationWorkerResponse } from '../workers/validation-worker';
import { requestNotificationPermission, sendNotification } from '../utils/notifications';
import {
  createBackendGeometryBuffers,
  formatBrowserFeatureFlags,
  getBrowserFeatureFlags,
  isSharedFloat32Array,
} from '../utils/browser-features';
import { isSheetType } from '../geometry/lattice';
import type { SampleShape } from '../types/project';
import {
  GenerationWorkerController,
  type GenerationResultResponse,
  type GenerationWorkerLike,
} from './generation-worker-controller';

function proceduralMaxSpan(shape: SampleShape | null, sphereRadius: number): number {
  switch (shape) {
    case 'sphere': return (sphereRadius || 25) * 2;
    case 'cube': return 30;
    case 'cylinder': return 40;
    case 'torus': return 56;
    case 'capsule': return 54;
    default: return (sphereRadius || 25) * 2;
  }
}

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
  const inputSubscriptionRef = useRef<(() => void) | null>(null);

  const releaseInputSubscription = useCallback(() => {
    inputSubscriptionRef.current?.();
    inputSubscriptionRef.current = null;
  }, []);

  const stopRun = useCallback(() => {
    generationRunRef.current++;
    releaseInputSubscription();
    workerController.dispose();
    validationWorkerRef.current?.terminate();
    validationWorkerRef.current = null;
  }, [releaseInputSubscription, workerController]);

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

    void requestNotificationPermission();
    store.setGenerating(true);
    store.setProgress(0, 'Starting...');
    store.setGenerationError(null);
    store.addLog('Starting lattice generation...');
    const browserFeatures = getBrowserFeatureFlags();
    const browserFeatureSummary = formatBrowserFeatureFlags(browserFeatures);
    store.addLog(`Browser features: ${browserFeatureSummary}`, browserFeatures.threadedWasmReady ? 'info' : 'warn');
    console.info('[OpenLattice3D] Browser features at generation start', browserFeatures);
    // Clear previous result without changing viewMode - view is preserved for regeneration.
    store.setValidation(null);
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
      return;
    }
    const generationStartedAt = performance.now();
    const generationSeed = store.generationSeed;
    const resolution = Math.round(24 + store.params.exportResolution * 24);
    const maxSpan = store.meshInfo
      ? Math.max(
        store.meshInfo.boundingBox.max[0] - store.meshInfo.boundingBox.min[0],
        store.meshInfo.boundingBox.max[1] - store.meshInfo.boundingBox.min[1],
        store.meshInfo.boundingBox.max[2] - store.meshInfo.boundingBox.min[2],
      )
      : proceduralMaxSpan(store.sampleShape, store.sphereRadius);
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

      const validationWorker = new Worker(
        new URL('../workers/validation-worker.ts', import.meta.url),
        { type: 'module' }
      );
      validationWorkerRef.current = validationWorker;

      const validationMsg: ValidationWorkerMessage = {
        type: 'validate',
        positions: new Float32Array(resp.positions),
        normals: new Float32Array(resp.normals),
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

      validationWorker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
        if (generationRunRef.current !== runId || validationWorkerRef.current !== validationWorker) return;
        const current = useStore.getState();
        const validationResp = event.data;
        if (validationResp.type === 'progress') {
          if (validationResp.message) current.addLog(validationResp.message);
        } else if (validationResp.type === 'result') {
          releaseInputSubscription();
          current.setValidation(validationResp.validation || null);
          current.addLog('Validation complete');
          validationWorker.terminate();
          if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
        } else if (validationResp.type === 'error') {
          releaseInputSubscription();
          current.addLog(`Validation error: ${validationResp.message}`, 'error');
          validationWorker.terminate();
          if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
        }
      };
      validationWorker.onerror = () => {
        if (generationRunRef.current !== runId || validationWorkerRef.current !== validationWorker) return;
        const current = useStore.getState();
        releaseInputSubscription();
        current.addLog('Validation worker failed', 'error');
        validationWorker.terminate();
        if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
      };
      validationWorker.onmessageerror = () => {
        if (generationRunRef.current !== runId || validationWorkerRef.current !== validationWorker) return;
        const current = useStore.getState();
        releaseInputSubscription();
        current.addLog('Validation worker returned an unreadable response', 'error');
        validationWorker.terminate();
        validationWorkerRef.current = null;
      };

      validationWorker.postMessage(validationMsg, buildValidationTransferList(validationMsg));
    };

    workerController.start(worker as unknown as GenerationWorkerLike, {
      onProgress: (resp) => {
        const current = useStore.getState();
        current.setProgress(resp.progress, resp.message);
        if (resp.message && !resp.transient) current.addLog(resp.message);
      },
      onResult: (resp) => {
        const current = useStore.getState();
        if (resp.triCount === 0) {
          stopRun();
          const message = 'Generation produced an empty mesh; adjust the parameters and regenerate';
          current.setGenerating(false);
          current.setResultMesh(null);
          current.setValidation(null);
          current.setProgress(0, 'Generation failed');
          current.setGenerationError(message);
          current.addLog(message, 'error');
          return;
        }
        current.setResultMesh({
          positions: resp.positions,
          normals: resp.normals,
          triCount: resp.triCount,
        });
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
        }
        const elapsedMs = performance.now() - generationStartedAt;
        void notifyGenerationComplete(resp.triCount, elapsedMs);
      },
      onFailure: (message) => {
        releaseInputSubscription();
        const current = useStore.getState();
        current.addLog(message, 'error');
        current.setGenerating(false);
        current.setDemoModeActive(false);
        current.setProgress(0, 'Generation failed');
        current.setGenerationError(message);
      },
    });

    // Subscribe synchronously so even edits before the next React effect invalidate
    // this run. Display preferences and mass density do not change its geometry.
    inputSubscriptionRef.current = useStore.subscribe((current) => {
      const paramsChanged = (Object.keys(store.params) as (keyof typeof store.params)[])
        .some((key) => key !== 'materialDensityGPerCm3' && current.params[key] !== store.params[key]);
      if (
        current.originalMesh === store.originalMesh
        && current.sampleShape === store.sampleShape
        && current.sphereMode === store.sphereMode
        && current.sphereRadius === store.sphereRadius
        && current.generationSeed === store.generationSeed
        && current.keepOutTris === store.keepOutTris
        && current.keepInTris === store.keepInTris
        && !paramsChanged
      ) return;
      stopRun();
      current.setGenerating(false);
      current.setResultMesh(null);
      current.setValidation(null);
      current.setProgress(0, 'Inputs changed; regenerate');
      current.setGenerationError(null);
      current.addLog('Generation or validation cancelled because inputs changed', 'warn');
    });

    workerController.post(msg, transferList);
  }, [canGenerate, notifyGenerationComplete, releaseInputSubscription, stopRun, workerController]);

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
