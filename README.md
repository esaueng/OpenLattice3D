# OpenLattice3D

A web-based tool for generating 3D-printable lattice structures inside arbitrary meshes. Supports twelve lattice types — TPMS sheets (Gyroid, Schwarz P, Schwarz D, Neovius, IWP), strut lattices (BCC, Octet, Diamond, Hexagon, Triangle), and stochastic structures (Voronoi foam, Spinodal) — with SDF-based geometry processing and marching cubes mesh extraction. All computation runs client-side in Web Workers.

## Quick Start

```bash
npm install
npm run dev
```

Open http://127.0.0.1:5176 in your browser.

## Development

```bash
npm run dev        # Vite dev server
npm run lint       # ESLint
npm run typecheck  # TypeScript project check
npm test           # Vitest unit tests (geometry core)
npm run build      # Typecheck + production build into dist/
```

## Deploy to Cloudflare Workers

This app can be deployed as a static Workers site using Wrangler assets.

```bash
npm install
npm run build
npx wrangler deploy
```

The Worker serves files from `dist/` and falls back to `index.html` for client-side routing.

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
- **Import JSON**: restore saved lattice parameters from a previously exported project JSON.
  Imported values are validated and out-of-range or malformed entries are ignored.
- **Sample Part**: pick a built-in procedural shape (sphere, cube, cylinder, torus, capsule)
  with print-ready defaults. Procedural shapes use analytic SDFs and a tiled multi-worker
  CPU backend for fast generation.

### 2. Configure Lattice Parameters

- **Lattice Type**: TPMS sheet (Gyroid, Schwarz P/D, Neovius, IWP), strut (BCC, Octet,
  Diamond, Hexagon, Triangle), or stochastic (Voronoi, Spinodal).
- **Cell Size**: lattice unit cell dimension (default 8mm).
- **Shell / No shell / Surface only**: keep an outer shell of given thickness, generate a pure
  lattice, or confine the lattice to a band near the surface (hollow inside).
- **Wall Thickness / Strut Diameter**: lattice feature size depending on type.
- **Min Feature Size & Tolerance**: validation targets.
- **Export Resolution**: marching cubes sampling density (1–10).
- **Thin Artifact Filter**: removes very thin/jagged sections.

### 3. Multiview

Enable "Show all 12 windows" to render every lattice type side-by-side for the current model.
Click a tile to make that lattice type active.

### 4. Generate

Click "Generate Lattice" (or press `G`). Computation runs in background Web Workers with
progress, time estimates, and run logs (drawer in the status bar). Hotkeys `1`–`4` switch
viewer modes (Original, Solid, Cross-Section, X-Ray); `H` resets the viewport.

### 5. Validate

After generation, the validation panel shows:
- **Outer Deviation**: max deviation from original surface vs. tolerance
- **Min Thickness**: thinnest feature measured (must exceed min feature size)
- **Manifold/Watertight**: printability check
- **Connectivity**: disconnected fragment detection

### 6. Export

- **Export STL**: binary STL of the lattice result (outward-oriented triangles)
- **Export Project JSON**: parameters, selections, and validation results

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
  backend/
    generation-backend.ts   # Backend capability detection and selection
    webgpu/                 # WebGPU field sampling (flag-gated experiment)
    wasm/                   # WASM backend scaffold (not active; see docs/performance)
  workers/
    lattice-worker.ts       # Generation orchestrator (off-main-thread)
    lattice-tile-worker.ts  # One marching-cubes tile per message (CPU tiled backend)
    surface-sample-worker.ts# Poisson surface sampling for hex/tri surface lattices
    validation-worker.ts    # Post-generation validation
  components/
    Viewer3D.tsx            # three.js viewer (react-three-fiber), gizmo, demo grid
    LeftPanel.tsx           # Import, parameters, generate
    RightPanel.tsx          # Validation results
    ViewerControls.tsx      # View modes, cross-section, background
    ExportControls.tsx      # STL / project JSON export
  hooks/
    useLatticeGeneration.ts # Worker lifecycle for generation + validation
    useWorkspaceHotkeys.ts  # Keyboard shortcuts
  store/
    useStore.ts             # Zustand global state + IndexedDB persistence
  types/
    project.ts              # Data model, params, presets, param sanitization
  utils/                    # Export downloads, notifications, browser features
```

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

Unit tests cover the geometry core: STL parsing (including malformed input), marching cubes
(manifoldness, winding orientation, degenerate-triangle handling), BVH signed distances,
lattice SDFs (periodicity, bond geometry), topology analysis, and parameter sanitization.

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
