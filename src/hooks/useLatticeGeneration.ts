import { useCallback, useEffect, useRef } from 'react';
import { useStore } from '../store/useStore';
import type { WorkerMessage, WorkerResponse } from '../workers/lattice-worker';
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
  const workerRef = useRef<Worker | null>(null);
  const validationWorkerRef = useRef<Worker | null>(null);

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

    void requestNotificationPermission();
    store.setGenerating(true);
    store.setProgress(0, 'Starting...');
    store.addLog('Starting lattice generation...');
    const browserFeatures = getBrowserFeatureFlags();
    const browserFeatureSummary = formatBrowserFeatureFlags(browserFeatures);
    store.addLog(`Browser features: ${browserFeatureSummary}`, browserFeatures.threadedWasmReady ? 'info' : 'warn');
    console.info('[OpenLattice3D] Browser features at generation start', browserFeatures);
    // Clear previous result without changing viewMode - view is preserved for regeneration.
    store.setValidation(null);
    store.setDemoModeActive(false);

    if (workerRef.current) {
      workerRef.current.terminate();
    }
    if (validationWorkerRef.current) {
      validationWorkerRef.current.terminate();
      validationWorkerRef.current = null;
    }

    const worker = new Worker(
      new URL('../workers/lattice-worker.ts', import.meta.url),
      { type: 'module' }
    );
    workerRef.current = worker;

    const generationStartedAt = performance.now();
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

    const startValidation = (resp: WorkerResponse) => {
      if (!resp.positions || !resp.normals || resp.triCount === undefined) return;
      const latest = useStore.getState();
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
        params: latest.params,
        sphereMode: latest.sphereMode,
        sphereRadius: latest.sphereRadius,
        sampleShape: latest.sampleShape,
        keepOutTris: Array.from(latest.keepOutTris),
        keepInTris: Array.from(latest.keepInTris),
        thinFilterSkipped: resp.thinFilterSkipped,
        surfaceSamplePositions: resp.surfaceSamplePositions,
        surfaceSampleNormals: resp.surfaceSampleNormals,
        surfaceSampleHoleScales: resp.surfaceSampleHoleScales,
      };

      if (latest.originalMesh) {
        validationMsg.meshPositions = new Float32Array(latest.originalMesh.positions);
        validationMsg.meshNormals = new Float32Array(latest.originalMesh.normals);
        validationMsg.meshTriCount = latest.originalMesh.triCount;
      }

      validationWorker.onmessage = (event: MessageEvent<ValidationWorkerResponse>) => {
        const current = useStore.getState();
        const validationResp = event.data;
        if (validationResp.type === 'progress') {
          if (validationResp.message) current.addLog(validationResp.message);
        } else if (validationResp.type === 'result') {
          current.setValidation(validationResp.validation || null);
          current.addLog('Validation complete');
          validationWorker.terminate();
          if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
        } else if (validationResp.type === 'error') {
          current.addLog(`Validation error: ${validationResp.message}`, 'error');
          validationWorker.terminate();
          if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
        }
      };
      validationWorker.onerror = () => {
        const current = useStore.getState();
        current.addLog('Validation worker failed', 'error');
        validationWorker.terminate();
        if (validationWorkerRef.current === validationWorker) validationWorkerRef.current = null;
      };

      validationWorker.postMessage(validationMsg, buildValidationTransferList(validationMsg));
    };

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const current = useStore.getState();
      const resp = e.data;
      if (resp.type === 'progress') {
        current.setProgress(resp.progress || 0, resp.message || '');
        if (resp.message) current.addLog(resp.message);
      } else if (resp.type === 'result') {
        current.setResultMesh({
          positions: resp.positions!,
          normals: resp.normals!,
          triCount: resp.triCount!,
        });
        current.setGenerating(false);
        current.setProgress(1, 'Complete');
        current.setDemoModeActive(false);
        current.addLog(`Generation complete (${resp.backend || 'cpu-single'}): ${resp.triCount} triangles`);
        startValidation(resp);
        const elapsedMs = performance.now() - generationStartedAt;
        void notifyGenerationComplete(resp.triCount || 0, elapsedMs);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      } else if (resp.type === 'error') {
        current.addLog(`Error: ${resp.message}`, 'error');
        current.setGenerating(false);
        current.setDemoModeActive(false);
        worker.terminate();
        if (workerRef.current === worker) workerRef.current = null;
      }
    };

    worker.postMessage(msg, transferList);
  }, [canGenerate, notifyGenerationComplete]);

  const cancelGeneration = useCallback(() => {
    if (workerRef.current) {
      const worker = workerRef.current;
      worker.postMessage({ type: 'cancel' } satisfies WorkerMessage);
      window.setTimeout(() => worker.terminate(), 50);
      workerRef.current = null;
    }
    const store = useStore.getState();
    store.setGenerating(false);
    store.setDemoModeActive(false);
    store.setProgress(0, 'Cancelled');
    store.addLog('Generation cancelled', 'warn');
  }, []);

  useEffect(() => () => {
    workerRef.current?.terminate();
    validationWorkerRef.current?.terminate();
  }, []);

  return { startGeneration, cancelGeneration, canGenerate };
}
