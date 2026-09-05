# Backend parity and speed gates

This document defines the executable correctness and performance gates that a
new marching-cubes backend (for example `webgpu-mc`, designed in
`webgpu-marching-cubes-design.md`) must pass before it can be selected. The
gates live in `src/backend/` and run in Node without a browser.

## Gate 1: parity (runs in CI)

`npm test` includes `src/backend/parity.test.ts`, which runs every fixture in
`src/backend/fixtures.ts` on the `cpu-single` reference and each candidate
backend, then compares the results with `compareBackendResults`:

- triangle count within 1% (exact when the reference is empty);
- bounding box within one grid cell per axis;
- watertightness and topology: zero boundary and non-manifold edges in both
  results — a seam crack or duplicated tile face fails here;
- identical connected-fragment counts;
- signed volume within 2%, both outward-oriented, and at least 99% agreement
  between stored normals and triangle winding;
- wall thickness measured against the shared fixture field within 15% or half
  a grid cell, whichever is larger;
- identical validation verdicts (deviation, thickness, manifold,
  connectivity), with max outer deviation within one grid cell.

The tolerances (`PARITY_TOLERANCES` in `src/backend/parity.ts`) exist because
whole-volume sealing and per-tile extraction legitimately differ by a few
boundary triangles and by floating-point interpolation noise at shared tile
faces. Loosening a tolerance to make a failing backend pass requires a
recorded justification in this file.

Fixtures cover the design document's correctness list: representative shapes
with TPMS fields (sphere/cube/cylinder x gyroid/schwarzP/IWP), an empty field
(both backends must emit zero triangles), and a 3-tiles-per-axis case whose
surface crosses every internal tile seam.

## Gate 2: fallback behavior (runs in CI)

`src/backend/gate.test.ts` covers:

- cancellation aborts the run and never falls back into delivering geometry
  after a cancel;
- stale-result rejection at the worker boundary (also covered end-to-end in
  `src/hooks/generation-worker-controller.test.ts`);
- device loss and mid-run backend errors fall back explicitly to the CPU
  backend with the reason recorded (`runBackendWithFallback`);
- unsupported modes (imported meshes, lattice types outside the GPU pipeline)
  resolve to `unsupported-mode` and never attempt the GPU backend.

## Gate 3: warm-run speed (manual, on documented hardware)

`npm run bench:backends` runs each backend 1 warmup + 5 recorded times per
benchmark fixture and reports median and p95 end-to-end latency plus per-phase
timings (field, classification/scan/emission, readback, merge, cleanup). The
JSON report records the hardware and lands in
`docs/performance/results/backend-benchmark-<platform>-<arch>.json`;
committing it is what makes a speedup claim citable.

Timing caveats:

- The harness executes tiles inline on one thread, so `cpu-tiled` numbers
  measure compute, not the browser's multi-worker wall-clock speedup.
- CPU backends fuse classification, scan, and emission into one pass and have
  no GPU readback; those phases report as documented nulls. A WebGPU backend
  must report every phase.
- `cleanupMs` (boundary-loop closing) dominates both CPU backends at
  resolution 160; a GPU backend that only accelerates extraction cannot win
  the end-to-end threshold without addressing cleanup.

The reviewed minimum speedup for GPU promotion is **1.5x end-to-end median
vs `cpu-tiled`** (`GPU_PROMOTION_MIN_SPEEDUP` in `src/backend/gate.ts`).

## Promotion state

`resolveGpuEligibility` in `src/backend/gate.ts` consults
`GPU_PROMOTION_EVIDENCE` before probing hardware, so GPU selection stays
disabled until all three gates pass with committed evidence. There is no
`webgpu-mc` implementation today: parity and fallback evidence do not exist,
and the benchmark reports no GPU backend.

Latest committed benchmark: `results/backend-benchmark-darwin-arm64.json`
(Apple M5 Pro, 15 cores, Node v22.23.1): at resolution 160, cpu-single and
inline cpu-tiled are within noise of each other end-to-end (0.89-1.00x),
because boundary-loop cleanup dominates both.
