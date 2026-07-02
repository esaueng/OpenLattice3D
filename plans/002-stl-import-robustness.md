# Plan 002 — Make STL import robust: bounds-check binary headers, fix the "solid"-prefixed binary fallback, guard empty meshes

- **Status:** TODO
- **Written against commit:** `2af138a` (branch `main`). Run `git rev-parse --short HEAD` first; if it differs, `git diff 2af138a -- src/geometry/stl-parser.ts src/geometry/bvh.ts src/components/LeftPanel.tsx` and re-read any changed file before editing. If `src/geometry/stl-parser.ts` changed materially, STOP and report.
- **Depends on:** Plan 001 (vitest must be installed and `npm test` green before you start). If `npx vitest --version` fails, STOP and report "blocked on plan 001".

## Why this matters

STL upload is the app's main untrusted input (public deployment at openlattice3d.com). The parser at `src/geometry/stl-parser.ts` has three verified defects:

1. **Real-world binary STLs that begin with the text `solid` can silently import as an empty (0-triangle) mesh.** Many CAD exporters write binary STLs whose 80-byte header starts with `solid ...` — this is a notorious real-world file class. The current detection tries ASCII parsing for them, and the ASCII parser *never throws* on binary garbage — its regex simply finds no matches and it returns a 0-triangle mesh. The user sees "Loaded: 0 triangles" and a blank model instead of their part.
2. **The binary path trusts the header's triangle count with no bounds check.** A truncated or malicious file with a huge count triggers a giant `new Float32Array(triCount * 9)` allocation and/or a `RangeError` from reading past the buffer. `LeftPanel` catches the exception, but the user gets a cryptic `Import failed: RangeError ...` instead of a real diagnosis; moderately-inflated counts allocate gigabytes before failing.
3. **Buffers shorter than 84 bytes throw** (`view.getUint32(80)` reads out of range) with the same cryptic error.

Downstream, `MeshBVH.signedDistance` silently returns garbage (±Infinity) when its `closestPoint` finds no triangle — which is exactly what happens if a 0-triangle mesh reaches generation.

## Current state (verified excerpts at `2af138a`)

`src/geometry/stl-parser.ts:11-31` — detection:

```ts
export function parseSTL(buffer: ArrayBuffer): TriangleMesh {
  const view = new DataView(buffer);
  // Check if ASCII: starts with "solid" and doesn't look binary
  const header = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  const headerStr = String.fromCharCode(...header);
  if (headerStr.startsWith('solid') && buffer.byteLength > 84) {
    // Could be ASCII or binary with "solid" header - check expected binary size
    const triCount = view.getUint32(80, true);
    const expectedBinarySize = 84 + triCount * 50;
    if (Math.abs(expectedBinarySize - buffer.byteLength) <= 1) {
      return parseBinarySTL(buffer);
    }
    // Try ASCII
    try {
      return parseASCIISTL(buffer);
    } catch {
      return parseBinarySTL(buffer);
    }
  }
  return parseBinarySTL(buffer);
}
```

The bug: a `solid`-prefixed **binary** file whose size differs from `84 + triCount*50` by more than 1 byte (e.g. trailing padding, which is common) falls into `parseASCIISTL`, which returns `{positions: Float32Array(0), normals: Float32Array(0), triCount: 0}` without throwing — so the `catch → parseBinarySTL` fallback never runs.

`src/geometry/stl-parser.ts:33-37` — no bounds check:

```ts
function parseBinarySTL(buffer: ArrayBuffer): TriangleMesh {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const positions = new Float32Array(triCount * 9);
  const normals = new Float32Array(triCount * 3);
```

`src/geometry/bvh.ts:448-461` — sign from a possibly-absent triangle (`closestPoint` initializes `bestTri = -1` at `bvh.ts:398` and can return it unchanged):

```ts
  signedDistance(p: Vec3): number {
    const res = this.closestPoint(p);
    const ni = res.triIndex * 3;
    const nx = this.normals[ni];
    const ny = this.normals[ni + 1];
    const nz = this.normals[ni + 2];
    ...
```

With `triIndex === -1`, `this.normals[-3]` is `undefined`, the sign comparison degrades, and the function returns `-Infinity`/garbage instead of failing loudly.

`src/components/LeftPanel.tsx:30-54` — the only caller of `parseSTL`; wraps everything in try/catch and logs `Import failed: ${err}`. It currently accepts a 0-triangle mesh into the store without complaint.

## Target semantics (the contract you are implementing)

| Input | Behavior after this plan |
|---|---|
| Well-formed binary STL (any header text, exact size or trailing bytes) | Parses as binary with the declared triangle count. |
| Well-formed ASCII STL (starts with `solid`, contains `facet` blocks) | Parses as ASCII (unchanged). |
| `solid`-prefixed binary STL, size ≥ `84 + triCount*50`, `triCount > 0` | ASCII attempt finds 0 facets → **falls back to binary parse** (this is the fix for defect 1). |
| Buffer `< 84` bytes and not parseable as ASCII | Throws `Error` with a message naming the actual byte length. |
| Binary header `triCount` exceeding what the buffer can hold | Throws `Error` naming declared vs. maximum-possible triangle count. **The throw must happen before any large allocation.** |
| File that parses to 0 triangles (e.g. `solid x\nendsolid x`) | `parseSTL` throws `Error` `"STL contains no triangles"`. |
| Parsed mesh containing NaN/±Infinity coordinates | Throws `Error` naming the first bad triangle index. |
| Empty mesh handed to `new MeshBVH(...)` | Constructor throws `Error` (defense in depth — should be unreachable once parseSTL throws). |
| `closestPoint` returns `triIndex < 0` inside `signedDistance` | Returns `Number.POSITIVE_INFINITY` (point is "outside" a mesh that has no surface) instead of computing garbage. |

## Steps

### Step 1 — Write the failing tests first

Create `src/geometry/stl-parser-robustness.test.ts` (separate file from plan 001's `stl-parser.test.ts`, so characterization vs. new-contract tests stay distinct). Reuse the `buildBinarySTL` helper pattern from `src/geometry/stl-parser.test.ts` (copy it; do not import across test files), plus a variant that lets you set the 80-byte header text and append trailing bytes:

Tests to write (all against the target-semantics table):

1. `solid`-prefixed binary: build a valid 2-triangle binary STL, write the bytes `solid mypart` at offset 0, append 4 trailing `0x00` bytes (so the exact-size check misses). `parseSTL` → `triCount === 2` with correct vertices. *(Currently returns 0 — this test must FAIL before your fix and pass after.)*
2. Truncated binary: 1-triangle binary STL but with the count field overwritten to `1000` (`new DataView(buf).setUint32(80, 1000, true)`). `parseSTL` throws; message matches `/1000/` and `/1\b/` or similar (declared vs. available).
3. Tiny buffer: `parseSTL(new ArrayBuffer(10))` throws; message matches `/10/`.
4. Empty ASCII: `parseSTL` of the UTF-8 bytes of `"solid empty\nendsolid empty\n"` throws `/no triangles/i`.
5. NaN coordinates: valid 1-triangle binary STL with one vertex float set to NaN (`view.setFloat32(offset, NaN, true)`). Throws `/non-finite/i` and the message contains the triangle index `0`.
6. Regression guard: plain valid binary STL (non-`solid` header) and plain valid ASCII STL still parse (copy the happy-path assertions style from plan 001's file).
7. BVH empty-mesh: `new MeshBVH(...)` with a 0-triangle mesh throws. (Read the constructor signature in `src/geometry/bvh.ts` first to build the call.)

Run `npx vitest run src/geometry/stl-parser-robustness.test.ts` — tests 1–5 and 7 must fail (red) at this point. If any of them unexpectedly *passes*, STOP: the code has drifted from `2af138a`; re-read the source and reconcile before proceeding.

### Step 2 — Rewrite `parseSTL` detection in `src/geometry/stl-parser.ts`

Replace the body of `parseSTL` with this logic (adapt naming to the file's existing style; keep the exported signature identical):

```ts
export function parseSTL(buffer: ArrayBuffer): TriangleMesh {
  const headerBytes = new Uint8Array(buffer, 0, Math.min(80, buffer.byteLength));
  const headerStr = String.fromCharCode(...headerBytes);

  if (headerStr.startsWith('solid')) {
    // Could be ASCII, or binary with a "solid..." header (common in the wild).
    const ascii = tryParseASCIISTL(buffer);
    if (ascii && ascii.triCount > 0) return ascii;
    if (binaryPlausible(buffer)) return parseBinarySTL(buffer);
    if (ascii) throw new Error('STL contains no triangles');
    throw new Error(`Unrecognized STL file (${buffer.byteLength} bytes)`);
  }

  if (binaryPlausible(buffer)) return parseBinarySTL(buffer);
  throw new Error(
    `Unrecognized or truncated STL file (${buffer.byteLength} bytes; binary STL needs at least 84)`
  );
}
```

With two new private helpers:

```ts
function binaryPlausible(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const triCount = new DataView(buffer).getUint32(80, true);
  return triCount > 0 && 84 + triCount * 50 <= buffer.byteLength;
}

function tryParseASCIISTL(buffer: ArrayBuffer): TriangleMesh | null {
  try {
    return parseASCIISTL(buffer);
  } catch {
    return null;
  }
}
```

Notes:
- `triCount * 50` on a uint32 stays a safe integer in JS — no overflow concern.
- The old `Math.abs(expectedBinarySize - byteLength) <= 1` fast path is subsumed: exact-size binaries satisfy `binaryPlausible`, and `solid`-prefixed exact-size binaries yield 0 ASCII facets and fall through to binary. Order matters: ASCII is tried first for `solid`-prefixed files so a genuine ASCII file whose byte length coincidentally satisfies `binaryPlausible` still parses as ASCII.
- Do **not** modify the `parseASCIISTL` regex or its internals.

### Step 3 — Bounds-check `parseBinarySTL`

At the top of `parseBinarySTL`, before the allocations:

```ts
  if (buffer.byteLength < 84) {
    throw new Error(`Binary STL too small: ${buffer.byteLength} bytes (need at least 84)`);
  }
  const triCount = view.getUint32(80, true);
  const maxTris = Math.floor((buffer.byteLength - 84) / 50);
  if (triCount > maxTris) {
    throw new Error(
      `Binary STL declares ${triCount} triangles but the file can hold at most ${maxTris}`
    );
  }
```

### Step 4 — Non-finite coordinate scan

Add a private helper in `stl-parser.ts` and call it as the last statement of **both** `parseBinarySTL` and `parseASCIISTL` (before their `return`), or wrap their return values:

```ts
function assertFiniteMesh(mesh: TriangleMesh): TriangleMesh {
  const p = mesh.positions;
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) {
      throw new Error(`STL contains non-finite coordinates (triangle ${Math.floor(i / 9)})`);
    }
  }
  return mesh;
}
```

(Positions only — a bad normal is recomputable and harmless downstream; do not scan normals.)

### Step 5 — Guard `MeshBVH`

In `src/geometry/bvh.ts`:
1. Constructor: after the triangle count is known (read the constructor; at `2af138a` it derives from the arguments), add: `if (triCount === 0) throw new Error('MeshBVH requires a non-empty mesh');` — adapt the variable name to the actual code.
2. `signedDistance` (at `bvh.ts:450`): insert after `const res = this.closestPoint(p);`:

```ts
    if (res.triIndex < 0) return Number.POSITIVE_INFINITY;
```

### Step 6 — Belt-and-braces in `LeftPanel`

In `src/components/LeftPanel.tsx` `handleFileUpload` (lines 30–54), after `const mesh = parseSTL(buffer);` add:

```ts
      if (mesh.triCount === 0) {
        store.addLog('Import failed: STL contains no triangles', 'error');
        return;
      }
```

(Should be unreachable now, but the store must never hold an empty original mesh.) Match the surrounding logging style exactly — see the `catch` at line 51 for tone.

### Step 7 — Full verification

```bash
npm test          # all files: robustness tests now green, plan-001 tests still green
npm run typecheck
npm run lint
npm run build
```

All must exit 0. If a plan-001 characterization test fails, examine it: the only legitimate breakages are tests that asserted the old malformed-input behavior (plan 001 was instructed not to write those). Any other failure means your change altered well-formed parsing — fix your change, do not edit the old test.

Manual smoke (optional but recommended): `npm run dev`, open http://127.0.0.1:5176, upload `public/assets/sphere-25mm.stl` via "Upload STL" — log shows `Loaded: 3968 triangles` (or the file's actual count) and the mesh renders.

## Done criteria (machine-checkable)

1. All 7 new tests in `src/geometry/stl-parser-robustness.test.ts` pass.
2. `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` all exit 0.
3. `git diff --stat` touches ONLY: `src/geometry/stl-parser.ts`, `src/geometry/bvh.ts`, `src/components/LeftPanel.tsx`, the new test file. (Plus nothing else.)
4. `grep -c "new Float32Array(triCount" src/geometry/stl-parser.ts` — the allocations still exist but are now preceded (in `parseBinarySTL`) by the `maxTris` check: verify by reading the diff.

## Out of scope — do not touch

- The ASCII regex (`stl-parser.ts:56`) — it is correct enough and changing it risks new edge cases.
- `exportBinarySTL` — export is trusted output.
- Any file-size upload cap in `LeftPanel` (a 2 GB upload is the user's own choice; not this plan).
- `mesh-analysis.ts` repair logic, workers, store.
- Do not add a dependency.

## Maintenance note

The target-semantics table above is the parser's contract; copy it (abridged) into the header comment of `stl-parser.ts` so future editors see it. Anything that changes STL detection must update `stl-parser-robustness.test.ts` in the same commit. The `signedDistance` early-return means an empty BVH yields "everything outside" — if a future caller builds `MeshBVH` lazily, the constructor throw is the real guard.

## Escape hatches

- If test 1 (solid-prefixed binary) cannot be made to pass without breaking test 6 (genuine ASCII), STOP and report — the detection heuristic needs a human decision, do not invent additional heuristics beyond the plan.
- If `MeshBVH`'s constructor shape at HEAD differs from what step 5 assumes (e.g. it takes a `TriangleMesh` object), adapt the guard to the actual signature; if the constructor already validates, note it and skip.
- If you find call sites of `parseSTL` other than `LeftPanel.tsx:36` (check: `grep -rn "parseSTL" src/`), STOP and report before changing thrown-error behavior.
