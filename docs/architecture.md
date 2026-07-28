# OpenLattice3D architecture

OpenLattice3D turns either a procedural solid or an imported STL mesh into a
manufacturing-oriented lattice without sending geometry to a server. Geometry
uses millimetres throughout. Scalar fields are negative inside material,
positive outside, and are extracted at iso-value zero.

## Generation flow

1. `LeftPanel` imports an STL, restores a project, or selects a procedural part.
2. `useStore` owns the source, sanitized lattice parameters, selection masks,
   viewer state, and undo/redo history.
3. `useLatticeGeneration` starts `lattice-worker`, reports progress, and rejects
   stale run results after cancellation or replacement.
4. The worker builds a signed-distance evaluator, samples it, extracts triangles
   with marching cubes, and removes disconnected artifacts.
5. `validation-worker` checks deviation, minimum thickness, manifoldness, and
   connectivity before manufacturing statistics and exports are enabled.

Procedural parts use analytic object distances. Imported meshes use a triangle
BVH for nearest-surface queries and inside/outside classification. Both paths
combine the same lattice field, shell, surface-only band, and escape-hole
subtraction rules.

The procedural source shown in the viewport is a disposable display mesh, not
the manufacturing representation. Curved samples use screen-space chordal and
angular tolerances with bounded LOD tiers, and analytic edge samples share the
surface's angular grid. Camera zoom or source changes regenerate this display
cache without changing the analytic SDF used by generation or the exported
lattice mesh.

## Geometry composition

Shell-bearing generation divides the part into an outer shell and a lattice
core, then joins those negative-inside fields with a smooth minimum. No-shell
generation intersects the lattice directly with the object. Surface-only mode
confines the lattice to a configurable band near the input surface. Escape
holes subtract infinite axis-aligned cylinder fields that are clipped by the
part, producing through-holes without changing the source mesh or units.

TPMS formulas are dimensionless periodic functions, but the exported wall
thickness is specified in millimetres. Each TPMS evaluator divides the function
magnitude by its analytic world-space gradient before applying half the target
wall thickness. This local distance approximation keeps thickness consistent
across cell sizes and formulas; tests cover finite values, periodicity, and
local roots.

## Worker backends

Two production CPU paths are intentionally supported:

- `cpu-tiled` splits procedural grids into bounded 32-cell tiles, skips tiles
  proven to be outside the active region, runs a capped worker pool, and merges
  results in deterministic tile order.
- `cpu-single` handles imported meshes and serves as the universal fallback.

Inactive WebGPU and WASM placeholders were removed. Their reinstatement gates
and a full GPU marching-cubes design live under `docs/performance/`.

## UI and persistence boundaries

`Viewer3D` owns scene interaction, while `viewer/ViewerMeshViews` owns mesh and
selection rendering and `viewer/DemoGridView` owns the twelve-lattice overview.
Generation scheduling is separated into `tiled-generation`,
`generation-estimate`, and `mesh-cleanup` so the worker entry point remains an
orchestrator.

Project JSON uses a versioned schema. It embeds imported source geometry as a
binary STL, fingerprints the decoded positions before applying selection masks,
and restores validated parameters plus viewer and validation state. Legacy
parameter-only JSON remains readable. STL and 3MF exports contain only generated
geometry; 3MF uses millimetre model units and indexed triangle resources.

## Correctness contracts

- Do not compare floating-point geometry with exact equality; algorithms use
  explicit tolerances appropriate to their scale.
- Do not silently rescale imported or exported geometry.
- Reject non-finite STL coordinates and malformed project values.
- Preserve triangle winding and report topology defects rather than treating a
  nominal export as proof of printability.
- Keep computational geometry outside React components so it can be tested in
  deterministic Node-based unit tests.
