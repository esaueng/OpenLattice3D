# Plan 003 — Sanitize lattice parameters from JSON import and persisted state

- **Status:** TODO
- **Written against commit:** `2af138a` (branch `main`). Run `git rev-parse --short HEAD`; if different, `git diff 2af138a -- src/types/project.ts src/components/LeftPanel.tsx src/store/useStore.ts` and re-read changed regions before editing.
- **Depends on:** Plan 001 (vitest). Can run in parallel with plans 002/004/005 — it touches `src/types/project.ts`, `src/components/LeftPanel.tsx` (a different function than plan 002 touches), and `src/store/useStore.ts`. If executed concurrently with plan 002 in the same worktree, expect a trivial merge in `LeftPanel.tsx` imports.

## Why this matters

The app accepts `LatticeParams` values from two untrusted sources and applies them with **no type or range validation**:

1. **Project JSON import** — `handleJsonImport` in `src/components/LeftPanel.tsx:62-91` filters unknown keys but not values. A hand-edited or malicious project file with `{"exportResolution": 1000000}` passes the filter. Generation then computes `resolution = Math.round(24 + exportResolution * 24)` (`src/hooks/useLatticeGeneration.ts:93`) and the worker allocates a `(resolution+1)³` Float32Array — multi-gigabyte allocations that freeze or crash the tab (values in the hundreds allocate successfully and hang the machine; huge values throw a cryptic RangeError). Non-numeric values (`"cellSize": "abc"`) or `cellSize: 0` produce NaN fields and garbage output.
2. **Persisted localStorage state** — `loadLegacyPersistedState` (`src/store/useStore.ts:81-90`) `JSON.parse`s localStorage and the result is merged into live params at `useStore.ts:324`: `params: persisted?.params ? { ...DEFAULT_PARAMS, ...persisted.params } : ...`. Corrupt or manually edited localStorage yields the same failure modes at every app boot.

The fix: one shared `sanitizeLatticeParams` function applied at both boundaries. UI typing already coerces via `parseFloat(...) || default` and input `min`/`max` attributes; this plan does **not** change live-UI editing behavior.

## Current state (verified excerpts at `2af138a`)

`src/components/LeftPanel.tsx:65-85` (inside `handleJsonImport`):

```ts
      const text = await file.text();
      const data = JSON.parse(text);
      // Support both { parameters: {...} } (project JSON) and plain { latticeType: ... } formats
      const params: Partial<LatticeParams> = data.parameters || data;
      // Validate: only apply known keys from LatticeParams
      const validKeys = Object.keys(DEFAULT_PARAMS) as (keyof LatticeParams)[];
      const filtered: Partial<LatticeParams> = {};
      let count = 0;
      for (const key of validKeys) {
        if (key in params) {
          (filtered as Record<string, unknown>)[key] = params[key];
          count++;
        }
      }
      if (count === 0) {
        store.addLog('JSON import: no valid parameters found', 'error');
        return;
      }
      store.importParams(filtered);
```

`src/store/useStore.ts:324`:

```ts
  params: persisted?.params ? { ...DEFAULT_PARAMS, ...persisted.params } : { ...DEFAULT_PARAMS },
```

`src/store/useStore.ts:537-538` (`importParams`, merges without validation):

```ts
  importParams: (imported) => set((s) => {
    const nextParams = { ...s.params, ...imported };
```

`src/types/project.ts` defines `LatticeParams` (19 fields), `DEFAULT_PARAMS` (lines 81–101), and the enum unions `LatticeType` (12 values, lines 5–17), `GenerationVariant` (`'shell_core' | 'implicit_conformal'`), `ProcessPreset` (`'SLS_MJF' | 'SLA_DLP' | 'FDM'`).

## The sanitizer

Add to `src/types/project.ts` (it already owns the data model and `DEFAULT_PARAMS`; keep its comment-light style):

1. Exported runtime arrays mirroring the unions, type-locked so adding an enum member without updating the array is a compile error:

```ts
export const LATTICE_TYPES = [
  'gyroid', 'schwarzP', 'schwarzD', 'neovius', 'iwp', 'bcc',
  'octet', 'diamond', 'hexagon', 'triangle', 'voronoi', 'spinodal',
] as const satisfies readonly LatticeType[];

export const GENERATION_VARIANTS = ['shell_core', 'implicit_conformal'] as const satisfies readonly GenerationVariant[];
export const PROCESS_PRESETS = ['SLS_MJF', 'SLA_DLP', 'FDM'] as const satisfies readonly ProcessPreset[];
```

(If `satisfies` on a `const` array trips the `erasableSyntaxOnly` compiler option, fall back to `: readonly LatticeType[]` annotations — verify with `npm run typecheck`.)

2. A bounds table and sanitizer:

```ts
// Numeric bounds mirror the UI controls in LeftPanel.tsx. If a UI bound changes, change it here too.
const PARAM_BOUNDS: Record<string, { min: number; max: number; integer?: boolean }> = {
  minFeatureSize:     { min: 0.3,  max: 5 },
  cellSize:           { min: 2,    max: 50 },
  strutDiameter:      { min: 0.3,  max: 5 },
  wallThickness:      { min: 0.3,  max: 5 },
  shellThickness:     { min: 0.3,  max: 10 },
  surfaceDepth:       { min: 1,    max: 50 },
  gradientStrength:   { min: 0,    max: 1 },
  thinSectionFilter:  { min: 0,    max: 5 },
  exportResolution:   { min: 1,    max: 10, integer: true },
  escapeHoleDiameter: { min: 0.5,  max: 20 },
  escapeHoleCount:    { min: 0,    max: 12, integer: true },
  toleranceMm:        { min: 0.05, max: 2 },
};

/** Coerce an untrusted partial params object to safe values. Unknown keys and
 *  un-coercible values are dropped; numbers are clamped to UI bounds. */
export function sanitizeLatticeParams(input: unknown): Partial<LatticeParams> {
  if (typeof input !== 'object' || input === null) return {};
  const raw = input as Record<string, unknown>;
  const out: Partial<LatticeParams> = {};
  const rec = out as Record<string, unknown>;

  for (const key of Object.keys(PARAM_BOUNDS)) {
    if (!(key in raw)) continue;
    const num = typeof raw[key] === 'number' ? raw[key] as number : Number(raw[key]);
    if (!Number.isFinite(num)) continue;
    const b = PARAM_BOUNDS[key];
    const clamped = Math.min(b.max, Math.max(b.min, num));
    rec[key] = b.integer ? Math.round(clamped) : clamped;
  }

  if (LATTICE_TYPES.includes(raw.latticeType as LatticeType)) out.latticeType = raw.latticeType as LatticeType;
  if (GENERATION_VARIANTS.includes(raw.variant as GenerationVariant)) out.variant = raw.variant as GenerationVariant;
  if (PROCESS_PRESETS.includes(raw.processPreset as ProcessPreset)) out.processPreset = raw.processPreset as ProcessPreset;

  for (const key of ['noShell', 'surfaceOnly', 'gradientEnabled', 'escapeHoles'] as const) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }

  return out;
}
```

**Bounds provenance — verify before coding.** These numbers come from the input attributes in `src/components/LeftPanel.tsx` at `2af138a`: cellSize `min={2} max={50}` (line 252), surfaceDepth `min={1} max={50}` (288), shellThickness `min={0.3} max={10}` (301), wallThickness `min={0.3} max={5}` (314), strutDiameter `min={0.3} max={5}` (325), minFeatureSize `min={0.3} max={5}` (337), toleranceMm `min={0.05} max={2}` (348), exportResolution `<select>` options 1–10 (360–368). **You must read `LeftPanel.tsx` lines 240–450 yourself** and (a) confirm these, (b) find the controls for `gradientStrength`, `thinSectionFilter`, `escapeHoleDiameter`, `escapeHoleCount` further down the file and use their actual UI bounds if they differ from the table above. If a param has no UI control, keep the table's conservative bound and add `// no UI control; conservative bound` beside it.

## Steps

### Step 1 — Tests first

Create `src/types/project.test.ts`:

1. `sanitizeLatticeParams({ exportResolution: 1000000 })` → `{ exportResolution: 10 }`.
2. `sanitizeLatticeParams({ cellSize: 0 })` → `{ cellSize: 2 }` (clamped, not dropped).
3. `sanitizeLatticeParams({ cellSize: 'abc' })` → `{}` (dropped).
4. `sanitizeLatticeParams({ cellSize: NaN })` and `{ cellSize: Infinity }` → dropped / clamped-to-max respectively (`Infinity` is not finite → dropped; assert that).
5. `sanitizeLatticeParams({ latticeType: 'gyroid' })` → kept; `{ latticeType: 'evil' }` → dropped.
6. `sanitizeLatticeParams({ noShell: true })` → kept; `{ noShell: 'yes' }` → dropped.
7. Unknown key: `sanitizeLatticeParams({ __proto__: { x: 1 }, hackKey: 5 })` → `{}` and `({}).x === undefined` afterward (no pollution — note `__proto__` in an object literal is inert, this test documents that the output contains only whitelisted keys).
8. Numeric string coercion: `{ cellSize: '8' }` → `{ cellSize: 8 }` (JSON from other tools sometimes stringifies; `Number('8')` handles it).
9. Round-trip: `sanitizeLatticeParams(DEFAULT_PARAMS)` deep-equals `DEFAULT_PARAMS` (every default is within bounds and every key survives). This is the key invariant: **if this fails, your bounds table contradicts the shipped defaults — fix the table, not the defaults.**
10. `sanitizeLatticeParams(null)`, `(undefined)`, `(42)`, `('x')` → `{}`.

Run `npx vitest run src/types/project.test.ts` → red (module doesn't exist yet). Write the sanitizer (previous section) until green.

### Step 2 — Wire into JSON import

In `src/components/LeftPanel.tsx` `handleJsonImport`, replace the manual key-filter block (the `validKeys`/`filtered`/`count` code shown above, lines ~70–83) with:

```ts
      const filtered = sanitizeLatticeParams(data.parameters || data);
      const count = Object.keys(filtered).length;
      if (count === 0) {
        store.addLog('JSON import: no valid parameters found', 'error');
        return;
      }
```

Add `sanitizeLatticeParams` to the existing `import { ... } from '../types/project'` line. `DEFAULT_PARAMS` may become unused in this file — check with `npm run lint` / `npm run typecheck` and remove it from the import only if now unused.

### Step 3 — Wire into persisted-state load

In `src/store/useStore.ts` line 324, change:

```ts
  params: persisted?.params ? { ...DEFAULT_PARAMS, ...persisted.params } : { ...DEFAULT_PARAMS },
```

to:

```ts
  params: { ...DEFAULT_PARAMS, ...sanitizeLatticeParams(persisted?.params) },
```

(`sanitizeLatticeParams` returns `{}` for `undefined`, so the ternary collapses.) Add the import at the top with the other `../types/project` imports. **Check for sibling persisted-param merges:** run `grep -n "persisted" src/store/useStore.ts` and read each hit around lines 300–340 — if demo-mode params (`demoParamsByType` or similar) are also hydrated from `persisted`, sanitize each of those the same way and note it in your report.

### Step 4 — Defense in `importParams`

In `src/store/useStore.ts:537`, change `const nextParams = { ...s.params, ...imported };` to `const nextParams = { ...s.params, ...sanitizeLatticeParams(imported) };`. This makes the store safe regardless of caller. (LeftPanel's own `updateParams` for live UI edits is intentionally untouched — see Out of scope.)

### Step 5 — Verify

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

All exit 0. Manual check: `npm run dev`, open http://127.0.0.1:5176, use the project-JSON import control (LeftPanel "Import JSON") with a file containing `{"exportResolution": 1000000, "cellSize": 0.001, "latticeType": "gyroid"}` → log shows `Imported 3 parameter(s) ...`, Export Resolution shows `10`, Cell Size shows `2`, and clicking Generate completes without freezing the tab.

## Done criteria (machine-checkable)

1. All 10 test groups in `src/types/project.test.ts` pass; whole suite green.
2. `grep -n "sanitizeLatticeParams" src/ -r` shows: definition in `src/types/project.ts`, one use in `LeftPanel.tsx`, two-or-three uses in `useStore.ts` (line 324 + `importParams` + any demo-param hydration found in step 3).
3. Test 9 (defaults round-trip) passes — proving no legitimate default is altered.
4. `npm run typecheck`, `npm run lint`, `npm run build` exit 0.
5. Diff touches only: `src/types/project.ts`, `src/types/project.test.ts`, `src/components/LeftPanel.tsx`, `src/store/useStore.ts`.

## Out of scope — do not touch

- `updateParams` / live UI slider handling in `LeftPanel.tsx` — typing `999` into Cell Size mid-edit is a separate UX question (residual risk, recorded in `plans/README.md`).
- The worker (`src/workers/lattice-worker.ts`) — no server-side-style double validation there in this plan.
- `useLatticeGeneration.ts:93`'s resolution formula.
- The persisted-state *schema* (viewMode, clipPlane, logs, etc.) — only `params` gets sanitized.
- No new dependencies (no zod/valibot — the hand-rolled table is deliberate at this size).

## Maintenance note

`PARAM_BOUNDS` duplicates the UI `min`/`max` attributes by design (the UI file imports from types, not vice versa). The comment above the table tells future editors to keep them in sync; drift fails safe (over-tight clamp) rather than dangerously. If params grow past ~25 fields or need cross-field rules (e.g. `wallThickness < cellSize/2`), revisit with a schema library — cross-field validation is explicitly not implemented here.

## Escape hatches

- If `satisfies` or the `as const` arrays fight the `erasableSyntaxOnly`/`verbatimModuleSyntax` compiler options in a way you can't resolve in two attempts, use plain typed arrays (`const LATTICE_TYPES: readonly LatticeType[] = [...]`) and note the lost exhaustiveness check.
- If `useStore.ts` line 324 doesn't match the excerpt (drift), locate the `params:` initialization inside the store-creation call and apply the same transformation; if you can't find a single obvious site, STOP and report.
- If sanitizing `importParams` breaks a demo-mode test path (demo grid passes internally-generated params through `importParams`), verify the values it passes are within bounds (they should be — they derive from defaults); if not, STOP and report rather than widening bounds.
