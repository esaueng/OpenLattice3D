# WASM backend proof-of-concept plan

This document defines the scaffold for a future WASM generation backend. The
current production path remains unchanged: CPU single-worker and CPU tiled
generation are still the only executing backends.

## Toolchain decision

Use Rust for the proof of concept.

Rust is the better initial fit because OpenLattice3D does not already have a
C++ geometry core to port. Rust provides predictable memory ownership for large
linear buffers, good control over allocation-heavy hot paths, and a practical
threaded-WASM path through `wasm-bindgen-rayon`. C++ with Emscripten is still a
reasonable option if the project later adopts an existing native geometry
library, but it would add more build and runtime complexity before there is a
native codebase to reuse.

## Browser feature model

The scaffold distinguishes two WASM modes:

- Single-threaded WASM: available when `WebAssembly` exists.
- Threaded WASM: available only when `WebAssembly`, `SharedArrayBuffer`, and
  `crossOriginIsolated` are all available.

If either mode is unavailable, the app should continue with the selected CPU
backend. WASM artifacts must be loaded dynamically so a missing `.wasm` file
does not break Vite build, local dev, or Cloudflare deployment.

## Placeholder loader

`src/backend/wasm/wasm-backend.ts` provides a safe loader API:

- `detectWasmBackendSupport()` reports single-threaded and threaded readiness.
- `loadWasmBackend()` optionally fetches and compiles an artifact URL.
- If no artifact URL is configured, or the artifact is missing, it returns
  `{ available: false, reason }` and leaves CPU generation active.

The loader is not connected to production generation yet. Backend selection may
name `wasm-single-placeholder` or `wasm-threaded-placeholder`, but those names
are still disabled by explicit constants in the worker.

## Future geometry ABI

The first real WASM core should expose three narrow capabilities.

### Field sampling

Input:

- Bounds min/max.
- Grid resolution or tile dimensions.
- Lattice parameters in a packed numeric/config structure.
- Optional source mesh/BVH buffers.

Output:

- Fill a caller-owned `Float32Array` or WASM memory slice with scalar field
  samples.

The JS side should be able to choose whether memory is copied from WASM or
viewed directly through a typed array.

### Marching cubes tile emission

Input:

- Tile bounds and cell counts.
- One-cell halo field samples, or enough parameters for the WASM core to sample
  the tile itself.

Output:

- Positions `Float32Array`.
- Normals `Float32Array`.
- Triangle count.
- Optional timing counters.

The tile output must preserve the current `MarchingCubesResult` compatibility
and avoid duplicate triangles at tile boundaries.

### Flat BVH signed distance

Input:

- Source mesh positions/normals.
- Flat BVH arrays equivalent to the existing typed-array BVH layout:
  node bounds, child/first indices, triangle counts, and triangle indices.

Output:

- Signed distance for query points.
- Closest triangle index when needed for normal/sign behavior.

The sign behavior must match the current mesh SDF path closely enough that
imported STL generation and validation remain visually compatible.

## Build requirements

A future Rust implementation should live outside the hot production bundle until
enabled. Expected requirements:

- Rust stable toolchain.
- `wasm32-unknown-unknown` target.
- `wasm-bindgen-cli`.
- `wasm-bindgen-rayon` only for the threaded variant.
- Cross-origin isolation headers for threaded mode.

The generated artifact should be emitted under a public or build output path
that can be fetched at runtime, not imported statically by the app entry point.

## Fallback behavior

When WASM is unavailable, missing, or explicitly disabled:

1. CPU tiled remains preferred for supported procedural generation.
2. CPU single remains the universal fallback.
3. Imported meshes and existing validation behavior remain unchanged.

This keeps the proof-of-concept path safe to land before a full geometry port.
