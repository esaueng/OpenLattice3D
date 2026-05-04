# WebGPU backend scaffold

This document describes the initial WebGPU scaffold. It does not replace
production generation. CPU tiled and CPU single remain the executing backends.

## Current scaffold

`src/backend/webgpu/webgpu-backend.ts` provides:

- `detectWebGpuSupport()` using `navigator.gpu` or `WorkerNavigator.gpu`.
- `initializeWebGpu()` to request an adapter and device.
- `runWebGpuSmokeTest()` for development/debug use.
- `sampleFieldWebGPU()` for the first guarded analytic sample-shape path.

The smoke test creates a tiny storage buffer, runs a compute shader that writes
four integers, copies the result to a readback buffer, and verifies the values.
It is not called during normal generation and is safe for browsers without
WebGPU because the initialization path returns an unavailable result.

No WebGPU package or shader build step is added.

## Field sampling fast path

The first optional fast path is `webgpu-field-cpu-mc`. It is disabled by
default through `ENABLE_WEBGPU_FIELD_CPU_MC` in the lattice worker. When that
constant is explicitly enabled, the worker may select it for built-in sample
shapes using `gyroid` or `schwarzP` lattices.

This path only moves scalar field sampling to WebGPU. The scalar field is copied
back to CPU memory and passed to the existing marching-cubes emission logic via
`marchingCubesFromField`. This keeps the generated mesh result shape compatible
with current viewers and validation.

The progress/performance log separates:

- WebGPU field dispatch/setup time.
- GPU readback time.
- CPU marching-cubes time.

## Fallback behavior

WebGPU is optional. If `navigator.gpu` is unavailable, adapter/device creation
fails, field sampling fails, or the smoke test fails, the app should continue
to use a CPU backend. Imported STL mesh generation is intentionally out of
scope for this WebGPU field path.

## Roadmap

### Phase A: GPU field evaluation + CPU marching cubes

Move scalar field evaluation to compute shaders while keeping marching cubes on
the CPU. This is the smallest useful slice because TPMS field sampling is dense
and embarrassingly parallel. The CPU would read back tile scalar fields and run
the existing tile marching-cubes emitter.

Initial scaffold status: implemented for built-in sample shapes with `gyroid`
and `schwarzP`, behind an explicit disabled-by-default flag.

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
