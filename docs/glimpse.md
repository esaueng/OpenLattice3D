# Glimpse analytics

OpenLattice3D connects a consent-gated adapter to [Glimpse](https://github.com/esaueng/glimpse), matching the two-level design used by OpenZCAD and OpenFEA. Model processing, validation and generation remain browser-local. No model upload, third-party script, identifier, queue, retry or raw-event store is added.

## Optional browser analytics

**Project menu (⋯ in the top bar) → Privacy & data → Allow optional usage analytics** is unchecked by default and available before loading a model. It stores only a consent version under `openlattice3d.glimpse.consent.v1` on this origin (the key name is historical). It is separate from projects, viewer preferences and other apps. Refusal has no effect on use. DNT/GPC suppress every send while leaving a saved grant visible and withdrawable.

### Consent versions

| Stored value | Notice | Covers |
| --- | --- | --- |
| `granted-v1` | The original notice (no longer offered) | Only the [original events](#original-events) |
| `granted-v2` | The current notice, in `src/components/analytics-notice.ts` | The original events and the [targeted subset](#targeted-subset-glimpse-adr-0001) |

Checking the box always saves `granted-v2`, next to the current notice. An existing `granted-v1` choice is never upgraded: it keeps covering only the original events, and the subset is not sent under it. The Privacy & data section shows such a person the updated notice, says their earlier choice covers only the original counts, and offers **Allow updated analytics**. That is the only place it is asked: no pop-up, badge or reminder. Unchecking withdraws either version.

Unchecking cancels pending sends, clears this page's report counts and stops future sends immediately; every send rechecks storage first. Other open tabs follow saved changes and storage clears, and a change from `granted-v2` back to `granted-v1` (for example from a tab still running an older version) cancels only pending subset sends. Failed storage access fails closed; a failed withdrawal retains a safety block for that page and tells the user to clear site storage before reloading. Already-received anonymous counts cannot be attributed to a person for deletion. No pending events are replayed after a grant.

### Original events

`workspace_opened`, `export_completed`, `export_failed`, `generation_completed`, `generation_failed` and `operation_latency`, under either grant. Workspace opens require consent already saved at workspace mount. Generation outcomes count normal single-run lattice generation, including worker-start failures and empty meshes; validation is separate, and cancellations, stale callbacks and comparison previews do not count. Mesh exports (STL, 3MF, OBJ) and project JSON saves count after the browser download helper succeeds; this does not prove the user saved a file to disk. Durations use only `<100ms`, `100ms–1s`, `1–10s`, `10–60s`, `≥60s` buckets. Totals represent opted-in browsers' operations, never users, sessions or adoption.

### Targeted subset (Glimpse ADR 0001)

Only under `granted-v2`, and only the values Glimpse's `LATTICE_EXPANDED` allows (mirrored in `src/glimpse-contract.ts`). Every value is a fixed string decided in the browser; error text, stacks, file names, exact sizes or counts and GPU names are never sent.

| Event | Buckets | Sent when |
| --- | --- | --- |
| `error_runtime` | `none` | An uncaught page error or unhandled promise rejection |
| `error_import` | `none` | Opening an STL, a project or a parameter file fails (including too-large files and files without usable parameters) |
| `error_export` | `none` | An STL, 3MF or OBJ export, or a project JSON save, throws (alongside v1 `export_failed`) |
| `error_storage` | `none` | Saving or restoring the local project state (localStorage or IndexedDB) fails. A browser without storage is not a failure |
| `error_render` | `none` | The 3D viewport throws while rendering (for example, WebGL unavailable). A boundary now keeps the panels usable and shows a **Try again** message |
| `error_unresponsive` | `none` | The main-thread watchdog sees a heartbeat 5 s or more late while the tab is visible |
| `error_gpu_lost` | `none` | A mounted viewer canvas loses its WebGL context. The loss React Three Fiber forces on unmount is ignored |
| `error_out_of_memory` | `none` | An error at a known site is a browser allocation failure (`Array buffer allocation failed`, `Out of memory`): exports, validation start, generation, tile, validation and import workers, uncaught errors. The app's own generation budget is not counted |
| `error_worker` | `none` | A generation, tile, surface-sampling, validation, import or multiview worker crashes, returns an unreadable or malformed response, or cannot be created or posted to |
| `export_latency` | the five timing ranges | Each completed mesh export or project save |
| `project_size` | `lt_1mib`, `1_10mib`, `10_100mib`, `gte_100mib` | Each completed project JSON save, from the file's byte size |
| `feature_category` | `create`, `import`, `export`, `measure` | A lattice generation completes (`create`); a model, project or parameter file is applied (`import`); an export or project save completes (`export`); validation of a generated lattice completes (`measure`) |
| `lattice_cells` | `lt_1k`, `1k_10k`, `10k_100k`, `gte_100k` | Each completed single-run generation |

`feature_category` `other` is accepted by Glimpse but has no site here and is never sent. The cell count is an estimate: whole unit cells spanning the model's bounding box at the run's cell size, at least one per axis, with shell, keep-in regions and the part's shape not subtracted. It is computed when the run starts, so mid-run edits do not change it, and only its range is sent. Comparison previews (multiview) send only worker-failure causes, never outcomes, categories or sizes.

Each diagnostic code counts at most once a minute per page, so a failing loop cannot flood. One failure can produce several signals (for example `generation_failed`, `error_worker` and `error_out_of_memory`). Worker-side failure causes travel to the page as a fixed `diagnostic` field (`worker` or `out_of_memory`) on the worker's own error or progress message; any other value is ignored or rejected as malformed. The watchdog runs only while `granted-v2` is saved, ignores hidden tabs (their timers are throttled) and restarts its interval when a tab becomes visible again; a device that sleeps while the tab stays visible could still be counted.

### Local diagnostic report

Under `granted-v2`, **Download diagnostic report** saves `openlattice3d-glimpse-report.json`: `{"schema":2,"app":"openlattice3d","rows":[{"event","bucket","count"}]}` with this page's subset counts only (at most 128 rows). It has no timestamps, IDs, order, URLs or error text, is never uploaded, and the person can inspect it before sharing it themselves. Glimpse's protected dashboard opens it locally with `parseReport`. The counts live only in page memory and are cleared on withdrawal, on a cross-tab downgrade and on reload.

### Relay

The client posts exactly `{event,bucket}` to `/api/glimpse/usage`, omitting credentials and referrer. The Worker requires POST, same Origin, JSON, at most 256 streamed bytes, and exactly two allowlisted fields (an original event or a targeted-subset value). It cannot verify browser consent: a custom client can send allowed values, as for every app. A limiter uses one constant key, capped at 120 requests/minute per Cloudflare rate-limit location; it never derives a key from IP. This is best effort, and allowed events can be spoofed. The Worker constructs a new `{level:'optional',event,bucket}` RPC with no forwarded metadata. A Glimpse deployed before ADR 0001 rejects subset events; the relay then answers 204 and drops them (nothing is retried), while a rejected original event still answers 503. It does not forward names, URLs, geometry, seeds, filenames, counts, timestamps, user/account data or error text.

## Basic server counters

`GLIMPSE_BASIC_ENABLED` independently gates backend API request/error/coarse-duration counts. Health endpoints, static assets and the optional relay are excluded. There is no geometry API today, so Basic does not measure local work or workspace opens; only Worker-handled non-telemetry `/api/` traffic can count (currently 404 responses). Health contracts are unchanged. Neither deployment switch grants optional browser consent.

## Rollout and rollback

Production enables both `GLIMPSE_BASIC_ENABLED` and `GLIMPSE_USAGE_ENABLED` and binds `GLIMPSE` to `OpenLattice3DIngest`. Browser consent remains off by default and is required independently of these deployment switches. Activation prerequisites:

1. Deploy Glimpse with the ADR 0001 allowlist (esaueng/glimpse#32) before this adapter; older Glimpse versions reject and drop the subset.
1. Review Glimpse's [privacy limits](https://github.com/esaueng/glimpse/blob/main/docs/PRIVACY.md): intended audience, notices, lawful basis, infrastructure metadata/logging/backups and retention. Transport necessarily processes IP/headers at the edge; do not promise no IP processing anywhere. Existing infrastructure logging is separate from these aggregates.
2. With separate production authorization, apply Glimpse's `0002_openlattice3d.sql` migration and deploy its `OpenLattice3DIngest` entrypoint. Glimpse stores only daily aggregates, expires reads after 90 UTC days and deletes expired rows via cron; Access protects the dashboard.
3. Keep the fixed service binding below, regenerate types with `npx wrangler types --strict-vars false`, and deploy. Preview and self-hosted configurations remain disabled unless deliberately configured.
4. Enable each switch only after review. Optional additionally requires each browser's explicit consent. Verify no sends without consent, saved grants, no subset sends under `granted-v1`, the in-menu re-ask, DNT/GPC, two-tab withdrawal, pending-send cancellation, generation/export outcomes and isolated third-app counts on the protected dashboard.

```json
{"binding":"GLIMPSE","service":"glimpse","entrypoint":"OpenLattice3DIngest"}
```

Production activation is authorized; the existing collector and migrations must be verified before rollout. Set both switches back to `false` and redeploy to stop collection; users can also withdraw independently. Missing bindings, collector outages and blocked storage must leave geometry operations usable. On static-only hosting the control can save a preference, but collection needs a configured Worker relay; Vite dev does not provide it.

## Validation

Typecheck, ESLint, full Vitest suite and production build run locally. Focused regressions cover default-off, both consent versions (a `granted-v1` choice never sends or reports the subset and is not upgraded), grants, DNT/GPC, withdrawal and failed persistence, cross-tab changes, synchronous/asynchronous transport failure, bounded pending sends, fixed event payloads, range edges, each subset trigger with fakes (failure sites, worker and allocation causes, context loss and unmount, watchdog and hidden tabs, diagnostic cooldown, local report), same-origin relay validation, subset allowlist and older-Glimpse rejection, streamed limits, rate limiting, flags and failure containment. Generation/export lifecycle tests verify success/failure/cancellation semantics without forwarding private inputs. `wrangler deploy --dry-run` checks Worker configuration and assets without publishing. Hosted CI and real production delivery remain separate verification steps.

Chrome QA passed against the local Worker: unchecked default, opt-in persistence after reload, two-tab withdrawal and the 390×844 Inspect-tab consent control. The final Worker page showed no console errors/warnings. Deployment switches were false and no collector was bound; real production delivery remains unverified. Vite-only testing was used first, then the Worker server verified the actual disabled relay. The dashboard's third-app labels and filter were separately checked using synthetic local fixtures. That QA predates consent version 2: the re-ask for `granted-v1` choices, the report download, the viewport fallback and the subset triggers are covered by unit tests only and still need browser QA.
