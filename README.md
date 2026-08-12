# OpenLattice3D

A browser-based tool for generating 3D-printable lattice structures inside arbitrary meshes. It supports twelve lattice types — TPMS sheets (Gyroid, Schwarz P, Schwarz D, Neovius, IWP), strut lattices (BCC, Octet, Diamond, Hexagon, Triangle), and stochastic structures (Voronoi foam, Spinodal) — with SDF-based geometry processing and marching-cubes mesh extraction. All model processing runs locally in browser Web Workers; no model-upload service is required.

**Live app:** [openlattice3d.com](https://openlattice3d.com) · **Health check:** [`GET /health`](https://openlattice3d.com/health)

## Main Features

- Import binary or ASCII STL meshes, or start from a printable procedural sample shape.
- Generate twelve TPMS, strut, and stochastic lattice families with adjustable cell size, shell, feature, drainage-hole, and resolution parameters.
- Keep work local: generation and validation run in browser Web Workers, and projects can be saved and restored as JSON.
- Check printable-mesh properties including surface deviation, minimum thickness, manifoldness, watertightness, and connected components.
- Export validated results as STL, 3MF, or OBJ, with optional tolerance-bounded mesh simplification.
- Compare all twelve lattice types side by side before selecting one to export.

## Requirements

- Node.js 22 (the CI baseline uses Node 22)
- npm 10 or newer
- A modern desktop browser with WebGL support

## Quick Start

```bash
npm ci
npm run dev
```

Open http://127.0.0.1:5176 in your browser.

## Local Development

```bash
npm run dev        # Vite dev server
npm run lint       # ESLint
npm run typecheck  # TypeScript project check
npm test           # Vitest unit tests (geometry core)
npm run build      # Typecheck + production build into dist/
```

`npm run dev` binds only to `127.0.0.1`. Use the generated `dist/` directory
with `npm run preview` to inspect the production bundle locally.

## Deploy to Cloudflare Workers

Production is a static Cloudflare Workers site. Cloudflare serves the Vite
bundle from `dist/`; the small Worker in `worker/index.ts` provides the
uncached `GET /health` response used by uptime monitors. The application has
no configured runtime bindings or application secrets.

```bash
npm ci
npm run build
npx wrangler deploy
```

Before deploying your own copy, change the Worker name and routes in
`wrangler.jsonc`; do not reuse the public project domains. Authenticate
Wrangler using your Cloudflare account (for example, `npx wrangler login`) and
keep account credentials out of the repository. After deployment, verify both
the app and the health endpoint:

```bash
curl --fail --show-error --silent https://YOUR_DOMAIN/
curl --fail --show-error --silent https://YOUR_DOMAIN/health
```

## Self-Hosting

This is a client-side application: build it with `npm ci && npm run build`,
then serve the resulting `dist/` directory over HTTPS. For a non-Cloudflare
host, configure all of the following:

1. Rewrite unknown application routes to `index.html` so the single-page app can load.
2. Send `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` headers for application assets.
3. Provide `GET /health` as a `200` JSON response (for example,
   `{"status":"ok"}`) with `Cache-Control: no-store`; do not rewrite this
   request to `index.html`.

The supplied `public/_headers` file configures the required cross-origin
isolation headers on Cloudflare. Other hosts use their own equivalent header
and rewrite configuration. Avoid third-party embedded assets unless they send
headers compatible with the isolation policy described below.

### Cross-origin isolation

The app sends these headers in Vite dev, Vite preview, and Cloudflare static assets:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

These headers prepare the app for `SharedArrayBuffer` and threaded WebAssembly, but generation
does not currently require either feature. When generation starts, the app logs runtime support
for `crossOriginIsolated`, `SharedArrayBuffer`, and threaded-WASM readiness.

COEP can block third-party iframes, scripts, images, or worker resources unless those resources
send compatible CORS or `Cross-Origin-Resource-Policy` headers. Keep third-party embeds on a
non-isolated page or use an external link when the provider cannot opt in.

### Feedback form

Feedback is collected through an external form link rather than an embedded iframe. This avoids
COEP compatibility problems with third-party form resources.

## How to Use

### 1. Import a Model

- **Import STL**: load any STL file (binary or ASCII). The app analyzes the mesh for
  watertightness/manifoldness and applies a basic repair (normal recalculation) if needed.
- **Import JSON**: resume a versioned project with its parameters, embedded source mesh,
  selection masks, validation results, and viewer state. Legacy parameter-only JSON files
  remain supported; malformed or out-of-range values are ignored.
- **Sample Part**: pick a built-in procedural shape (sphere, cube, cylinder, torus, capsule)
  with print-ready defaults. Procedural shapes use analytic SDFs and a tiled multi-worker
  CPU backend for fast generation.

### 2. Configure Lattice Parameters

- **Lattice Type**: TPMS sheet (Gyroid, Schwarz P/D, Neovius, IWP), strut (BCC, Octet,
  Diamond, Hexagon, Triangle), or stochastic (Voronoi, Spinodal).
- **Cell Size**: lattice unit cell dimension (default 8mm).
- **Shell / No shell / Surface only**: keep an outer shell of given thickness, generate a pure
  lattice, or confine the lattice to a band near the surface (hollow inside).
- **Escape Holes**: subtract one or more axis-aligned drainage cylinders from shell-bearing
  parts, with a live translucent placement preview.
- **Wall Thickness / Strut Diameter**: lattice feature size depending on type.
- **Min Feature Size & Tolerance**: validation targets.
- **Export Resolution**: marching cubes sampling density (1–10).
- **Remove Features**: applies a morphological opening that removes features
  below the selected width without uniformly thinning geometry that survives.
  The run log reports when the export grid cannot resolve the requested width.

### 3. Multiview

Enable "Show all 12 windows" to render every lattice type side-by-side for the current model.
Click a tile to make that lattice type active.

### 4. Generate

Click "Generate Lattice" (or press `G`). Computation runs in background Web Workers with
progress, time estimates, and run logs (drawer in the status bar). Hotkeys `1`–`4` switch
viewer modes (Original, Solid, Cross-Section, X-Ray); `H` resets the viewport. Selection edits
support `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` undo/redo.

### 5. Validate

After generation, the validation panel shows:
- **Outer Deviation**: max deviation from original surface vs. tolerance
- **Min Thickness**: thinnest feature measured (must exceed min feature size)
- **Manifold/Watertight**: printability check
- **Connectivity**: disconnected fragment detection

### 6. Export

- **Export STL**: binary STL of the lattice result (outward-oriented triangles)
- **Export 3MF**: indexed triangle mesh in a standards-based, millimetre-unit 3MF package
- **Export OBJ**: indexed Wavefront OBJ geometry (the format does not declare units)
- **Export Project JSON**: a resumable project with its source geometry and workspace state

Mesh exports can optionally reduce triangle count while keeping simplification
error within the configured geometric tolerance.

After validation, the right panel also reports generated volume, relative density, material
reduction, and optional mass when a material density is configured.

## Architecture

```
src/
  geometry/                 # Core geometry engine (pure, fully unit-tested)
    vec3.ts                 # Vector math utilities
    bvh.ts                  # BVH acceleration for nearest-triangle / signed distance
    stl-parser.ts           # STL import/export (binary + ASCII, hardened against bad input)
    mesh-analysis.ts        # Watertight/manifold checks, repair, procedural meshes
    mesh-topology.ts        # Edge topology, manifold defects, connected components
    marching-cubes.ts       # Marching cubes iso-surface extraction
    lattice.ts              # Lattice SDFs + combined shell/core/surface builders
    validation.ts           # Deviation, thickness, manifold, connectivity checks
  workers/
    lattice-worker.ts       # Generation and validation orchestrator
    lattice-tile-worker.ts  # One marching-cubes tile per message (CPU tiled backend)
    tiled-generation.ts     # Bounded worker fan-out, sparse skipping, deterministic merge
    generation-estimate.ts  # Resolution and memory estimates
    mesh-cleanup.ts         # Post-generation fragment cleanup
    surface-sample-worker.ts# Poisson surface sampling for hex/tri surface lattices
    validation-worker.ts    # Post-generation validation
  components/
    Viewer3D.tsx            # Viewer scene orchestration and interaction
    viewer/                 # Mesh renderers and twelve-lattice demo grid
    LeftPanel.tsx           # Import, parameters, generate
    RightPanel.tsx          # Validation and manufacturing statistics
    ViewerControls.tsx      # View modes, cross-section, background
    ExportControls.tsx      # STL, 3MF, OBJ, and project JSON export
  hooks/
    useLatticeGeneration.ts # Worker lifecycle for generation + validation
    useWorkspaceHotkeys.ts  # Keyboard shortcuts
  store/
    useStore.ts             # Zustand global state + IndexedDB persistence
  types/
    project.ts              # Data model, params, presets, param sanitization
  utils/
    project-file.ts         # Versioned project serialization and restoration
    export.ts               # Browser download helpers
```

See [docs/architecture.md](./docs/architecture.md) for the data flow, geometry
contracts, and module boundaries. Production generation uses the tested CPU tiled and
single-worker paths; see [the backend decision](./docs/performance/backend-decision.md).

### SDF Pipeline (Shell + Core)
1. Compute signed distance field from input mesh (BVH-accelerated) or analytic shape SDF
2. Define shell region: `max(d_obj, -(d_obj + shell_thickness))`
3. Evaluate lattice SDF inside core region
4. Smooth union of shell and core lattice (polynomial smooth-min)
5. Extract mesh via marching cubes at iso=0, drop disconnected fragments

### Validation
- Outer deviation: sample surface points, measure signed distance to original
- Min thickness: ray march inward along normals to measure wall/strut width
- Manifold: edge-count analysis (each edge shared by exactly 2 triangles)
- Connectivity: flood-fill on triangle adjacency graph

## Testing

Unit tests cover STL parsing (including malformed and shipped-asset round trips), marching
cubes, BVH distances, all lattice SDFs and TPMS thickness calibration, topology stress cases,
escape-hole subtraction, watertight repair, tolerance-bounded simplification, morphology,
3MF/OBJ packaging, project restoration, state history, and parameter sanitization.

```bash
npm test
```

## Test Assets

Pre-generated STL files in `public/assets/`:
- `sphere-25mm.stl` - 25mm radius sphere (3968 triangles)
- `sphere-10mm.stl` - 10mm radius sphere (2208 triangles)
- `cube-30mm.stl` - 30mm cube (12 triangles)

Regenerate with: `node scripts/generate-test-assets.mjs`

## License

Apache-2.0. See [LICENSE](./LICENSE).
