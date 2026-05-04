# WASM backend scaffold

This directory is a placeholder for a future OpenLattice3D WebAssembly geometry
core. It is intentionally not wired into production generation yet.

## Toolchain choice

Prefer Rust for the first WASM proof of concept.

- The current geometry core is TypeScript, not C++, so there is no existing C++
  codebase that would make Emscripten the low-risk path.
- Rust gives explicit ownership for large typed-array style buffers and a good
  path to safe flat data structures for marching cubes and BVH traversal.
- The Rust ecosystem supports both single-threaded WASM and threaded builds via
  `wasm-bindgen` plus `wasm-bindgen-rayon` when cross-origin isolation is
  available.
- C++/Emscripten remains viable later if a native geometry library is adopted,
  but it would add more runtime and build-system surface area for this project.

## Current TypeScript API

`wasm-backend.ts` exposes:

- `detectWasmBackendSupport()` for single-threaded and threaded readiness.
- `loadWasmBackend()` as a safe placeholder loader.

The loader does not statically import a `.wasm` file. If no artifact URL is
configured, or if the artifact is missing, it returns an unavailable result and
the existing CPU backends continue to run.

## Expected future layout

A future Rust crate should expose a narrow ABI around numeric buffers:

- Field sampling: fill a caller-owned scalar field buffer for a grid or tile.
- Marching cubes tile emission: emit positions, normals, and triangle count for
  one non-overlapping tile, including halo samples at tile boundaries.
- Flat BVH signed distance: build or consume flat typed-array BVH data and
  evaluate closest-point signed distance without object allocations.

Generated mesh buffers should stay compatible with the existing
`MarchingCubesResult` shape: `Float32Array` positions, `Float32Array` normals,
and `triCount`.
