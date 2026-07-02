# Implementation plans — OpenLattice3D

Produced by a codebase audit on **2026-07-01** against commit **`2af138a`** (branch `main`).
Effort level: `standard` (hotspot-weighted; all nine audit categories). Each plan is written to be executed by a separate agent/model with **zero context from the audit session** — everything needed is in the plan file.

**Selection note:** the audit ran non-interactively, so per the default policy the top 5 findings by leverage were planned. The remaining vetted findings are listed below under "Unplanned findings" and can be turned into plans on request.

## Execution order and status

| # | Plan | Depends on | Effort | Status |
|---|------|-----------|--------|--------|
| 001 | [Test + CI baseline](001-test-ci-baseline.md) — vitest, characterization tests for `src/geometry`, GitHub Actions | — | M | TODO |
| 002 | [STL import robustness](002-stl-import-robustness.md) — bounds-check binary headers, fix `solid`-prefixed binary fallback, BVH empty-mesh guards | **001 (hard)** | S–M | TODO |
| 003 | [Sanitize imported params](003-sanitize-imported-params.md) — clamp/whitelist JSON-imported and localStorage-persisted `LatticeParams` | 001 (soft) | S | TODO |
| 004 | [Throttle progress updates](004-throttle-progress-updates.md) — rate-limit worker progress messages, stop logging every one | 001 (soft) | S | TODO |
| 005 | [Dispose viewer geometries](005-dispose-viewer-geometries.md) — `BufferGeometry.dispose()` on swap in `Viewer3D.tsx` | — | S | TODO |

Recommended order: **001 first** (it is the verification gate every other plan uses), then 002–005 in any order (they touch disjoint code except a trivial import-line overlap between 002 and 003 in `LeftPanel.tsx`).

Executors: update the Status column (TODO → IN PROGRESS → DONE / BLOCKED, with a short note) when you work a plan.

## Vetted findings (audit summary)

Every row was verified by direct code reading, not just reported by a subagent. Verification signals at `2af138a`: `npx tsc --noEmit -p tsconfig.app.json` clean, `npx eslint .` clean, `npm audit` = 9 vulns (5 high) all in dev-only tooling.

| # | Finding | Category | Impact | Effort | Risk | Conf. | Evidence | Plan |
|---|---------|----------|--------|--------|------|-------|----------|------|
| 1 | No tests, no CI, no test script; ~2.7k lines of pure geometry math unguarded | tests/dx | Every change to the engine is unverifiable; regressions ship silently | M | low | HIGH | no `test` script in `package.json`; no `*.test.*` under `src/`; no `.github/` | 001 |
| 2 | `solid`-prefixed **binary** STLs (common in the wild) silently import as 0-triangle meshes when the exact-size check misses; ASCII fallback never throws | correctness | Users' real parts import as blank models | S | low | HIGH | `src/geometry/stl-parser.ts:16-31` (fallback), `:54-83` (ASCII returns empty, no throw) | 002 |
| 3 | Binary STL header `triCount` unvalidated → multi-GB allocation attempts / cryptic `RangeError`; buffers <84 B throw | correctness/security | Malformed/truncated upload → cryptic failure or memory spike | S | low | HIGH | `src/geometry/stl-parser.ts:35-37`; caught-but-cryptic at `src/components/LeftPanel.tsx:51-53` | 002 |
| 4 | `MeshBVH.signedDistance` returns garbage (±Infinity path) when `closestPoint` finds no triangle (empty mesh) | correctness | Empty mesh reaching generation produces silent nonsense instead of an error | S | low | HIGH | `src/geometry/bvh.ts:398` (`bestTri = -1`), `:450-461` (negative index into normals) | 002 |
| 5 | Imported project-JSON params and persisted localStorage params applied with no range/type validation (`exportResolution: 1e6` → tab OOM/freeze; `cellSize: 0` → NaN fields) | security/correctness | DoS-by-file on a public app; corrupt localStorage breaks boot | S | low | HIGH | `src/components/LeftPanel.tsx:62-91`, `src/store/useStore.ts:324`, `:537-538`, `src/hooks/useLatticeGeneration.ts:93` | 003 |
| 6 | ~290 progress postMessages per generation, each `addLog`ged and store-`set`; `LeftPanel` subscribes to the whole store → hundreds of large re-renders + log spam | performance | UI jank during generation; log panel unusable | S | low | HIGH | `src/workers/lattice-worker.ts:1411-1430`, `src/geometry/marching-cubes.ts:264-319`, `src/hooks/useLatticeGeneration.ts:184-186`, `src/store/useStore.ts:490,533-535`, `LeftPanel.tsx:19` | 004 |
| 7 | `THREE.BufferGeometry` created in `useMemo` never disposed on swap → GPU memory grows across regenerations/selection paints | performance | VRAM growth until tab reload in tune-regenerate workflows | S | low | HIGH | `src/components/Viewer3D.tsx:389-407, 416-429, 434-439, 484-489`; zero `dispose` in file | 005 |

### Unplanned findings (vetted, not planned — ask to plan any of them)

| Finding | Category | Impact/Effort | Evidence |
|---------|----------|---------------|----------|
| 9 dev-dependency vulns (5 high: vite dev server, miniflare, ws, undici). Dev-time exposure only; `npm audit fix` resolves within semver | dependencies | S | `npm audit` 2026-07-01 |
| README drift: 12 lattice types implemented, 2 documented; 5 sample shapes vs 1 mentioned; Architecture tree omits `backend/`, `hooks/`, `assets/`, 3 workers, 2 components, 2 utils | docs | S — users/contributors can't discover features | `src/types/project.ts:5-17`, `src/geometry/lattice.ts:66-416`, `README.md:104-128` |
| Whole-store zustand subscriptions (`const store = useStore()`) re-render large components on any state change | performance | M — selector migration, needs care | `src/components/LeftPanel.tsx:19` et al. |
| No `worker.onerror` on the generation worker (load failures leave UI in "generating") | correctness | S — one handler | `src/hooks/useLatticeGeneration.ts:181-211` |
| `lattice.ts` locally redefines `cross`/`normalize`/`dot` that `vec3.ts` exports (divergent zero-vector fallback) | tech-debt | S — but mind the `[0,0,1]` fallback semantics | `src/geometry/lattice.ts:285-301` vs `src/geometry/vec3.ts:17-37` |
| `@types/three` in `dependencies` instead of `devDependencies` | dependencies | S, cosmetic | `package.json:17` |
| eslint flat config covers only `**/*.{ts,tsx}` — `scripts/*.mjs` unlinted; `noUnusedLocals`/`noUnusedParameters` off in app tsconfig | dx | S | `eslint.config.js:11`, `tsconfig.app.json` |
| `lattice-worker.ts` (1,466 lines) and `Viewer3D.tsx` (1,473 lines) monoliths | tech-debt | L, **high risk — only after 001 lands and stabilizes** | file sizes; mixed responsibilities |
| All git commits titled "update" | dx | Forward-only fix (commit convention); history rewrite not advised | `git log --oneline` |
| Residual param risk: UI number inputs don't enforce `min`/`max` on typed values | correctness | S — decide desired UX first | `LeftPanel.tsx:248-350` (browser behavior) |

### Considered and rejected (do not re-audit these)

- **`public/_headers` "syntax error / unclosed comment"** — false: `/*` is the Cloudflare path-matcher glob, not a comment. File is correct and matches README's COOP/COEP claim.
- **Plausible analytics blocked by COEP** — false: verified live 2026-07-01 that `plausible.io` serves `cross-origin-resource-policy: cross-origin`; the script loads under `require-corp`.
- **ReDoS in the ASCII STL regex** (`stl-parser.ts:56`) — the character classes are disjoint from the `\s+` separators; no nested ambiguous quantifiers → linear-ish scan, no catastrophic backtracking. (Non-finite number acceptance is real and handled in plan 002.)
- **Tiled generation runs serially** — false: `runTiledGeneration` (`lattice-worker.ts:909-977`) runs a work-stealing pool of up to `MAX_TILE_WORKERS = 8` parallel workers.
- **WASM/WebGPU scaffolds as dead code** — by design: intentionally disabled scaffolds documented in `docs/performance/*.md`.
- **`worker/index.ts` 404-only handler** — intentional; Cloudflare static assets serve the site.
- **tsBuildInfo under `node_modules/.tmp`** — Vite template default; harmless.

### Not audited

`dist/` (build output), `public/assets/*.stl` (binaries), `node_modules/`, visual/rendering correctness of the three.js scene (no browser-based inspection), WASM/WebGPU scaffold internals (disabled by design), and no runtime profiling was performed — performance findings are code-evidence-based.

## Direction (options for the maintainer, not ranked against the bugs)

1. **Complete the project save/load round-trip.** Export writes `meshAssetName`, `selectionMask` (keep-out/keep-in triangle indices), params, and validation (`src/utils/export.ts:47-71`), but import applies **params only** (`LeftPanel.tsx:69-84`) — selections and the mesh reference are silently dropped. Restoring selections + prompting for the matching STL would make projects genuinely portable. Effort ~M; touches import flow + store.
2. **Surface the 10 undocumented lattice types.** Twelve SDFs are implemented and selectable (`lattice.ts`, `types/project.ts:5-17`) but README markets two. A README/UI pass (type descriptions, which are sheet vs strut, recommended processes) is cheap and is effectively free product surface. Effort S.
3. **Promote WebGPU Phase A per your own roadmap.** `docs/performance/webgpu-backend.md` defines the phases; Phase A (GPU field sampling for sample shapes) is implemented but hard-disabled (`ENABLE_WEBGPU_FIELD_CPU_MC = false`, `lattice-worker.ts:31`). After plan 001 lands, an experimental user-facing toggle + the fallback tests the doc itself calls for would start collecting real-world signal. Effort M (spike-shaped).
4. **Consider 3MF export alongside STL.** Marching cubes emits triangle soup; STL stores it verbatim (large files at high resolutions). 3MF (zipped XML, indexed vertices, units metadata) typically shrinks exports several-fold and carries the mm unit explicitly — relevant to the app's SLS/MJF/SLA audience. Effort M; pure addition in `src/utils/export.ts`.
