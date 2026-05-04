import { getBrowserFeatureFlags } from '../../utils/browser-features';
import type { BrowserFeatureFlags } from '../../utils/browser-features';

export type WasmBackendMode = 'single-threaded' | 'threaded';

export interface WasmBackendSupport {
  singleThreaded: boolean;
  threaded: boolean;
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
}

export interface WasmBackendLoaderOptions {
  mode?: WasmBackendMode;
  artifactUrl?: string;
  features?: BrowserFeatureFlags;
}

export interface WasmBackendUnavailable {
  available: false;
  mode: WasmBackendMode;
  reason: string;
  support: WasmBackendSupport;
}

export interface WasmBackendReady {
  available: true;
  mode: WasmBackendMode;
  module: WebAssembly.Module;
  support: WasmBackendSupport;
}

export type WasmBackendLoadResult = WasmBackendReady | WasmBackendUnavailable;

export function detectWasmBackendSupport(features = getBrowserFeatureFlags()): WasmBackendSupport {
  return {
    singleThreaded: features.wasmSingleThreadedReady,
    threaded: features.threadedWasmReady,
    crossOriginIsolated: features.crossOriginIsolated,
    sharedArrayBuffer: features.sharedArrayBuffer,
  };
}

export async function loadWasmBackend(
  options: WasmBackendLoaderOptions = {}
): Promise<WasmBackendLoadResult> {
  const mode = options.mode ?? 'single-threaded';
  const support = detectWasmBackendSupport(options.features);

  if (mode === 'threaded' && !support.threaded) {
    return {
      available: false,
      mode,
      reason: 'Threaded WASM requires cross-origin isolation and SharedArrayBuffer.',
      support,
    };
  }

  if (!support.singleThreaded) {
    return {
      available: false,
      mode,
      reason: 'WebAssembly is not available in this browser context.',
      support,
    };
  }

  if (!options.artifactUrl) {
    return {
      available: false,
      mode,
      reason: 'No WASM artifact URL configured; CPU backends remain active.',
      support,
    };
  }

  try {
    const response = await fetch(options.artifactUrl);
    if (!response.ok) {
      return {
        available: false,
        mode,
        reason: `WASM artifact unavailable (${response.status}); CPU backends remain active.`,
        support,
      };
    }
    const module = await WebAssembly.compile(await response.arrayBuffer());
    return { available: true, mode, module, support };
  } catch (err: unknown) {
    return {
      available: false,
      mode,
      reason: err instanceof Error ? err.message : 'WASM backend load failed.',
      support,
    };
  }
}
