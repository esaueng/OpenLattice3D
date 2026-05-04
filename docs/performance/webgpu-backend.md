# WebGPU backend scaffold

This document describes the initial WebGPU scaffold. It does not replace
production generation. CPU tiled and CPU single remain the executing backends.

## Current scaffold

`src/backend/webgpu/webgpu-backend.ts` provides:

- `detectWebGpuSupport()` using `navigator.gpu` or `WorkerNavigator.gpu`.
- `initializeWebGpu()` to request an adapter and device.
- `runWebGpuSmokeTest()` for development/debug use.

The smoke test creates a tiny storage buffer, runs a compute shader that writes
four integers, copies the result to a readback buffer, and verifies the values.
It is not called during normal generation and is safe for browsers without
WebGPU because the initialization path returns an unavailable result.

No WebGPU package or shader build step is added.

## Fallback behavior

WebGPU is optional. If `navigator.gpu` is unavailable, adapter/device creation
fails, or the smoke test fails, the app should continue to use the selected CPU
backend. The backend selector may report `hasWebGPU`, but
`webgpu-placeholder` remains disabled by an explicit worker constant until a
real backend is implemented.

## Roadmap

### Phase A: GPU field evaluation + CPU marching cubes

Move scalar field evaluation to compute shaders while keeping marching cubes on
the CPU. This is the smallest useful slice because TPMS field sampling is dense
and embarrassingly parallel. The CPU would read back tile scalar fields and run
the existing tile marching-cubes emitter.

Key concerns:

- Keep one-cell halo samples for tile borders.
- Minimize readback size by processing tiles.
- Preserve current SDF semantics for shell, no-shell, surface-only, gradient,
  and thin-section filtering.

### Phase B: GPU marching cubes classify/scan/emit

Move cube classification and triangle emission to WebGPU. This likely needs a
multi-pass pipeline:

1. Classify cubes and count emitted triangles.
2. Prefix-sum triangle counts.
3. Emit packed positions/normals.
4. Read back exact output buffers.

This phase should preserve triangulation compatibility where practical, but
correctness and tile-boundary behavior matter more than byte-for-byte ordering.

### Phase C: GPU flat BVH SDF for imported meshes

Port imported mesh signed-distance queries to GPU using the existing flat BVH
layout as the source shape:

- Node min/max bounds.
- Child/first indices.
- Triangle counts.
- Triangle indices and precomputed triangle data.

The GPU path should use squared-distance pruning and preserve current sign
behavior based on the closest triangle normal. This is the highest-risk phase
because imported mesh SDF quality controls both generation and validation.

## Development notes

WebGPU APIs are browser-gated and may vary across environments. Keep WebGPU
code behind runtime detection and debug-only calls until a full backend exists.
Future tests should exercise:

- Browser without WebGPU.
- Browser with WebGPU but failed adapter/device request.
- Successful smoke test.
- CPU fallback after any WebGPU initialization error.
