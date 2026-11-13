# Large parts: generation limits and memory model

Generation used to be capped at 265³ field samples (264 cells per axis,
resolution level 10) on every path. That cap exists because the
single-worker path (`cpu-single`) samples the whole grid into one
`Float32Array`. The tiled path (`cpu-tiled`, procedural shapes and imported
meshes) never holds more than one 33³ tile field per worker, so its real
limits are the merged output mesh and what happens to it afterwards. This
note models that memory, derives the per-path limits in
`src/geometry/generation-limits.ts`, and records measurements.

All figures are approximate. Sizes are computed from typed-array lengths
unless marked as measured.

## Limits

| Path | Grid limit (cells/axis) | Highest level | Set by |
| --- | --- | --- | --- |
| `cpu-single` | 264 (265³ = 18.5 M samples) | 10 | one whole-field allocation, 74 MB (unchanged) |
| `cpu-tiled` | 314 | 12 (312³) | estimated triangles with headroom, against the 5 M triangle budget |
| any tile field | 265³ samples | — | `generationSampleCount`, unchanged; tiles are 33³ |

- **Single field.** `MAX_GENERATION_FIELD_SAMPLES` and `generationSampleCount`
  are unchanged and still bound every field allocation: the whole cpu-single
  field, each tile field, and direct library calls.
- **Tiled.** `MAX_TILED_GENERATION_GRID = max(264, min(512, floor(sqrt(B / (k × h)))))`,
  where B = `MAX_MESH_TRIANGLES` = 5,000,000, k = 44 triangles per grid face
  (the existing preflight estimate, now `ESTIMATED_TRIANGLES_PER_GRID_FACE`) and
  h = 1.15 headroom (`TRIANGLE_ESTIMATE_HEADROOM`). That gives 314. The headroom
  comes from the measurements below: the default sphere gyroid produces 47.5
  triangles per grid face, 8% over k, and without it level 13 (336³) would be
  offered and fail on the sphere. The 512 ceiling
  (`TILED_GENERATION_GRID_CEILING`, 16³ = 4096 tiles) only bounds scheduling.
  It applies only if B rises above about 13.3 M triangles.
- **Output budget.** `assertGenerationOutputBudget` is unchanged. It runs as
  each tile result arrives, counting backing-buffer bytes, so a run that
  produces more triangles than its estimate stops before the merged copy is
  allocated. At 336³ the sphere stopped after about 3 s with "Generated mesh
  exceeds the 5,000,000 triangle memory limit".
- **Before any allocation.** `lattice-worker.ts` picks the path first, then
  calls `assertGenerationGrid(cells, path, reason)`. This happens before the
  BVH is built, surface samples are drawn, the field is sampled, or tiles are
  scheduled. `buildTileJobs`, `planMeshTiles` and `createMeshTileContext` repeat
  the tiled check. Example messages:
  - `A 315³ generation grid exceeds the 314³ memory limit for tiled generation (up to about 5.0 M triangles estimated against the 5,000,000 triangle budget); lower the export resolution.`
  - `A 288³ generation grid exceeds the 264³ memory limit for single-worker generation (thin-feature removal needs the whole field in memory); lower the export resolution.`
- **No fallback above 264.** If a tiled run fails, the worker normally retries
  on cpu-single. Above 264 cells it now reports the tiled error instead,
  because cpu-single cannot hold that field.
- **Resolution levels.** Grid = 24 + 24 × level. The select offers levels 1–12.
  Levels 11 (288³) and 12 (312³) are labelled "Large … (tiled)" and are
  disabled when the run must use cpu-single. `sanitizeLatticeParams` accepts up
  to `MAX_EXPORT_RESOLUTION_LEVEL` (12), so saved settings and project files
  keep them. The default (level 4) is unchanged. Preflight fixes and
  result guidance still suggest at most level 10. Levels 11–12 are offered,
  never suggested.

## Which paths need the whole field

These were checked in `lattice-worker.ts`. `fullFieldRequirement(params)` is the
single predicate used by the worker, preflight and the resolution select.

| Feature | Whole field? | Why |
| --- | --- | --- |
| Thin-feature removal (`thinSectionFilter > 0`) | **yes, forces cpu-single** | `openField` is a morphological opening (whole-volume distance transform). Per-tile opening would need halos of the opening radius, and seams would disagree. |
| Conformal hexagon/triangle surface lattices | **yes, forces cpu-single** | The field is built from a global set of relaxed, Poisson-sampled surface points in the generation worker. It is not a whole-field operation as such, but it is not tiled yet. |
| Comparison (demo) grid | cpu-single | It has its own resolution mapping, clamped to level 10. |
| Escape holes | no | `cutEscapeHolesInField` is per sample. Imported-mesh tiles already cut holes from the whole grid's bounds (`mesh-tiles.ts`). Procedural tiles now do the same (`shape-tiles.ts`, below). |
| Boundary seal | no | `sealFieldBoundary` touches only samples on the grid's outer faces. Tiles seal the samples they hold that lie on those faces. |
| Sparse skipping, gradients, keep-in/keep-out, Voronoi/spinodal seeds | no | Per-sample, or deterministic from the seed and the whole-grid bounds. |
| `closeBoundaryLoops` | no field | Runs on the merged soup (memory below). |

### Procedural tiles: escape holes and seal

Before this change a procedural (sample-shape) tile ran
`marchingCubesRectangular` on the lattice SDF. That SDF already subtracts
escape holes placed from the object bounds (`withEscapeHoles`). The
single-worker path then also cuts holes placed from the padded grid bounds
(`cutEscapeHolesInField`) and seals the grid boundary. With two or more holes,
the two placements differ, so the tiled mesh lacked the grid-placed holes the
single path cut.

`computeShapeTile` (`src/workers/shape-tiles.ts`) now samples the tile, cuts the
grid-placed holes into the tile's samples, seals samples on the grid's outer
faces, and extracts. `LatticeTileJob` carries `gridBounds`, `gridCells` and
`origin` for this.

- **Unchanged output:** when escape holes are off and the padded bounds keep
  the seal a no-op (the default), each tile is byte-identical to the former
  kernel (`large-grid.test.ts`).
- **Changed output:** procedural tiled runs with escape holes now match the
  single path to rounding (triangle count within 0.1%, volume within 0.01%).
  Tile samples come from tile bounds, so their float bits can differ slightly
  from the whole grid's. Before the change the volume differed by more than
  0.1%.

## Memory model

Symbols: G = cells per axis, T = output triangles, W = tile workers
(≤ `MAX_TILE_WORKERS` = 8), S = `TILE_SIZE` = 32. A triangle soup costs
36 B of positions plus 12 B of face normals = 48 B per triangle. The estimate
the UI uses is T ≈ 44 G².

| Stage | Where | Bytes | At T = 4.6 M (312³ sphere) |
| --- | --- | --- | --- |
| Whole field (cpu-single only) | generator | 4 (G+1)³ | n/a (74 MB at 264) |
| Tile field | each tile worker | 4 (S+1)³ = 144 KB, × W | ≤ 1.2 MB |
| Tile extraction upper bound | each tile worker | 36 × first-pass triangle bound of one tile | a few MB |
| Retained tile results | generator | 48 T (budget-checked per tile, backing buffers counted) | 222 MB |
| Merge (`mergeTileResults` / `mergeMeshTilesInGridOrder`) | generator | + 48 T, so 96 T while both are live | 443 MB |
| `closeBoundaryLoops` temporaries | generator | ≈ 56 T (weld ids, first corners, open-addressing table, edge buckets; 66 MB at 1.19 M triangles per `boundary-loop-cleanup.md`), + 48 T′ if it fills holes | ≈ 260 MB |
| Display and validation copies | generator | vertex normals 36 T + validation positions 36 T + normals 12 T = 84 T, so 132 T live | 610 MB |
| Transfer to the UI | — | 0 (transfer list, no copy) | — |
| UI (`LatticeResult`) | main thread | positions 36 T + normals 12 T + vertex normals 36 T = 84 T | 388 MB |
| Viewer GPU buffers | GPU | positions + vertex normals = 72 T | 332 MB |
| Validation input | validation worker | 48 T + analysis temporaries (not modelled) | 222 MB + |
| STL export | main thread | 84 + 50 T, plus a possible Blob copy | 231–462 MB |
| 3MF / OBJ export | main thread | indexed mesh plus text: roughly 100–200 B/T while building (rough, not measured) | 0.5–0.9 GB |

- **Live after handoff:** 84 T (UI) + 72 T (GPU) + 48 T (validation) = 204 T.
  That is `BYTES_PER_OUTPUT_TRIANGLE`. Preflight shows
  `estimateGenerationMemoryBytes(G, path, T) = 4 × field samples + 204 T`,
  where field samples is (G+1)³ on cpu-single and W (S+1)³ on cpu-tiled. At
  the highest tiled level (312³, est. 4.3 M triangles) that is about 0.9 GB.
- **Generator peak:** 132 T of live arrays. Tile results freed after the merge
  are not collected immediately, so the measured peak is about 180 T of array
  buffers.
- **What bounds what:** every stage after the tiles is linear in T, and T is
  capped at 5 M by `assertGenerationOutputBudget`. At that cap the live
  arrays come to about 1.0 GB across the generator handoff, UI, GPU and
  validation. Exports add 0.25–1 GB. This ceiling is the same one the
  cpu-single path already allowed at 264³. Tiling only lets more grids reach
  it.

## Measurements

Approximate. Linux x64 container, 4 cores shared with other jobs, Node
v22.23.4. Three `worker_threads` tile workers ran the real `computeShapeTile`,
`runTiledGeneration`, `closeBoundaryLoops` and the handoff copies from
`lattice-worker.ts`. The viewer, validation and export were not run.
`process.memoryUsage()` was sampled every 20 ms across the main thread and the
tile-worker threads, so short spikes can be missed. Default parameters
(gyroid, shell, 8 mm cells), seed 0, sample radius 25 mm. Scratch scripts are
not committed (`measure.ts`, `tile-worker-node.ts`).

| Shape | Grid | Triangles | Tri / grid face | Tiles processed / total | Tiles + merge | Repair | Copies | Total | Peak array buffers | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| sphere | 264 (old cap) | 3,304,344 | 47.4 | 686 / 729 | 1.3 s | 0.9 s | 0.2 s | 2.4 s | 595 MB | 884 MB |
| sphere | 312 | 4,617,612 | 47.4 | 974 / 1000 | 2.8–3.0 s | 1.2–1.5 s | 0.4 s | 4.3–4.8 s | 831 MB | 1.2 GB |
| sphere | 320 | 4,861,716 | 47.5 | 992 / 1000 | 2.2 s | 1.4 s | 0.5 s | 4.0 s | 875 MB | 1.26 GB |
| sphere | 336 | rejected at 5 M triangles | — | — | 3.0 s to fail | — | — | — | — | 0.44 GB |
| cube | 312 | 4,082,004 | 41.9 | 1000 / 1000 | 2.0 s | 1.0 s | 0.3 s | 3.3 s | 539 MB | 876 MB |
| cylinder | 312 | 3,853,008 | 39.6 | 1000 / 1000 | 3.2 s | 1.0 s | 0.3 s | 4.5 s | 509 MB | 832 MB |
| torus | 312 | 3,143,344 | 32.3 | 997 / 1000 | 3.1 s | 0.9 s | 0.2 s | 4.3 s | 566 MB | 867 MB |
| capsule | 312 | 3,184,936 | 32.7 | 1000 / 1000 | 2.4 s | 0.9 s | 0.2 s | 3.5 s | 573 MB | 868 MB |

- **Determinism:** two runs at 312³ gave the same triangle count.
  `large-grid.test.ts` asserts byte-identical output across 1, 3 and 8 workers
  at 300³.
- **Peak array buffers vs. the model:** at 312³ the sphere peaked at 831 MB,
  180 B/T. That is the 132 T model plus uncollected tile results.
- **RSS** adds roughly 0.3 GB of runtime baseline (four V8 isolates) on top of
  the array buffers.
- **Browser runs** add the UI, GPU and validation memory above, and imported
  meshes add their BVH (shared, or one copy per worker without isolation).
  The UI's time estimate (`estimateGenerationTimings`) is a single-thread
  model and overstates tiled runs.

## Raising the limits further

The tiled limit is set by the triangle budget, not by field memory. To go
further:

1. Raise `MAX_MESH_TRIANGLES`. It is also the import cap. The live arrays
   grow by about 204 B for each extra output triangle, plus exports.
2. Drop or shrink the 84 T of handoff copies, for example by deriving vertex
   normals on the GPU or validating from the UI's copy.
3. Stream tiles into the merged buffer instead of retaining them, which saves
   48 T at the merge.

Thin-feature removal could tile with halos of the opening radius. Conformal
surface lattices could tile by shipping their surface samples to the tile
workers. Until then both stay at 264³.
