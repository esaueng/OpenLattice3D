# Plan 004 — Throttle generation progress messages and stop logging every one of them

- **Status:** TODO — scope reduced 2026-07-02: PR #14 (`903b1c6`) fixed the re-render half (selector-based zustand subscriptions), so this plan's "Why" overstates the render cost at HEAD. Still real: the worker posts unthrottled per-slice progress and `useLatticeGeneration.ts:186` still logs every message (~300 log entries per generation). The worker-side reporter + `transient` flag remain the deliverable. **Line numbers below are stale — follow the drift protocol.**
- **Written against commit:** `2af138a` (branch `main`). Run `git rev-parse --short HEAD`; if different, `git diff 2af138a -- src/workers/lattice-worker.ts src/hooks/useLatticeGeneration.ts` and re-read the cited regions.
- **Depends on:** Plan 001 (vitest). Independent of plans 002/003/005.

## Why this matters

During generation, the lattice worker posts a progress message **per z-slice per pass** of marching cubes. `marchingCubesRectangular` fires its `onProgress` callback in three loops (field sampling `src/geometry/marching-cubes.ts:264-265`, triangle counting `:304-305`, emission `:318-319`). At the default quality setting the grid resolution is 96 (`Math.round(24 + exportResolution * 24)` with `exportResolution = 3`, `src/hooks/useLatticeGeneration.ts:93`), so a single generation produces roughly **290 progress postMessages**, each carrying a fresh message string.

On the main thread, `worker.onmessage` (`src/hooks/useLatticeGeneration.ts:184-186`) does this for every one:

```ts
      if (resp.type === 'progress') {
        current.setProgress(resp.progress || 0, resp.message || '');
        if (resp.message) current.addLog(resp.message);
      }
```

`setProgress` is a zustand `set` (`src/store/useStore.ts:490`), and `addLog` copies the log array every call (`src/store/useStore.ts:533-535`):

```ts
  addLog: (message, level = 'info') => set((s) => ({
    logs: [...s.logs.slice(-200), { time: Date.now(), message, level }],
  })),
```

Consequences: ~290 store updates + ~290 log-array copies per generation, and because `LeftPanel.tsx:19` subscribes to the whole store (`const store = useStore()`), every one re-renders the 427-line panel (and every other whole-store subscriber). The log panel fills with hundreds of near-identical `Marching cubes: 37% (~12s remaining)` lines, drowning the useful entries.

Fix in two halves: (a) the worker rate-limits its own progress emissions; (b) high-frequency progress messages are marked `transient` and the hook skips `addLog` for them. Milestone messages ("BVH built", "Geometry ready", the time estimate, fragment removal, backend notes) stay logged.

## Current state (verified excerpts at `2af138a`)

The hot emitter — `src/workers/lattice-worker.ts:1411-1430`:

```ts
      const rawResult = marchingCubes(sdfWithThinFilter, bounds, resolution, 0, (frac) => {
        if (cancelled) throw new Error('Cancelled');
        const overallProgress = 0.1 + frac * 0.7;
        const elapsedSeconds = (performance.now() - generationStart) / 1000;
        const marchElapsedSeconds = Math.max(0, elapsedSeconds - preSecondsActual);
        if (frac > 0.02) {
          const dynamicMarchTotal = marchElapsedSeconds / frac;
          smoothedMarchSeconds = smoothedMarchSeconds * 0.7 + dynamicMarchTotal * 0.3;
        }
        const remainingSeconds = Math.max(
          0,
          preSecondsActual + smoothedMarchSeconds - elapsedSeconds
        );
        estimateLabel = formatDuration(remainingSeconds);
        postMessage({
          type: 'progress',
          progress: overallProgress,
          message: `Marching cubes: ${Math.round(frac * 100)}% (~${estimateLabel} remaining)`
        } as WorkerResponse);
      });
```

There are other high-frequency emitters in the same file — find them all with `grep -n "postMessage" src/workers/lattice-worker.ts` and classify each: anything invoked from inside an `onProgress`-style callback (the marching-cubes callback above, the tiled-generation `onProgress` around lines 1335-1360, the imported-mesh SDF progress around lines 1206-1310 if it reports per-slice, and the demo-grid loop around lines 1007-1130) is high-frequency; one-shot phase messages ("Building BVH...", "Estimated generation time...", "Geometry ready") are milestones. **Read each call site before classifying — do not classify by string content alone.**

`WorkerResponse` is defined at `src/workers/lattice-worker.ts:115-125` (fields: `type, progress?, message?, positions?, ...`).

The `cancelled` check (`if (cancelled) throw new Error('Cancelled')`) **must keep running on every callback invocation** — it is the cancellation mechanism. Only the postMessage gets rate-limited.

## Design

Add a small, unit-testable reporter to the worker file (module scope, near the other helpers at the top):

```ts
export interface ProgressReporter {
  report(progress: number, message: string): void;   // rate-limited, marks transient
  milestone(progress: number, message: string): void; // always sent, logged
}

export function createProgressReporter(
  post: (resp: WorkerResponse) => void,
  now: () => number = () => performance.now(),
  minIntervalMs = 100,
  minDelta = 0.02
): ProgressReporter {
  let lastTime = -Infinity;
  let lastProgress = -Infinity;
  return {
    report(progress, message) {
      const t = now();
      if (t - lastTime < minIntervalMs && progress - lastProgress < minDelta && progress < 1) return;
      lastTime = t;
      lastProgress = progress;
      post({ type: 'progress', progress, message, transient: true });
    },
    milestone(progress, message) {
      lastTime = now();
      lastProgress = progress;
      post({ type: 'progress', progress, message });
    },
  };
}
```

Semantics: a report goes through if EITHER enough time passed OR progress advanced enough; `progress >= 1` always goes through (final frame). Milestones always send and reset the limiter (so a milestone isn't immediately followed by a stale-looking suppressed gap).

And extend the response type (`lattice-worker.ts:115-125`): add `transient?: boolean;` to `WorkerResponse`.

Hook change (`src/hooks/useLatticeGeneration.ts:184-186`):

```ts
      if (resp.type === 'progress') {
        current.setProgress(resp.progress || 0, resp.message || '');
        if (resp.message && !resp.transient) current.addLog(resp.message);
      }
```

(`setProgress` still runs for every delivered message — after worker-side throttling that is ≤ ~10/second, which is fine for the progress bar.)

## Steps

### Step 1 — Reporter + unit tests

1. Add `transient?: boolean` to `WorkerResponse` and implement `createProgressReporter` in `src/workers/lattice-worker.ts` as above. Export both (the interface can stay unexported if lint complains about unused exports — the factory must be exported for tests).
2. Create `src/workers/progress-reporter.test.ts` importing `createProgressReporter` from `./lattice-worker`.

**Caution:** importing the worker module in Node executes its top level, which at `2af138a` includes `self.postMessage.bind(self)` at line 24 — `self` is undefined in Node and the import will throw. Handle this the simple, explicit way: move `createProgressReporter` (and the `WorkerResponse` interface if needed) into a new file `src/workers/progress-reporter.ts` with **no imports from the worker**, and have `lattice-worker.ts` import from it. Test the new file instead. (Vitest's `environment: 'node'` from plan 001 makes the standalone module trivially importable. Do NOT try to shim `self`.)

Tests (inject a fake clock — `let t = 0; const now = () => t;`):
- First `report(0.01, 'a')` at t=0 → posted.
- `report(0.015, 'b')` at t=50 (Δt < 100, Δp < 0.02) → suppressed.
- `report(0.05, 'c')` at t=60 (Δp ≥ 0.02) → posted.
- `report(0.051, 'd')` at t=200 (Δt ≥ 100) → posted.
- `report(1, 'done')` immediately after → posted (final-frame rule).
- `milestone(0.5, 'phase')` always posts, with `transient` undefined/false; a `report` immediately after at the same progress/time → suppressed.
- Posted `report` payloads have `transient: true`; milestone payloads do not.

Verify: `npx vitest run src/workers/progress-reporter.test.ts` → green.

### Step 2 — Wire the reporter into the worker

In `src/workers/lattice-worker.ts`, inside the `generate` handler (the `try` starting at line 991):

1. Create one reporter per generation: `const reporter = createProgressReporter((resp) => postMessage(resp));` near `generationStart` (line 992).
2. Convert the **high-frequency** call sites (classified via the grep in "Current state") to `reporter.report(overallProgress, message)`. For the marching-cubes callback (1411-1430): keep the `cancelled` throw and the `smoothedMarchSeconds` estimate math exactly as-is — only the trailing `postMessage({...})` becomes `reporter.report(overallProgress, \`Marching cubes: ...\`)`. (The string template is still built per call; that is acceptable — do not micro-optimize it in this plan.)
3. Convert the **milestone** call sites to `reporter.milestone(progress, message)` — or leave them as raw `postMessage`; prefer `milestone` so the limiter state stays coherent. The `type: 'result'` and `type: 'error'` posts are untouched.
4. The tiled path's `onProgress` (`runTiledGeneration` callback, used around lines 1335-1360) and the demo-grid per-tile progress: convert to `reporter.report(...)` as well, keeping any per-tile completion messages that are genuinely few (≤ ~16 tiles → those may stay milestones; per-slice ones must be `report`). Judge by frequency: anything that can fire more than ~30 times per generation is `report`.

Verify: `npm run typecheck && npm run lint` → 0.

### Step 3 — Hook change

Apply the one-line change in `src/hooks/useLatticeGeneration.ts` shown in Design. Also check `validationWorker.onmessage` (lines 155-170) — validation progress messages are low-frequency at `2af138a` (verify with `grep -n "postMessage" src/workers/validation-worker.ts` — if any fire per-sample/per-slice, note it in your report but leave validation-worker changes out of scope).

Verify: `npm run typecheck && npm run lint` → 0.

### Step 4 — Full verification + manual check

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

Manual (required — this plan's effect is behavioral): `npm run dev`, open http://127.0.0.1:5176, click "Ball Demo", then "Generate Lattice". Confirm:
- The progress bar still advances smoothly (updates at least ~5×/sec during marching).
- The activity log gains **fewer than ~30 new lines** for the whole generation (was ~300): estimate line, phase lines, completion, validation — but NOT a line per percent.
- Cancel mid-generation still works (click Cancel during marching → "Generation cancelled" appears, UI returns to idle).

## Done criteria (machine-checkable)

1. Reporter unit tests pass (7 assertions above); full `npm test` green.
2. `grep -c "reporter.report" src/workers/lattice-worker.ts` ≥ 2 and `grep -n "postMessage({" src/workers/lattice-worker.ts | wc -l` shows the remaining raw posts are only: result, error, and milestone-converted-or-kept sites (list them in your report).
3. `grep -n "transient" src/hooks/useLatticeGeneration.ts` shows the addLog guard.
4. `npm run typecheck`, `npm run lint`, `npm run build` exit 0.
5. Diff touches only: `src/workers/lattice-worker.ts`, `src/workers/progress-reporter.ts` (new), `src/workers/progress-reporter.test.ts` (new), `src/hooks/useLatticeGeneration.ts`.

## Out of scope — do not touch

- Store subscription hygiene (`const store = useStore()` whole-store subscriptions in `LeftPanel.tsx:19` and elsewhere) — a bigger, separate change; recorded in `plans/README.md` as an unplanned finding.
- `src/geometry/marching-cubes.ts` — its callback cadence is fine once the worker throttles.
- `surface-sample-worker.ts`, `validation-worker.ts` (observe-and-report only, per step 3).
- The estimate-smoothing math and `formatDuration`.
- Log persistence/debounce in `useStore.ts` (already debounced at `useStore.ts:656-665`).

## Maintenance note

Anyone adding a new long-running phase to the worker should route per-iteration progress through `reporter.report` and phase boundaries through `reporter.milestone`. The 100 ms / 2 % constants are UI-feel parameters; if the progress bar ever looks chunky on very fast machines, lower `minIntervalMs` — do not remove the final-frame rule (`progress >= 1` always sends) or completion can appear to hang at 98 %.

## Escape hatches

- If extracting `createProgressReporter` to its own module creates an import cycle (it shouldn't — it must import nothing from the worker; define a minimal local response type or import the type with `import type`), STOP and restructure only the reporter, not the worker.
- If after step 2 the progress bar visibly stalls (e.g. the imported-mesh SDF phase reports through a path you didn't find), re-run the grep classification; if a stall persists and you cannot find the emitter, STOP and report which phase stalls.
- If cancel stops working after your changes, you removed or moved the `cancelled` throw — restore it; it must execute on every callback, before any rate-limit early-return... i.e. the throw lives in the callback, NOT inside the reporter.
