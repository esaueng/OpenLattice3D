# WebGPU marching cubes implementation design

This document designs a full WebGPU marching-cubes backend for OpenLattice3D.
It is implementation guidance only. Do not replace production generation until
the pipeline is built behind an explicit feature flag and verified against the
current CPU output.

## Goals

- Keep the current CPU backends as the default fallback.
- Run field sampling, cube classification, triangle counting, prefix scan, and
  triangle emission on WebGPU.
- Read back final `Float32Array` positions and normals compatible with the
  current `MarchingCubesResult` shape.
- Process work in 3D tiles so large exports do not require one huge GPU
  allocation.
- Preserve current visual output as closely as practical. Exact triangle order
  can differ from CPU if tile-local ordering is stable and geometry is correct.

## Backend boundary

Add a future backend name such as `webgpu-mc` or promote the existing
`webgpu-field-cpu-mc` once emission is also on GPU. Keep selection in
`src/backend/generation-backend.ts`.

The entry point should live under `src/backend/webgpu/`, for example:

```ts
generateTileWebGPU(options): Promise<WebGpuTileResult>
```

Inputs:

- `bounds`: full model bounds.
- `tileBounds`: non-overlapping cube range plus one-cell halo sampling bounds.
- `cells`: tile cell counts.
- analytic/sample-shape parameters first.
- later: flat BVH buffers for imported meshes.

Output:

- `positions: Float32Array`
- `normals: Float32Array`
- `triCount: number`
- timing: field, classify, scan, emit, readback
- debug counters: cubes, activeCubes, emittedTriangles, bytesAllocated

## Pipeline overview

Each GPU tile runs the following passes.

1. Field sampling
2. Cube classification
3. Triangle count buffer
4. Prefix scan
5. Triangle emission
6. Readback

The first implementation should use one tile per job and merge tile results on
the CPU, matching the existing CPU tiled backend ownership model. A later
optimization can batch multiple small tiles into one GPU submission.

## Pass 1: field sampling

This pass is mostly the existing `sampleFieldWebGPU` shader generalized to tile
inputs.

Buffers:

- `paramsBuffer`: uniform or read-only storage buffer with packed generation
  parameters.
- `fieldBuffer`: storage buffer of `f32`, length
  `(tileNx + 1) * (tileNy + 1) * (tileNz + 1)`.

Coordinate layout:

- Linear field index: `x + y * strideY + z * strideZ`.
- `strideY = tileNx + 1`.
- `strideZ = (tileNx + 1) * (tileNy + 1)`.

The shader computes world position from tile sample bounds. For analytic sample
shapes, it evaluates object SDF and lattice SDF directly. For imported meshes,
this pass is deferred until the flat BVH SDF path exists.

The first implementation should support the same limited scope as
`webgpu-field-cpu-mc`: built-in sample shapes and `gyroid`/`schwarzP`, then add
more TPMS types after correctness is stable.

## Pass 2: cube classification

This pass reads the scalar field and writes one record per cube.

Buffers:

- `fieldBuffer: f32[]`
- `cubeIndexBuffer: u32[]`, length `tileNx * tileNy * tileNz`
- `triCountBuffer: u32[]`, same length

For each cube:

1. Load the eight field values using the same corner order as CPU marching
   cubes:
   - 0: `(x, y, z)`
   - 1: `(x + 1, y, z)`
   - 2: `(x + 1, y + 1, z)`
   - 3: `(x, y + 1, z)`
   - 4: `(x, y, z + 1)`
   - 5: `(x + 1, y, z + 1)`
   - 6: `(x + 1, y + 1, z + 1)`
   - 7: `(x, y + 1, z + 1)`
2. Build the 8-bit cube index using `value < isoValue`.
3. Write `cubeIndexBuffer[cubeId]`.
4. Write `triCountBuffer[cubeId] = triCounts[cubeIndex]`.

The pass should also optionally write an `activeCubeCount` counter with atomics
for debugging, but this is not required for emission.

## Pass 3: prefix scan

The triangle counts must become triangle offsets before emission.

Inputs:

- `triCountBuffer: u32[]`

Outputs:

- `triOffsetBuffer: u32[]`, exclusive prefix sum of triangle counts.
- `totalTriCountBuffer: u32[1]`.

Recommended implementation:

1. Use a workgroup scan over fixed blocks, for example 256 or 512 elements.
2. Write per-block sums to `blockSumsBuffer`.
3. Recursively scan block sums until one block remains.
4. Add scanned block offsets back into each block.
5. Compute total as `lastOffset + lastTriCount`.

For the first implementation, keep this tile-local. Do not scan across all
tiles globally. CPU can merge tile results after readback.

Fallback option:

- If implementing a robust GPU scan becomes the main blocker, temporarily
  read back `triCountBuffer`, scan on CPU, upload `triOffsetBuffer`, and keep
  emission on GPU. This is not the target design, but it is an acceptable
  intermediate debug path behind a separate flag.

## Pass 4: triangle emission

This pass emits packed triangle vertices and normals.

Inputs:

- `fieldBuffer`
- `cubeIndexBuffer`
- `triOffsetBuffer`
- lookup buffers: edge table, triangle table, edge starts, edge ends
- grid/tile params

Outputs:

- `positionsBuffer: f32[]`, length `totalTriCount * 9`
- `normalsBuffer: f32[]`, length `totalTriCount * 3`

For each cube with nonzero triangle count:

1. Re-load eight field values.
2. Load edge mask from `edgeTable[cubeIndex]`.
3. Interpolate up to 12 edge vertices using the same CPU interpolation:
   - default `t = 0.5`
   - if `abs(va - vb) > epsilon`, `t = (iso - va) / (vb - va)`
   - clamp `t` to `[0, 1]`
4. For each emitted triangle edge triplet:
   - output vertices to `positionsBuffer[(triOffset + localTri) * 9 ...]`
   - compute face normal from emitted vertices
   - output one normal per triangle to `normalsBuffer[(triOffset + localTri) * 3 ...]`

Normal computation should match current viewer expectations: one face normal per
triangle, not per vertex. The current CPU result stores three position vertices
and one triangle normal. Keep that shape unless the viewer is changed
separately.

## Lookup tables in WGSL

Avoid large literal switch statements in WGSL. Use storage buffers for lookup
tables generated from the existing CPU tables in `marching-cubes.ts`.

Recommended buffers:

- `edgeTableBuffer: u32[256]`
- `triCountBufferLut: u32[256]`
- `triTableBuffer: i32[256 * 16]`
- `edgeStartBuffer: u32[12]`
- `edgeEndBuffer: u32[12]`
- `cornerOffsetBuffer: vec4<u32>[8]` or packed `u32[8 * 3]`

Use a flattened triangle table with 16 entries per cube configuration:

- edge ids in order
- `-1` sentinel after the last edge
- or use `triCount` and read exactly `triCount * 3` edge ids

The CPU source uses variable-length arrays. The WebGPU path should generate the
flat typed arrays once at module initialization and upload them once per device
or cache them in a `WebGpuMarchingCubesContext`.

## Tile-based generation

Full-volume GPU buffers scale poorly:

- field samples: `(resolution + 1)^3 * 4`
- cube index: `resolution^3 * 4`
- triangle counts: `resolution^3 * 4`
- offsets: `resolution^3 * 4`
- worst-case positions: `resolution^3 * 5 triangles * 9 floats * 4`
- worst-case normals: `resolution^3 * 5 triangles * 3 floats * 4`

The worst-case output buffers dominate. Do not allocate for the full model at
high resolution.

Process 3D tiles instead:

- Default GPU tile size should start at `32^3` or `48^3` cells.
- Field sampling for a tile needs `(tileCells + 1)` samples in each dimension.
- Tiles own only their non-overlapping cube range.
- Adjacent tiles share boundary sample positions but not cube ownership, so
  they should not duplicate triangles.
- CPU merges tile outputs in deterministic tile id order.

Memory budget:

- Query `adapter.limits.maxStorageBufferBindingSize` and
  `maxBufferSize` where available.
- Use an app-level conservative budget such as 128-256 MiB per tile.
- Estimate worst-case bytes before dispatch.
- If the estimate exceeds budget, reduce tile size.
- If tile size reaches a minimum such as `8^3` and still exceeds budget, fall
  back to CPU.

The output allocation can be exact after scan:

1. classify and scan
2. read back only `totalTriCountBuffer`
3. allocate exact `positionsBuffer` and `normalsBuffer`
4. run emission
5. read back exact outputs

This avoids worst-case triangle output allocation. It adds one small readback
before emission, but it is much safer for large jobs.

## Readback strategy

Read back only final outputs and small counters:

- `totalTriCountBuffer`
- positions buffer
- normals buffer
- optional timing/debug counters

Avoid reading back field, cube index, triangle count, or offsets in production.
Those buffers should remain GPU-local. Add debug flags to read intermediate
buffers for small resolutions during development.

After readback:

- construct `Float32Array` positions and normals from mapped ranges
- copy with `.slice()` before unmapping
- return `MarchingCubesResult`
- transfer generated buffers back to UI using the existing worker transfer list

## Fallback behavior

Fallback must be explicit and quiet for normal users.

Fallback to CPU when:

- `navigator.gpu` or `WorkerNavigator.gpu` is unavailable.
- adapter or device request fails.
- required device limits are too small.
- tile memory estimate exceeds the minimum viable tile budget.
- shader compilation, pipeline creation, dispatch, scan, or readback fails.
- unsupported lattice type, shape, variant, or imported mesh mode is requested.
- cancellation is requested.

Fallback target:

- Prefer current `cpu-tiled` when the job is a supported sample-shape tiled job.
- Otherwise use `cpu-single`.

The progress log should include the selected backend and fallback reason, but
the UI behavior should remain unchanged.

## Cancellation

WebGPU commands already submitted cannot be interrupted directly. Cancellation
should:

- stop queuing new tile work
- ignore completed GPU results for stale run tokens
- destroy temporary buffers where possible
- terminate worker-owned CPU tile workers if the flow falls back

The worker should check the existing `cancelled` flag between passes and
between tiles.

## Timing and perf report

Record per-tile and aggregate timings:

- field sampling
- classification
- prefix scan
- total triangle count readback
- output allocation
- triangle emission
- output readback
- CPU merge/cleanup

For logs, aggregate into:

- `webgpu field`
- `webgpu classify`
- `webgpu scan`
- `webgpu emit`
- `GPU readback`
- `CPU merge`

These labels should align with future performance reports so WebGPU can be
compared against `cpu-tiled` and `webgpu-field-cpu-mc`.

## Implementation phases

1. Add lookup table flattening and upload helpers.
2. Add classify pass and debug-read `triCountBuffer` for tiny grids.
3. Add GPU prefix scan for tile-local counts.
4. Add exact output allocation after `totalTriCountBuffer` readback.
5. Add triangle emission pass with face normals.
6. Integrate one tile behind a disabled feature flag.
7. Integrate tiled scheduling and CPU merge.
8. Add fallback and cancellation tests.
9. Enable only for built-in sample shapes and `gyroid`/`schwarzP`.
10. Expand lattice coverage after visual comparisons pass.

## Correctness checks

Use small deterministic sample jobs first:

- sphere + gyroid at low resolution
- cube + gyroid
- sphere + schwarzP
- empty/far field tile
- tile boundary case where the surface crosses an edge between two tiles

Compare:

- triangle count within expected tolerance
- bounding box
- no visible tile seams
- normal orientation visually comparable
- validation still runs after result delivery

Exact triangle ordering does not have to match CPU globally, but each tile
should emit triangles deterministically for stable debugging.

