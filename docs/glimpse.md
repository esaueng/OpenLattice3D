# Glimpse analytics

OpenLattice3D connects a consent-gated adapter to [Glimpse](https://github.com/esaueng/glimpse), matching the two-level design used by OpenZCAD and OpenFEA. Model processing, validation and generation remain browser-local. No model upload, third-party script, identifier, queue, retry or raw-event store is added.

## Optional browser analytics

**Project menu (⋯ in the top bar) → Privacy & data → Allow optional usage analytics** is unchecked by default and available before loading a model. It stores only `granted-v1` under `openlattice3d.glimpse.consent.v1` on this origin. It is separate from projects, viewer preferences and other apps. Refusal has no effect on use. DNT/GPC suppress sends while leaving a saved grant visible and withdrawable.

Unchecking cancels pending sends and stops future sends immediately. Other open tabs follow saved changes and storage clears. Failed storage access fails closed; a failed withdrawal retains a safety block for that page and tells the user to clear site storage before reloading. Already-received anonymous counts cannot be attributed to a person for deletion. No pending events are replayed after a grant.

The only events are `workspace_opened`, `export_completed`, `export_failed`, `generation_completed`, `generation_failed` and `operation_latency`. Workspace opens require consent already saved at workspace mount. Generation outcomes count normal single-run lattice generation, including worker-start failures and empty meshes; validation is separate, and cancellations, stale callbacks and comparison previews do not count. Mesh exports (STL, 3MF, OBJ) and project JSON saves count after the browser download helper succeeds; this does not prove the user saved a file to disk. Durations use only `<100ms`, `100ms–1s`, `1–10s`, `10–60s`, `≥60s` buckets. Totals represent opted-in browsers' operations, never users, sessions or adoption.

The client posts exactly `{event,bucket}` to `/api/glimpse/usage`, omitting credentials and referrer. The Worker requires POST, same Origin, JSON, at most 256 streamed bytes, and exactly two allowlisted fields. A limiter uses one constant key, capped at 120 requests/minute per Cloudflare rate-limit location; it never derives a key from IP. This is best effort, and allowed events can be spoofed. The Worker constructs a new `{level:'optional',event,bucket}` RPC with no forwarded metadata. It does not forward names, URLs, geometry, seeds, filenames, counts, timestamps, user/account data or error text.

## Basic server counters

`GLIMPSE_BASIC_ENABLED` independently gates backend API request/error/coarse-duration counts. Health endpoints, static assets and the optional relay are excluded. There is no geometry API today, so Basic does not measure local work or workspace opens; only Worker-handled non-telemetry `/api/` traffic can count (currently 404 responses). Health contracts are unchanged. Neither deployment switch grants optional browser consent.

## Rollout and rollback

Production enables both `GLIMPSE_BASIC_ENABLED` and `GLIMPSE_USAGE_ENABLED` and binds `GLIMPSE` to `OpenLattice3DIngest`. Browser consent remains off by default and is required independently of these deployment switches. Activation prerequisites:

1. Review Glimpse's [privacy limits](https://github.com/esaueng/glimpse/blob/main/docs/PRIVACY.md): intended audience, notices, lawful basis, infrastructure metadata/logging/backups and retention. Transport necessarily processes IP/headers at the edge; do not promise no IP processing anywhere. Existing infrastructure logging is separate from these aggregates.
2. With separate production authorization, apply Glimpse's `0002_openlattice3d.sql` migration and deploy its `OpenLattice3DIngest` entrypoint. Glimpse stores only daily aggregates, expires reads after 90 UTC days and deletes expired rows via cron; Access protects the dashboard.
3. Keep the fixed service binding below, regenerate types with `npx wrangler types --strict-vars false`, and deploy. Preview and self-hosted configurations remain disabled unless deliberately configured.
4. Enable each switch only after review. Optional additionally requires each browser's explicit consent. Verify no sends without consent, saved grants, DNT/GPC, two-tab withdrawal, pending-send cancellation, generation/export outcomes and isolated third-app counts on the protected dashboard.

```json
{"binding":"GLIMPSE","service":"glimpse","entrypoint":"OpenLattice3DIngest"}
```

Production activation is authorized; the existing collector and migrations must be verified before rollout. Set both switches back to `false` and redeploy to stop collection; users can also withdraw independently. Missing bindings, collector outages and blocked storage must leave geometry operations usable. On static-only hosting the control can save a preference, but collection needs a configured Worker relay; Vite dev does not provide it.

## Validation

Typecheck, ESLint, full Vitest suite and production build run locally. Focused regressions cover default-off, grants, DNT/GPC, withdrawal and failed persistence, cross-tab changes, synchronous/asynchronous transport failure, bounded pending sends, fixed event payloads, same-origin relay validation, streamed limits, rate limiting, flags and failure containment. Generation/export lifecycle tests verify success/failure/cancellation semantics without forwarding private inputs. `wrangler deploy --dry-run` checks Worker configuration and assets without publishing. Hosted CI and real production delivery remain separate verification steps.

Chrome QA passed against the local Worker: unchecked default, opt-in persistence after reload, two-tab withdrawal and the 390×844 Inspect-tab consent control. The final Worker page showed no console errors/warnings. Deployment switches were false and no collector was bound; real production delivery remains unverified. Vite-only testing was used first, then the Worker server verified the actual disabled relay. The dashboard's third-app labels and filter were separately checked using synthetic local fixtures.
