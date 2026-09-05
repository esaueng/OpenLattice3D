# AGENTS.md

Browser-local lattice generator for 3D printing: React 19 + Three.js
(@react-three/fiber) UI, Zustand store, Vite build, Cloudflare Workers static
hosting. All geometry processing runs locally in Web Workers; no model-upload
service exists.

## Commands

Node 22 and npm 10+; install with `npm ci` (lockfile-pinned).

```bash
npm run dev        # Vite dev server on http://127.0.0.1:5176 (localhost only)
npm run lint       # ESLint (flat config)
npm run typecheck  # tsc -b (app + node + test projects)
npm test           # Vitest, node environment, 60s testTimeout
npm run build      # prebuild runs npm test, then tsc -b && vite build
npm run preview    # serve the production dist/ locally
```

`npm run deploy` (wrangler) must not be run without explicit approval:
production deploys are owned by Cloudflare Workers Builds on push to `main`,
and the smoke workflow is disabled by default (see
`.github/workflows/cloudflare.yml`).

## Architecture

- `src/geometry/` — pure, fully unit-tested geometry core: SDF lattice
  builders, marching cubes, BVH, mesh analysis/topology/repair, STL/3MF/OBJ
  codecs. No DOM or React imports; everything here runs in Node tests.
- `src/workers/` — `lattice-worker.ts` orchestrates one generation job
  (SDF sampling, marching cubes, cleanup, escape holes) and kicks off
  `validation-worker.ts` (deviation, min thickness, manifoldness,
  connectivity). `tiled-generation.ts` fans procedural jobs out to bounded
  `lattice-tile-worker.ts` instances (max 8, sparse tile skipping, merge by
  tile id). `surface-sample-worker.ts` Poisson-samples surfaces for
  hex/triangle surface lattices.
- `src/hooks/generation-worker-controller.ts` — worker session lifecycle;
  malformed, stale, and post-cancel results are rejected by session id.
- `src/components/` — React panels and the Three.js viewer only; keep
  computational geometry out of components.
- `src/store/useStore.ts` — Zustand global state; browser persistence is
  limited to parameters and viewer preferences.
- `worker/index.ts` — tiny production Worker serving `GET /health`; static
  assets come from `dist/`.

## Geometry invariants

- Millimetres everywhere; never silently rescale imported or exported
  geometry.
- Scalar fields are signed distances: negative inside material, positive
  outside, extracted at iso 0. Marching cubes emits outward-facing winding.
- Never compare floats with exact equality; use the tolerance helpers
  appropriate to each algorithm's scale.
- Project files are schema `openlattice3d-project` version 3 (v2 migrates to
  compatibility seed 0; parameter-only JSON stays importable). Imported values
  are sanitized; out-of-range entries are dropped with warnings.
- Generation is deterministic: a versioned Mulberry32 seed with hashed
  substreams; tile merge order and worker count must not change output. Never
  draw from ambient randomness (`Math.random`, timestamps) in generation.

## Gotchas

- `npm run build` and `npm run deploy` run the test suite first via npm
  `pre*` hooks.
- Tests are colocated `*.test.ts` plus `src/**/__tests__/`; geometry tests run
  marching cubes at production resolutions, hence the 60s timeout.
- Dev, preview, and production all send COOP/COEP isolation headers; third-
  party embeds that cannot opt in must stay external links.
- Models never leave the browser. Do not add telemetry, upload endpoints, or
  third-party model handling.
