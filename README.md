# Generative Lattice Design

A web-based tool for generating 3D-printable lattice structures inside arbitrary meshes. Supports TPMS Gyroid and BCC strut lattices with SDF-based geometry processing and marching cubes mesh extraction.

## Quick Start

```bash
npm install
npm run dev
```

Open http://localhost:5173 in your browser.

## How to Use

### 1. Import a Model

- **Upload STL**: Click "Upload STL" to load any STL file (binary or ASCII).
- **Ball Demo**: Click "Ball Demo (R=25mm)" for a pre-configured sphere with optimal settings for SLS/MJF printing.

The app analyzes the mesh for watertightness/manifoldness and auto-repairs if needed.

### 2. Define Constraints

- Switch "Selection Mode" to "Paint Keep-Out" or "Paint Keep-In"
- Click faces on the 3D model to mark them
- "Select All Keep-Out" marks the entire exterior as preserved (default for shell variant)
- Keep-Out faces preserve the original surface (no lattice penetration)
- Keep-In regions stay solid (no lattice)

### 3. Configure Lattice Parameters

**Variant:**
- **Shell + Core (Variant 1)**: Preserves outer shell, fills interior with lattice
- **Implicit Conformal (Variant 2)**: Full SDF pipeline with conformal lattice

**Lattice Types:**
- **TPMS Gyroid**: Triply periodic minimal surface - excellent for powder-based processes
- **BCC Strut**: Body-centered cubic strut lattice - good structural properties

**Process Presets:**
- SLS/MJF: min feature 0.8mm, escape holes 5mm
- SLA/DLP: min feature 0.5mm, escape holes 3.5mm
- FDM: min feature 0.8mm (warns about open lattice)

**Key Parameters:**
- Cell Size: lattice unit cell dimension (default 8mm)
- Shell Thickness: outer shell width (default 1.5mm)
- Wall/Strut Thickness: lattice feature size (default 1.0mm)
- Near-surface densification: gradient to strengthen shell-lattice junction

### 4. Generate

Click "Generate Lattice" to run the computation in a background Web Worker. Progress is shown in real-time.

### 5. Validate

After generation, the validation panel shows:
- **Outer Deviation**: max deviation from original surface (target +/-0.2mm)
- **Min Thickness**: thinnest feature measured (must exceed min feature size)
- **Manifold/Watertight**: printability check
- **Connectivity**: disconnected fragment detection

### 6. Export

- **Export STL**: Binary STL of the lattice result
- **Export Validation Report**: JSON with all check results
- **Export Project JSON**: Full project state including parameters and selections

## Architecture

```
src/
  geometry/             # Core geometry engine
    vec3.ts             # Vector math utilities
    bvh.ts              # BVH acceleration for nearest-triangle queries
    stl-parser.ts       # STL import/export (binary + ASCII)
    mesh-analysis.ts    # Watertight/manifold checks, repair, procedural meshes
    marching-cubes.ts   # Marching cubes ISO-surface extraction
    lattice.ts          # Gyroid TPMS + BCC strut SDF, combined lattice builder
    validation.ts       # Deviation, thickness, manifold, connectivity checks
  workers/
    lattice-worker.ts   # Web Worker for background computation
  components/
    Viewer3D.tsx        # Three.js viewer (react-three-fiber)
    LeftPanel.tsx       # Import, constraints, parameters, generate
    RightPanel.tsx      # Validation, view controls, logs, export
  store/
    useStore.ts         # Zustand global state
  types/
    project.ts          # Data model, params, presets
  utils/
    export.ts           # STL/JSON export utilities
```

## Test Assets

Pre-generated STL files in `public/assets/`:
- `sphere-25mm.stl` - 25mm radius sphere (3968 triangles)
- `sphere-10mm.stl` - 10mm radius sphere (2208 triangles)
- `cube-30mm.stl` - 30mm cube (12 triangles)

Regenerate with: `node scripts/generate-test-assets.mjs`

## Technical Details

### SDF Pipeline (Variant 1: Shell+Core)
1. Compute signed distance field from input mesh (BVH-accelerated)
2. Define shell region: `max(d_obj, -(d_obj + shell_thickness))`
3. Evaluate lattice SDF inside core region
4. Smooth union of shell and core lattice (polynomial smooth-min)
5. Extract mesh via marching cubes at iso=0

### SDF Pipeline (Variant 2: Implicit Conformal)
1. Compute mesh SDF with BVH
2. Shell constraint: `d_obj + shell_thickness`
3. Lattice SDF (gyroid or BCC) confined to object interior
4. Smooth union of shell and confined lattice
5. Marching cubes extraction

### Gyroid Formula
```
f(x,y,z) = sin(2pi*x/L)*cos(2pi*y/L) + sin(2pi*y/L)*cos(2pi*z/L) + sin(2pi*z/L)*cos(2pi*x/L)
```
Wall thickness derived from iso-value `c = wallThickness * pi / cellSize`.

### Validation
- Outer deviation: sample surface points, measure distance to original
- Min thickness: ray march along normals to measure wall/strut width
- Manifold: edge-count analysis (each edge shared by exactly 2 triangles)
- Connectivity: flood-fill on triangle adjacency graph
