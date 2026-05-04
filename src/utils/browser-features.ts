export interface BrowserFeatureFlags {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  webGPU: boolean;
  webAssembly: boolean;
  wasmSingleThreadedReady: boolean;
  threadedWasmReady: boolean;
}

export interface SharedGeometryBuffers {
  kind: 'shared';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
}

export interface TransferGeometryBuffers {
  kind: 'transfer';
  positions: Float32Array;
  normals: Float32Array;
  triCount: number;
}

export type BackendGeometryBuffers = SharedGeometryBuffers | TransferGeometryBuffers;

export function getBrowserFeatureFlags(): BrowserFeatureFlags {
  const navigatorWithGpu = globalThis.navigator as (Navigator & { gpu?: unknown }) | undefined;
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof globalThis.SharedArrayBuffer === 'function';
  const webGPU = Boolean(navigatorWithGpu?.gpu);
  const webAssembly = typeof globalThis.WebAssembly === 'object';

  return {
    crossOriginIsolated,
    sharedArrayBuffer,
    webGPU,
    webAssembly,
    wasmSingleThreadedReady: webAssembly,
    threadedWasmReady: webAssembly && crossOriginIsolated && sharedArrayBuffer,
  };
}

export function formatBrowserFeatureFlags(flags: BrowserFeatureFlags): string {
  return [
    `crossOriginIsolated=${flags.crossOriginIsolated ? 'yes' : 'no'}`,
    `SharedArrayBuffer=${flags.sharedArrayBuffer ? 'yes' : 'no'}`,
    `WebGPU=${flags.webGPU ? 'yes' : 'no'}`,
    `WASM=${flags.wasmSingleThreadedReady ? 'yes' : 'no'}`,
    `threadedWasmReady=${flags.threadedWasmReady ? 'yes' : 'no'}`,
  ].join(', ');
}

export function createBackendGeometryBuffers(
  positions: Float32Array,
  normals: Float32Array,
  triCount: number,
  flags = getBrowserFeatureFlags()
): BackendGeometryBuffers {
  if (flags.threadedWasmReady) {
    const sharedPositions = new Float32Array(new SharedArrayBuffer(positions.byteLength));
    const sharedNormals = new Float32Array(new SharedArrayBuffer(normals.byteLength));
    sharedPositions.set(positions);
    sharedNormals.set(normals);
    return {
      kind: 'shared',
      positions: sharedPositions,
      normals: sharedNormals,
      triCount,
    };
  }

  return {
    kind: 'transfer',
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    triCount,
  };
}

export function isSharedFloat32Array(value: Float32Array): boolean {
  return typeof SharedArrayBuffer === 'function' && value.buffer instanceof SharedArrayBuffer;
}
