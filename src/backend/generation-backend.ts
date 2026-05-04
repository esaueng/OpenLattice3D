export type GenerationBackendName =
  | 'cpu-single'
  | 'cpu-tiled'
  | 'wasm-single-placeholder'
  | 'wasm-threaded-placeholder'
  | 'webgpu-placeholder';

export interface GenerationBackendCapabilities {
  hasWebGPU: boolean;
  hasSharedArrayBuffer: boolean;
  crossOriginIsolated: boolean;
  hardwareConcurrency: number;
  tileWorkerPoolAvailable: boolean;
}

export interface GenerationBackendSelectionOptions {
  capabilities: GenerationBackendCapabilities;
  enableWasmSinglePlaceholder?: boolean;
  enableWasmThreadedPlaceholder?: boolean;
  enableWebGPUPlaceholder?: boolean;
  preferTiledCpu?: boolean;
}

type NavigatorWithGPU = Navigator & { gpu?: unknown };

export function detectGenerationBackendCapabilities(
  scope: typeof globalThis = globalThis,
  options: { tileWorkerPoolAvailable?: boolean } = {}
): GenerationBackendCapabilities {
  const navigatorLike = scope.navigator as NavigatorWithGPU | undefined;
  return {
    hasWebGPU: Boolean(navigatorLike?.gpu),
    hasSharedArrayBuffer: typeof scope.SharedArrayBuffer === 'function',
    crossOriginIsolated: scope.crossOriginIsolated === true,
    hardwareConcurrency: navigatorLike?.hardwareConcurrency ?? 1,
    tileWorkerPoolAvailable: options.tileWorkerPoolAvailable === true,
  };
}

export function selectBestBackend(options: GenerationBackendSelectionOptions): GenerationBackendName {
  const {
    capabilities,
    enableWasmSinglePlaceholder = false,
    enableWasmThreadedPlaceholder = false,
    enableWebGPUPlaceholder = false,
    preferTiledCpu = true,
  } = options;

  if (enableWebGPUPlaceholder && capabilities.hasWebGPU) return 'webgpu-placeholder';
  if (
    enableWasmThreadedPlaceholder &&
    capabilities.crossOriginIsolated &&
    capabilities.hasSharedArrayBuffer
  ) {
    return 'wasm-threaded-placeholder';
  }
  if (enableWasmSinglePlaceholder) return 'wasm-single-placeholder';

  if (preferTiledCpu && capabilities.tileWorkerPoolAvailable) return 'cpu-tiled';
  return 'cpu-single';
}

export function formatBackendCapabilities(capabilities: GenerationBackendCapabilities): string {
  return [
    `tileWorkers=${capabilities.tileWorkerPoolAvailable ? 'yes' : 'no'}`,
    `webgpu=${capabilities.hasWebGPU ? 'yes' : 'no'}`,
    `sab=${capabilities.hasSharedArrayBuffer ? 'yes' : 'no'}`,
    `isolated=${capabilities.crossOriginIsolated ? 'yes' : 'no'}`,
    `cores=${capabilities.hardwareConcurrency}`,
  ].join(', ');
}
