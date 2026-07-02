# Plan 001 — Establish a test + CI verification baseline

- **Status:** DONE — superseded by PR #14 (`903b1c6`, merged to `main` 2026-07-02): vitest.config.ts, 46 tests across 6 test files, and `.github/workflows/ci.yml` landed independently. **Do not execute.** Kept for reference; test-coverage gaps vs. this plan's target list (e.g. `mesh-analysis`, `validation` module coverage) can be split into a follow-up if desired.
- **Written against commit:** `2af138a` (branch `main`). Before starting, run `git rev-parse --short HEAD`. If it differs, run `git diff 2af138a --stat -- src/geometry package.json` first; if any `src/geometry/*` file changed, re-read the changed files before writing tests for them (the line numbers and behaviors cited below may have drifted). If the drift is large or confusing, STOP and report back.
- **Priority:** 1 of 5 — do this plan first. Plan 002 depends on it; plans 003–005 are safer with it.

## Why this matters

This repository (OpenLattice3D, a browser app that generates 3D-printable lattice structures from STL meshes) has **zero automated tests, no test framework, no test script, and no CI**. Verify yourself: there is no `test` script in `package.json`, no `vitest`/`jest` in `devDependencies`, no files matching `*.test.*` or `*.spec.*` anywhere under `src/`, and no `.github/` directory.

Meanwhile `src/geometry/` contains ~2,700 lines of pure, dependency-free numerical code (SDF math, BVH spatial queries, marching cubes, STL parsing, mesh validation) whose bugs produce silently wrong 3D-printable output rather than visible errors. Several follow-up plans (002–005) change this code or its callers; without characterization tests those changes are blind.

Your job: install vitest, write characterization tests for the pure geometry modules, add `test`/`typecheck` scripts, and add a GitHub Actions CI workflow. **You will not modify any existing source file under `src/` — this plan only adds new files and edits `package.json` and `README.md`.**

## Repo facts you need

- Stack: Vite 8, React 19, TypeScript 5.9 (`strict: true`), three.js — but **none of the code you will test imports React, three.js, or any DOM API**. Everything in `src/geometry/` imports only sibling geometry modules and `src/types/project.ts`. Tests run in plain Node.
- Package manager: npm (there is a `package-lock.json`). Node scripts in `package.json`:
  - `"dev": "vite --host 127.0.0.1 --port 5176"`
  - `"build": "tsc -b && vite build"`
  - `"lint": "eslint ."`
- Both `npx tsc --noEmit -p tsconfig.app.json` and `npx eslint .` currently pass with zero errors. They must still pass when you are done.
- `tsconfig.app.json` has `"include": ["src"]`, `verbatimModuleSyntax: true`, `noUncheckedSideEffectImports: true`. Test files placed under `src/` are typechecked by the normal build — that is intended.
- Code style: 2-space indent, single quotes, semicolons, `camelCase` functions, plain functions (no classes except `MeshBVH`). Comments are sparse — only where the math needs explanation. Match this in test files.

## Module inventory (what to test)

All paths relative to repo root. Exports verified at commit `2af138a`:

| File | Key exports | Notes |
|---|---|---|
| `src/geometry/vec3.ts` | `Vec3` type, `add, sub, scale, dot, cross, length, normalize, lerp, distSq, dist, min3, max3` | 62 lines, pure array math. `Vec3 = [number, number, number]`. |
| `src/geometry/stl-parser.ts` | `TriangleMesh` interface, `parseSTL(buffer: ArrayBuffer): TriangleMesh`, `exportBinarySTL(positions, normals, triCount): ArrayBuffer` | Binary layout: 80-byte header, uint32 LE triangle count at offset 80, then 50 bytes/triangle (12B normal + 3×12B vertices + 2B attribute). |
| `src/geometry/marching-cubes.ts` | `marchingCubes(sdf, bounds, resolution, isoValue?, onProgress?)`, `marchingCubesRectangular(...)`, `marchingCubesFromField(field, bounds, cells, ...)`, `MarchingCubesResult` | `marchingCubesFromField` throws if `field.length !== (nx+1)*(ny+1)*(nz+1)` — that throw is worth a test. |
| `src/geometry/lattice.ts` | 12 SDF functions: `gyroidSDF, schwarzPSDF, schwarzDSDF, neoviusSDF, iwpSDF, bccStrutSDF, octetSDF, diamondStrutSDF, voronoiSDF, spinodalSDF, hexagonPrismSDF, trianglePrismSDF`; plus `smoothMin, smoothMax, isSheetType, buildSphereLattice, buildCubeLattice, buildCylinderLattice, buildTorusLattice, buildCapsuleLattice, buildCombinedSDF` | Sheet SDFs take `(x, y, z, cellSize, wallThickness)`; strut SDFs take `(x, y, z, cellSize, strutDiameter)`. |
| `src/geometry/bvh.ts` | `MeshBVH` class with `closestPoint(p: Vec3)`, `signedDistance(p: Vec3)`, `isInsideRayCast(p: Vec3)` | Constructor signature: read the top of the file before writing tests (takes the mesh positions/normals/triCount — confirm exact form). |
| `src/geometry/mesh-analysis.ts` | `analyzeMesh(mesh): MeshInfo`, `repairMesh(mesh)`, `generateSphereMesh(radius, segments)`, `generateCylinderMesh(...)`, `generateTorusMesh(...)`, `generateCapsuleMesh(...)`, `generateCubeMesh(size)` | The `generate*Mesh` functions are your free test fixtures. `MeshInfo` (from `src/types/project.ts`) has `triangleCount, vertexCount, boundingBox, isWatertight, isManifold, repaired`. |
| `src/geometry/validation.ts` | `checkTopology, checkOuterDeviation, checkSphereDeviation, checkMinThickness, checkManifold, checkDisconnected, runValidation` | Read each signature in the file before use — do not guess parameter shapes. |

## Steps

Each step ends with a verification command. Run it; if it fails, fix your work before moving on.

### Step 1 — Install vitest

```bash
npm install --save-dev vitest
```

**Escape hatch:** if npm reports a peer-dependency conflict against `vite@8`, run `npm info vitest peerDependencies` and install the newest vitest major whose `vite` peer range includes 8 (e.g. `npm i -D vitest@^4`). If no published vitest supports vite 8, install with `npm i -D vitest --legacy-peer-deps` and record that in your final report. Do not downgrade vite.

Verify: `npx vitest --version` prints a version.

### Step 2 — Add a vitest config

Create `vitest.config.ts` at the repo root (this makes vitest ignore `vite.config.ts`, so the React plugin never loads for tests):

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
```

Verify: `npx vitest run` exits 0 reporting "no test files found" (or similar) — not a config error.

### Step 3 — Add scripts to package.json

In `package.json` `"scripts"`, add (keep the existing scripts untouched):

```json
"test": "vitest run",
"test:watch": "vitest",
"typecheck": "tsc --noEmit -p tsconfig.app.json"
```

Verify: `npm run typecheck` exits 0.

### Step 4 — Write the characterization tests

Create the files below. Ground rules for every test:

- **Characterize, don't fix.** You are pinning down what the code does today. If a behavior looks wrong to you, do not change source code — write the test around the case (skip that input) and note it in your final report. Known issues already tracked elsewhere (do not test these cases): binary STL files whose 80-byte header begins with the text `solid`, STL buffers shorter than 84 bytes, huge/lying binary triangle counts, `MeshBVH` built from a 0-triangle mesh. Plans 002/003 own those.
- **Determinism:** never call `Math.random()` directly. Where you need random points, use this seeded generator (put it in the test file that needs it):

```ts
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
```

- Use `expect(x).toBeCloseTo(y, digits)` for floats, exact equality only for integers/counts.
- Before writing each file, **open the module and read the real signatures** — the table above is a map, not a substitute.

**4a. `src/geometry/vec3.test.ts`** — algebraic identities: `add/sub` inverses; `dot(cross(a,b), a) ≈ 0` and same for `b`; `length(normalize(v)) ≈ 1` for a few non-zero vectors; `lerp(a, b, 0) = a`, `lerp(a, b, 1) = b`; `dist(a,b)^2 ≈ distSq(a,b)`; `min3`/`max3` componentwise. Also read `normalize` in `src/geometry/vec3.ts:33` and characterize what it returns for the zero vector — assert that exact current behavior with a comment `// characterization: current zero-vector behavior`.

**4b. `src/geometry/stl-parser.test.ts`** — build a binary STL in the test with this helper:

```ts
function buildBinarySTL(tris: number[][][]): ArrayBuffer {
  // tris: array of [ [nx,ny,nz], [ax,ay,az], [bx,by,bz], [cx,cy,cz] ]
  const buf = new ArrayBuffer(84 + tris.length * 50)
  const view = new DataView(buf)
  view.setUint32(80, tris.length, true)
  tris.forEach((t, i) => {
    const o = 84 + i * 50
    t.flat().forEach((v, j) => view.setFloat32(o + j * 4, v, true))
  })
  return buf
}
```

Tests: (1) parse a 1-triangle binary STL → `triCount === 1`, positions and normals match the inputs exactly; (2) round-trip `parseSTL(exportBinarySTL(m.positions, m.normals, m.triCount))` on a 2-triangle mesh → identical arrays; (3) parse a small ASCII STL from a template-literal string (one `facet normal ... outer loop ... vertex ...` block, `solid`/`endsolid` wrapper) → `triCount === 1` with correct vertex values; (4) an ASCII STL with exponent-notation numbers (`1.5e-1`) parses to the right floats.

**4c. `src/geometry/marching-cubes.test.ts`** — with `const sphereSdf = (x,y,z) => Math.sqrt(x*x+y*y+z*z) - 10` and bounds `{min:[-12,-12,-12], max:[12,12,12]}` at resolution 24: result `triCount > 100`; every value in `positions` is finite (`Number.isFinite`); every vertex has `|length - 10| < 1.5` (one cell diagonal ≈ 1.73 slack); every normal triple is either all-zero or unit length within 1e-3. Then: `marchingCubesFromField(new Float32Array(5), {min:[0,0,0],max:[1,1,1]}, [4,4,4])` throws (message contains "does not match"). Then: an SDF that is positive everywhere (`() => 5`) yields `triCount === 0` with empty arrays.

**4d. `src/geometry/lattice.test.ts`** — (1) loop over all 12 SDF exports (import them all; make a table of `[name, fn]`): each returns a finite number at `(0.1, 0.2, 0.3, 8, 1)` and at `(5, 5, 5, 8, 1)`; (2) gyroid periodicity: `gyroidSDF(x, y, z, 8, 1) ≈ gyroidSDF(x + 8, y, z, 8, 1)` (toBeCloseTo, 6 digits) for 5 seeded points, and same for +8 in y and z; (3) `smoothMin(a, b, k) <= Math.min(a, b) + 1e-9` for a grid of a/b values with `k = 0.5`, and `smoothMin(a, b, k) ≈ min` when `|a-b| >> k`; (4) `isSheetType('gyroid') === true`, `isSheetType('bcc') === false`; (5) `buildSphereLattice(25, DEFAULT_PARAMS)` (import `DEFAULT_PARAMS` from `../types/project`) returns a function; sample it at 20 seeded points inside `[-30, 30]^3` — all finite.

**4e. `src/geometry/bvh.test.ts`** — fixtures from `mesh-analysis`: `generateCubeMesh(30)` and `generateSphereMesh(10, 16)`. Read the `MeshBVH` constructor signature at the top of `src/geometry/bvh.ts` first. Reference implementation for the test (brute force over all triangles using the same `closestPointOnTriangle` idea is complex — instead validate against analytic truth):
- Sphere mesh (radius 10, centered at origin): for 100 seeded points uniform in `[-15, 15]^3`, `bvh.signedDistance(p)` must satisfy: sign is negative iff `length(p) < 10` (skip points with `abs(length(p) - 10) < 0.5` — near the faceted surface the polyhedral sign can legitimately differ), and `abs(abs(sd) - abs(length(p) - 10)) < 0.35` (faceting tolerance for a 16-segment sphere).
- Cube mesh (size 30, so faces at ±15 — verify by checking `analyzeMesh(cube).boundingBox` first and adapt if the cube is `[0,30]` instead): at point `[0,0,0]` (or box center) signedDistance is negative with magnitude ≈ half-extent within 0.01; at a point 5 outside a face, positive ≈ 5 within 0.01.
- `closestPoint` returns `triIndex >= 0` for all tested points on both meshes.

**4f. `src/geometry/mesh-analysis.test.ts`** — `analyzeMesh(generateCubeMesh(30))`: `triangleCount === 12`, `isWatertight === true`, `isManifold === true`, bounding box min/max match what you observed in 4e; `analyzeMesh(generateSphereMesh(10, 16))`: watertight and manifold, bounding box within `[-10.01, 10.01]` per axis; `repairMesh` on the healthy cube — characterize: assert the returned `repaired` flag's current value with a comment, and that the mesh still has 12 triangles.

**4g. `src/geometry/validation.test.ts`** — read `src/geometry/validation.ts:157-329` first. Using `generateSphereMesh(10, 24)` shaped as a `MarchingCubesResult`-like object (`{positions, normals, triCount}`): `checkManifold(...)` passes; `checkDisconnected(...)` reports `fragmentCount === 1` and passes; `checkSphereDeviation` — read its exact signature at `validation.ts:199`, then assert a sphere mesh against its own radius 10 yields max deviation `< 0.2` and passes. If any of these three needs inputs you cannot construct from the fixtures (e.g. a BVH or sample arrays), test only the ones you can and say so in the report; do not fabricate expectations.

Verify after each file: `npx vitest run src/geometry/<file>` exits 0. After all: `npm test` exits 0, and `npm run typecheck` and `npm run lint` still exit 0.

### Step 5 — CI workflow

Create `.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build
```

Verify: `npx --yes yaml@latest --help` is NOT a real validator — instead verify by parsing: `node -e "const fs=require('fs'); const s=fs.readFileSync('.github/workflows/ci.yml','utf8'); if(!s.includes('npm test')) process.exit(1)"` and visually confirm indentation is 2-space consistent. (CI itself proves it on the next push.)

### Step 6 — README note

In `README.md`, in the Quick Start section after the `npm run dev` block, add a short "## Testing" section (3–4 lines): `npm test` runs the vitest suite, `npm run typecheck` typechecks, tests live next to the modules as `src/**/*.test.ts`.

Verify: `npm run lint` still passes (README is not linted, but confirm nothing else broke) and `npm run build` exits 0.

## Done criteria (machine-checkable)

1. `npm test` → exit 0, with **at least 7 test files and at least 30 passing tests**, zero skipped-due-to-error.
2. `npm run typecheck` → exit 0.
3. `npm run lint` → exit 0.
4. `npm run build` → exit 0.
5. `git status --porcelain` shows only: new test files under `src/geometry/`, `vitest.config.ts`, `.github/workflows/ci.yml`, modified `package.json` + `package-lock.json`, modified `README.md`. **No other `src/` file modified.**

## Out of scope — do not touch

- Any non-test file under `src/` (no "quick fixes" to bugs you notice — report them instead).
- `src/workers/**` (worker logic is not unit-testable without extraction; that refactor is deliberately deferred).
- `vite.config.ts`, `wrangler.jsonc`, `worker/index.ts`, `eslint.config.js`, tsconfigs.
- Components/hooks/store — no jsdom, no React testing in this plan.

## Maintenance note

Future plans (002 STL robustness, 003 param sanitization, 004 progress throttling) will add tests beside these. When plan 002 lands it will *change* STL-parser behavior for malformed inputs — the 4b tests above only pin well-formed inputs, so they should keep passing; if one breaks under plan 002, the plan-002 executor must reconcile explicitly, not delete tests silently.

## Escape hatches

- Vitest peer-dependency conflict → see Step 1.
- If `npx vitest run` fails to load `vitest.config.ts` with an ESM/CJS error, rename to `vitest.config.mts` and retry.
- If any module unexpectedly imports a browser global when imported under Node (it should not — verified at `2af138a`), STOP for that module, test the others, and report which import chain broke.
- If more than 3 characterization assertions disagree with what this plan predicts, STOP and report — the codebase may have drifted from commit `2af138a`.
