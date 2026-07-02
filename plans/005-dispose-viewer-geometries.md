# Plan 005 — Dispose three.js BufferGeometries when the viewer swaps them

- **Status:** TODO
- **Written against commit:** `2af138a` (branch `main`). Run `git rev-parse --short HEAD`; if different, `git diff 2af138a -- src/components/Viewer3D.tsx` and re-read the component before editing.
- **Depends on:** nothing (plan 001 recommended first for CI safety, not required). Independent of plans 002–004.

## Why this matters

`src/components/Viewer3D.tsx` builds `THREE.BufferGeometry` objects imperatively inside `useMemo` and hands them to meshes via the `geometry` prop. When the memo dependency changes (a new generation result, a repaint of selection colors, a different sample shape), a **new** geometry is created and the old one is dropped without `dispose()`. Verify: `grep -n "dispose" src/components/Viewer3D.tsx` returns nothing at `2af138a`.

react-three-fiber auto-disposes objects when their JSX elements **unmount**, but a swapped `useMemo` value on a still-mounted component is the developer's responsibility (this is the documented r3f/three.js contract: anything you `new` yourself, you dispose yourself). Each abandoned geometry pins GPU vertex buffers — for a generation result at default resolution that is easily tens of MB of VRAM per regenerate, and repainting keep-out faces rebuilds colored mesh geometry per click. A parameter-tuning session (generate → tweak → regenerate × N) grows GPU memory until the tab is reloaded.

The fix is mechanical and standard: after each geometry-producing `useMemo`, add a `useEffect` cleanup that disposes the geometry when it is replaced or the component unmounts. `BufferGeometry.dispose()` is idempotent, so overlapping with r3f's unmount disposal is harmless.

## Current state (verified excerpts at `2af138a`)

`src/components/Viewer3D.tsx:416-429` — the generation result view:

```tsx
function ResultMeshView({ result }: { result: MarchingCubesResult }) {
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3));
    g.computeVertexNormals();
    return g;
  }, [result]);

  return (
    <mesh geometry={geom}>
      <meshPhongMaterial color="#4a9eff" side={THREE.DoubleSide} />
    </mesh>
  );
}
```

Same pattern in `SampleMeshView` (`:389-407`, deps `[shape, radius, keepOutTris, keepInTris]` — note this one also rebuilds on every selection paint), `CrossSectionView` (`:434-439`), `XRayView` (`:484-489`), and possibly more. **Enumerate them all yourself:**

```bash
grep -n "new THREE.BufferGeometry()" src/components/Viewer3D.tsx
```

At `2af138a` this returns 6–8 sites (result view, cross-section, x-ray, sample mesh, imported-mesh view, demo-grid tiles — the exact set may differ; trust the grep, not this list). Also check the other components for the same pattern; expected empty at `2af138a`:

```bash
grep -rn "new THREE.BufferGeometry()" src/components --include="*.tsx" | grep -v Viewer3D
```

If that second grep is non-empty, apply the same fix there and say so in your report.

## The fix pattern

For every component where a `useMemo` returns a `BufferGeometry` (call the variable `geom` here; use each site's actual name):

```tsx
  useEffect(() => () => geom.dispose(), [geom]);
```

placed immediately after the `useMemo`. When `geom` changes, React runs the cleanup for the previous value → previous geometry disposed. On unmount, the last one is disposed.

Rules:
- One `useEffect` per geometry-producing memo, keyed on exactly that memo's value.
- Ensure `useEffect` is imported: check the `import { ... } from 'react'` line at the top of `Viewer3D.tsx` and extend it if `useEffect` is missing.
- If a single `useMemo` returns **multiple** disposables (e.g. an object holding two geometries), dispose each in the same cleanup.
- Only dispose what the memo **created**. If a memo merely *derives* data (e.g. `resultBounds(result)` at `:441`, `clipStateTo3` planes at `:442` — `THREE.Plane` has no GPU resources and no dispose method) — leave those alone.
- Do NOT dispose materials in this plan: at `2af138a` all materials in `Viewer3D.tsx` are declarative JSX (`<meshPhongMaterial ... />`), which r3f already disposes correctly on unmount/swap. Verify with `grep -n "new THREE.Mesh\|new THREE.MeshPhongMaterial\|new THREE.Material" src/components/Viewer3D.tsx` — expected empty; if you find imperatively-created materials/textures, add them to the same cleanup pattern and note it.
- Do not restructure the memos, change dependency arrays, or convert to `<bufferGeometry>` JSX. Smallest possible diff.

## Steps

### Step 1 — Enumerate

Run the two greps above. Write down every site: component name, line, memo variable, dependency array. This list drives steps 2 and the done criteria.

### Step 2 — Apply the pattern

Add the disposal `useEffect` after each site from step 1. Match file style (2-space indent, single quotes, semicolons).

Verify after editing: `npm run typecheck && npm run lint` → both exit 0. A common lint failure here is `react-hooks/exhaustive-deps` if you wrote `[...]` deps wrong — the dependency is exactly the memo variable.

### Step 3 — Behavioral verification (required)

`npm run dev`, open http://127.0.0.1:5176 in a WebGL-capable browser and confirm the app still works after your change:

1. Click "Ball Demo" → sphere renders.
2. Click "Generate Lattice" → wait for completion → result renders (this proves you are not disposing a geometry that is still attached: if the screen goes blank after generation, you disposed the *current* geometry — recheck that every effect disposes only via the cleanup closure, i.e. `() => () => geom.dispose()`, NOT `() => geom.dispose()`).
3. Change "Cell Size" to 10, Generate again → new result renders.
4. Switch view modes (result / cross-section / x-ray via the view controls) → each renders.
5. Paint a few keep-out faces on the model → colors update, no blank mesh.

GPU-memory spot-check (optional but ideal): in the browser devtools console the r3f renderer is not globally exposed, so use the three.js devtools extension if available, or temporarily add inside any component under the Canvas:

```tsx
  const gl = useThree((s) => s.gl);
  useEffect(() => { (window as unknown as Record<string, unknown>).__gl = gl; }, [gl]);
```

then in the console run `__gl.info.memory.geometries` before and after 5 regenerations: the count must return to (approximately) its baseline rather than growing by ≥1 per regeneration. **Remove this temporary snippet before finishing** — the final diff must not contain it.

### Step 4 — Full verification

```bash
npm test && npm run typecheck && npm run lint && npm run build
```

(`npm test` exists only if plan 001 landed; if it does not, run the other three and note it.)

## Done criteria (machine-checkable)

1. For every match of `grep -n "new THREE.BufferGeometry()" src/components/Viewer3D.tsx` there is a corresponding `.dispose()` cleanup effect in the same component — verify by count: `grep -c "dispose()" src/components/Viewer3D.tsx` ≥ the number of geometry-creation sites.
2. `npm run typecheck`, `npm run lint`, `npm run build` exit 0.
3. Manual sequence in step 3 (items 1–5) all pass — state this explicitly in your report, item by item.
4. Diff touches only `src/components/Viewer3D.tsx` (plus other component files ONLY if the second grep in "Current state" found sites there; the temporary `__gl` snippet is absent).

## Out of scope — do not touch

- `normalizeDemoResult` and other Float32Array copies (CPU-side, GC handles them).
- Store, hooks, workers, geometry modules.
- Refactoring `Viewer3D.tsx` (1,473 lines — decomposition is a separate, test-gated concern recorded in `plans/README.md`).
- Texture/render-target lifecycle (none exist at `2af138a`).

## Maintenance note

The rule for future viewer code: **create in `useMemo` ⇒ dispose in a paired `useEffect` cleanup.** Declarative JSX resources (`<meshPhongMaterial>`, `<bufferGeometry>`) are r3f-managed; imperative `new THREE.*` resources are yours. Reviewers should flag any new `new THREE.BufferGeometry()` in a memo without its paired effect.

## Escape hatches

- If after step 2 any view renders blank, you have a double-use geometry (one memo's output attached to two meshes, disposed by one component while the other still uses it). Find which components share the memoized value; hoist the disposal to the owner that creates it, and STOP if ownership is genuinely shared across siblings — report instead of inventing ref-counting.
- If `useThree` is not already imported for the optional GPU check, skip the optional check rather than adding imports you'd have to remove.
- If the grep reveals `BufferGeometry` creation inside `useFrame` or event handlers (not `useMemo`), STOP and report — that is a different (worse) leak pattern needing its own plan.
