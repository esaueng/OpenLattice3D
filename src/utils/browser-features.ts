export interface BrowserFeatureFlags {
  crossOriginIsolated: boolean;
  sharedArrayBuffer: boolean;
  threadedWasmReady: boolean;
}

export function getBrowserFeatureFlags(): BrowserFeatureFlags {
  const crossOriginIsolated = globalThis.crossOriginIsolated === true;
  const sharedArrayBuffer = typeof globalThis.SharedArrayBuffer === 'function';

  return {
    crossOriginIsolated,
    sharedArrayBuffer,
    threadedWasmReady: crossOriginIsolated && sharedArrayBuffer,
  };
}

export function formatBrowserFeatureFlags(flags: BrowserFeatureFlags): string {
  return [
    `crossOriginIsolated=${flags.crossOriginIsolated ? 'yes' : 'no'}`,
    `SharedArrayBuffer=${flags.sharedArrayBuffer ? 'yes' : 'no'}`,
    `threadedWasmReady=${flags.threadedWasmReady ? 'yes' : 'no'}`,
  ].join(', ');
}
