# OpenLattice3D — `main` branch code review

_Generated 2026-06-22. 83 verified findings (CONFIRMED/PLAUSIBLE) from a 22-angle finder fan-out + adversarial verification + gap sweep. 14 candidates were REFUTED and dropped._

**Severity:** 3 critical · 27 high · 29 medium · 24 low

## CRITICAL (3)

### `src/components/LeftPanel.tsx:75` — JSON project/param import copies values by key presence only, with no type/range validation, so untrusted or hand-edited JSON injects invalid values into LatticeParams.
*CONFIRMED · correctness*

**Failure:** User imports a JSON with {"latticeType":"foo"} (typo or hostile). It passes the `key in params` filter and is applied via store.importParams. On the next generate, buildLatticeEvaluator (src/geometry/lattice.ts:484) has no default case, returns undefined, and latticeFn(x,y,z) at lattice.ts:877 throws "latticeFn is not a function", crashing generation. Similarly {"cellSize":0} yields k = TWO_PI/0 = Infinity (lattice.ts:486) → all-NaN SDF → empty/garbage mesh; a string cellSize propagates NaN everywhere. The ProjectData/LatticeParams types in types/project.ts are never used to validate any of this.

**Evidence:** `if (key in params) {`

### `src/geometry/lattice.ts:200` — Diamond strut endpoints are wrapped per-axis with %L, turning short boundary-crossing tetrahedral struts into long wrong-direction diagonals across the cell.
*CONFIRMED · correctness*

**Failure:** For FCC node f=[0,0,0] and offset o=[-2,-2,2] (L=8), the true strut goes to [-2,-2,2] (length 3.46) but the code builds a segment [0,0,0]->[6,6,2] (length 8.72). A brute-force comparison of the wrapped single-cell SDF against the true periodic diamond distance gives a max error of 5.8mm in an 8mm cell: solid material is placed along incorrect diagonals (e.g. the midpoint [3,3,1] reports distance 0 = solid) while the real boundary-crossing struts are missing. Diamond is user-selectable (LeftPanel/Viewer3D), so the generated diamond lattice is grossly wrong in normal use.

**Evidence:** `const tx = ((f[0] + o[0]) % L + L) % L;`

### `src/geometry/stl-parser.ts:36` — Binary STL trusts the on-disk triangle count to size allocations without validating it against the actual buffer length, so a corrupt/truncated header crashes or OOMs.
*PLAUSIBLE · correctness*

**Failure:** A file is misrouted to parseBinarySTL (e.g. a non-'solid' ASCII file, or the line-27 catch fallback) where bytes 80-83 happen to encode a huge integer like 0xFFFFFFFF. `new Float32Array(triCount * 9)` then tries to allocate ~38 billion floats and throws `RangeError: Invalid array length` / OOM, or for a merely-truncated valid binary file the read loop walks past the buffer and `view.getFloat32` throws RangeError mid-parse. Either way import dies instead of reporting a clean parse error.

**Evidence:** `const triCount = view.getUint32(80, true);   const positions = new Float32Array(triCount * 9);`

## HIGH (27)

### `src/components/Viewer3D.tsx:1106` — The OrbitControls 'change' save listener captures camera changes caused by AutoFit/GizmoCameraReset (which are not guarded by applyingPersistedCameraRef), clobbering the user's persisted camera with the auto-fit/gizmo pose.
*CONFIRMED · correctness*

**Failure:** User saves a custom camera angle (persisted as viewerCameraState). On reload, AutoFit (a separate component, not gated by ViewerCameraSession's applyingPersistedCameraRef ref) repositions the camera to the ISO fit and calls controls.update(), firing 'change'. saveCameraState's 200ms debounce then captures whatever pose is live when it fires and writes it via setViewerCameraState, overwriting the user's saved view. The same path fires whenever the user hits the reset-viewport hotkey (viewportResetSignal), so a 'reset' silently overwrites the persisted camera with the ISO pose.

**Evidence:** `this.dispatchEvent( _changeEvent );`

### `src/components/Viewer3D.tsx:417` — BufferGeometry instances created in useMemo (and the XRay material) are never disposed, leaking GPU memory on every result-mesh regeneration.
*CONFIRMED · memory*

**Failure:** Each lattice regeneration produces a new `result` object; the `useMemo` in ResultMeshView/CrossSectionView/XRayView/OriginalMeshView/SampleMeshView builds a fresh THREE.BufferGeometry (XRayView also a fresh MeshBasicMaterial). R3F only auto-disposes primitives declared as JSX children, not objects passed via the `geometry`/`material` props, so the previous geometry/material are dropped without `.dispose()`. Repeatedly tweaking parameters and regenerating steadily grows GPU buffer memory until the context is lost.

**Evidence:** `root[key] = value;`

### `src/components/Viewer3D.tsx:341` — BufferGeometry created in useMemo is never disposed when its inputs change or the component unmounts, leaking GPU memory.
*CONFIRMED · memory*

**Failure:** User repeatedly edits the imported mesh / toggles keep-out triangles. Each change to `mesh`/`keepOutTris` makes useMemo build a brand-new THREE.BufferGeometry (with a position and color attribute) while the previous geometry's GPU buffers are dropped without .dispose(). After dozens of edits the WebGL context accumulates orphaned VBOs and VRAM climbs until the page slows or the context is lost. The same pattern (new BufferGeometry in useMemo, no disposal effect) repeats in SampleMeshView (389), ResultMeshView (417), CrossSectionView (434), XRayView (484), and DemoTileViewerWithMode (1144).

**Evidence:** `const geom = useMemo(() => {     const g = new THREE.BufferGeometry();     g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));     ...     g.setAttribute('color', new THREE.BufferAttribute(colors, 3));     g.computeVer`

### `src/components/Viewer3D.tsx:491` — XRayView creates a MeshBasicMaterial via useMemo but never calls .dispose(), so the material leaks every time the view unmounts or the material is replaced.
*CONFIRMED · memory*

**Failure:** User switches viewMode between 'xray' and other modes (a common toggle). Each time XRayView mounts it allocates a new THREE.MeshBasicMaterial; on unmount React drops the reference but three.js still holds the compiled program/uniforms on the GPU because there is no cleanup effect calling material.dispose(). Repeated toggling steadily leaks materials/shader programs. (JSX-declared materials elsewhere are auto-disposed by R3F, but this hand-constructed one is not.)

**Evidence:** `const material = useMemo(() => new THREE.MeshBasicMaterial({ color: '#3388cc', side: THREE.DoubleSide, transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending, }), []);`

### `src/components/Viewer3D.tsx:417` — BufferGeometry (and materials) created in useMemo and attached via the geometry/material prop are never disposed, leaking GPU buffers every time the mesh/result changes.
*CONFIRMED · memory*

**Failure:** User generates a lattice, tweaks a parameter, and regenerates. Each regeneration produces a new resultMesh, so ResultMeshView/CrossSectionView/XRayView re-run useMemo and build a brand-new THREE.BufferGeometry; React Three Fiber only auto-disposes geometries it constructs from JSX (<bufferGeometry/>), not objects assigned imperatively via geometry={geom}. The previous geometry's VBOs are never freed, so repeated generation steadily grows VRAM until the context is lost or the tab crashes. XRayView's MeshBasicMaterial and DemoTileViewerWithMode's geometries leak the same way.

**Evidence:** `const geom = useMemo(() => { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(result.positions, 3)); g.computeVertexNormals(); return g; }, [result]);`

### `src/geometry/bvh.ts:459` — signedDistance picks the inside/outside sign from a single closest face normal, which gives the wrong sign when the closest point lies on a shared edge or vertex (the classic pseudonormal problem).
*CONFIRMED · correctness*

**Failure:** For a closed CAD-style mesh with sharp features, a query point whose nearest point falls on an edge shared by two triangles can dot against the 'wrong' adjacent face normal: e.g. a point just outside a convex edge whose closest point is the edge midpoint, where the selected triangle's face normal points away from the query, yields dot < 0 -> sign = -1 (reported inside) even though the point is outside. This flips the SDF sign at thin/sharp regions, producing spurious filled voids or holes in the generated lattice. The correct fix is an angle-weighted pseudonormal (or the ray-cast fallback) rather than a single face normal.

**Evidence:** `const sign = dx * nx + dy * ny + dz * nz >= 0 ? 1 : -1;`

### `src/geometry/marching-cubes.ts:343` — Triangle winding (and the derived per-facet normals) are inverted relative to the SDF sign convention, so emitted facets face inward instead of outward.
*CONFIRMED · correctness*

**Failure:** With the codebase-wide SDF convention 'negative = inside' (lattice.ts returns `inside ? -minDist : minDist`) and the bit rule `if (v < isoValue) cubeIndex |= bit`, take cubeIndex=1 (only corner 0 inside at the origin). TRI_TABLE[1]=[0,8,3] yields vertices V0=edge0~(0.5,0,0), V1=edge8~(0,0,0.5), V2=edge3~(0,0.5,0); (V1-V0)x(V2-V0)=(-0.25,-0.25,-0.25), which points toward the inside corner (inward), while the true outward normal is (+,+,+). The complement case (cubeIndex=254) is consistent. The viewer hides this because Viewer3D.tsx calls computeVertexNormals() and uses side=DoubleSide, but downloadSTL -> exportBinarySTL (stl-parser.ts:95-105) writes these vertices and normals verbatim, producing inside-out STL files; repairMesh (mesh-analysis.ts:78-95) recomputes from the same winding so it does not fix it. Slicers and mesh tools read the exported lattice as inverted/inside-out.

**Evidence:** `writeOffset = emitCubeTriangles(TRI_TABLE[cubeIndex], edgeVerts, positions, writeOffset);`

### `src/geometry/mesh-analysis.ts:48` — Watertight detection only checks for edges used exactly once (count===1); edges shared by 3+ triangles (non-manifold) leave isWatertight=true, so a non-manifold mesh is reported watertight.
*CONFIRMED · correctness*

**Failure:** Import a mesh with a T-junction or internal overlapping face where one edge is shared by 3 triangles and no edge is a boundary edge. Every edgeCount is either 2 or 3, so the count===1 branch never fires: isManifold becomes false but isWatertight stays true. The UI shows 'Watertight: Yes' and the repair branch decisions are made on a wrong watertight verdict for a geometrically non-closed/non-manifold surface.

**Evidence:** `if (count !== 2) { isManifold = false; if (count === 1) isWatertight = false; }`

### `src/geometry/mesh-analysis.ts:23` — Empty mesh produces a bounding box of [+Infinity..-Infinity] because the min/max sentinels are never updated and there is no triCount===0 guard.
*CONFIRMED · edge-case*

**Failure:** A user imports an STL whose header reports 0 triangles (or a corrupt/empty file parsed to triCount 0). positions.length is 0, so the loops never run; boundingBox.min stays [Infinity,Infinity,Infinity] and max stays [-Infinity,-Infinity,-Infinity]. LeftPanel logs 'Bounding box: [Infinity,Infinity,Infinity] to [-Infinity,...]' and any downstream domain sizing/scaling that subtracts max-min yields NaN/-Infinity, corrupting the lattice domain.

**Evidence:** `const bbMin: Vec3 = [Infinity, Infinity, Infinity];`

### `src/geometry/stl-parser.ts:15` — ASCII detection builds the header string via String.fromCharCode(...header) over up to 80 bytes and only checks startsWith('solid'), a fragile heuristic that misclassifies common files.
*CONFIRMED · correctness*

**Failure:** Many binary STL exporters (older Magics/SolidWorks) write the literal text 'solid' into the 80-byte header. Such a binary file with byteLength>84 enters the ASCII branch; if its bytes 80-83 don't match expectedBinarySize it falls into parseASCIISTL, where the facet regex finds zero matches and returns a silent empty mesh (triCount 0) instead of the real geometry. Detection is purely prefix-based with no 'facet'/'endsolid' confirmation.

**Evidence:** `const headerStr = String.fromCharCode(...header);   if (headerStr.startsWith('solid') && buffer.byteLength > 84) {`

### `src/geometry/stl-parser.ts:27` — When ASCII parsing 'succeeds' but matches nothing it returns an empty mesh rather than throwing, so the binary fallback never triggers and a valid ASCII parse failure is masked.
*CONFIRMED · correctness*

**Failure:** parseASCIISTL never throws on malformed/unmatched content — it returns {triCount:0} when the regex matches zero facets. So for any 'solid'-prefixed file that isn't byte-size-matched as binary, the try block returns an empty mesh; the catch->parseBinarySTL safety net on line 27 is dead code, and the user gets a 0-triangle import silently passed to analyzeMesh/repairMesh instead of an error.

**Evidence:** `    try {       return parseASCIISTL(buffer);     } catch {       return parseBinarySTL(buffer);     }`

### `src/geometry/stl-parser.ts:40` — No check that the buffer actually contains triCount*50 bytes of facet data before the read loop, so a truncated binary STL reads past the end of the DataView.
*CONFIRMED · edge-case*

**Failure:** A binary STL whose declared triCount is correct but whose tail was cut off (partial upload / damaged download) reaches the loop; on the last triangle `view.getFloat32(vOff + 8, true)` at offset 84+triCount*50-6 exceeds buffer.byteLength and throws an uncaught RangeError, surfacing only as a generic 'Import failed' rather than 'truncated file'.

**Evidence:** `positions[i * 9 + v * 3 + 2] = view.getFloat32(vOff + 8, true);`

### `src/geometry/validation.ts:250` — Thickness march overshoots struts thinner than one step (0.1*minRequired), so the too-thin struts it is meant to detect are silently excluded from minMeasured.
*CONFIRMED · correctness*

**Failure:** A strut whose total thickness is below stepSize = minRequired*0.1 (e.g. a strut 0.04 mm thick when minRequired = 0.5 mm). Starting from the surface centroid, the first inward step of 0.05 mm jumps clean through the strut and out the far side, so sdf(p) returns val > 0 on the very first sample; enteredMaterial never becomes true and the strut is skipped (line 262 requires enteredMaterial). The thinness check therefore fails to record exactly the sub-minimum struts it exists to flag.

**Evidence:** `p = add(p, scale(nn, -stepSize));  // inward`

### `src/hooks/useLatticeGeneration.ts:181` — The main lattice worker has no onerror handler, so a worker-level failure leaves generating=true forever and leaks the worker.
*CONFIRMED · correctness*

**Failure:** If the lattice worker fails to load or throws an uncaught error at module-init time (e.g. the dynamically imported WebGPU backend module throws on import, or a build/syntax error in a transitively imported worker module), no message of type 'error' is ever posted and the try/catch inside the worker never runs. With only worker.onmessage set and no worker.onerror, the main thread never observes the failure: store.generating stays true, the UI stays frozen showing the 'Cancel' button, setProgress stays at 'Starting...', and workerRef.current holds a dead worker that is never terminated.

**Evidence:** `worker.onmessage = (e: MessageEvent<WorkerResponse>) => {`

### `src/hooks/useLatticeGeneration.ts:155` — Validation worker results are applied unconditionally even after the result mesh they validated has been replaced or cleared, producing stale validation.
*CONFIRMED · concurrency*

**Failure:** Run A completes generation (setGenerating(false)) and starts a slow validation worker A. Before A finishes, the user imports a new mesh: setOriginalMesh sets resultMesh:null and validation:null. Validation worker A then completes and calls current.setValidation(validationResp.validation), re-populating the validation panel with results computed against the now-discarded mesh. There is no run-id/epoch guard tying the validation response to the result it was computed for, so stale validation is shown for a mesh that no longer exists.

**Evidence:** `current.setValidation(validationResp.validation || null);`

### `src/store/useStore.ts:673` — Async IndexedDB hydration unconditionally overwrites store state with the saved snapshot, clobbering any user action that occurred during the async load.
*CONFIRMED · concurrency*

**Failure:** On page load the store is created synchronously, then hydratePersistence() awaits IndexedDB. If the user loads a new mesh or clicks a sample shape before the DB read resolves, setOriginalMesh/setSampleShape update state but schedulePersistence is a no-op because persistenceReady is still false. When the awaited snapshot finally arrives, useStore.setState(hydrateFromSnapshot(snapshot)) blindly overwrites originalMesh/params/sampleShape with the STALE persisted values, silently discarding the user's just-loaded mesh and selections.

**Evidence:** `if (snapshot) useStore.setState(hydrateFromSnapshot(snapshot));`

### `src/utils/export.ts:56` — Project export writes selectionMask (keep-out/keep-in triangle indices) but the JSON importer only reads data.parameters, so the selection mask is silently lost on every export/import round-trip.
*CONFIRMED · correctness*

**Failure:** User marks keep-out/keep-in faces, exports lattice-project.json (which includes selectionMask.keepOut/keepIn), later re-imports that same file. handleJsonImport in LeftPanel.tsx:69 reads only `data.parameters || data` and applies it via importParams; it never touches selectionMask, so keepOutTris/keepInTris stay empty. The user's face selections are silently discarded, producing a different lattice than the saved project.

**Evidence:** `const params: Partial<LatticeParams> = data.parameters || data;`

### `src/workers/lattice-worker.ts:280` — Same non-monotonic cumulative-area bug in buildMeshSampler: keep-out triangles store areas[i]=0, corrupting pickTriangle's binary search and biasing surface-sample distribution.
*CONFIRMED · correctness*

**Failure:** Identical defect to surface-sample-worker, on the fallback in-worker mesh sampler used when generatePoissonSamplesParallel under-produces. With keep-out triangles at interior indices, `areas` is non-monotonic, so pickTriangle returns wrong triangle indices and the relaxed/lattice surface samples are not area-proportional; runs of keep-out indices can resolve onto an excluded triangle, defeating the keep-out selection for conformal hex/triangle lattices.

**Evidence:** `if (keepOutTris.has(i)) continue;`

### `src/workers/lattice-worker.ts:286` — buildMeshSampler builds a cumulative-area array that is non-monotonic when keep-out triangles exist, so the binary-search pickTriangle returns wrong/keep-out triangles.
*CONFIRMED · correctness*

**Failure:** User imports a mesh, marks some triangles keep-out, and selects an implicit_conformal hexagon/triangle lattice. In buildMeshSampler the loop does `if (keepOutTris.has(i)) continue;` leaving `areas[i]` at its default 0, so `areas` becomes e.g. [5,0,12,0,20] — not sorted. pickTriangle does a binary search assuming a non-decreasing array, so it returns incorrect indices and can select a keep-out triangle (offset triIndex*9 reads a triangle that was supposed to be excluded), placing surface samples on forbidden regions and biasing the distribution.

**Evidence:** `if (keepOutTris.has(i)) continue;   ...   areas[i] = totalArea;   ...   if (r <= cumulativeAreas[mid]) hi = mid; else lo = mid + 1;`

### `src/workers/lattice-worker.ts:280` — buildMeshSampler writes a cumulative-area array but leaves zeros at keep-out triangle indices, producing a non-monotonic array that breaks the binary search in pickTriangle.
*CONFIRMED · correctness*

**Failure:** Import a custom mesh, enable a surface-polygon lattice (hexagon/triangle, implicit_conformal) and mark some faces as keep-out. `areas[i]` is only assigned for non-keep-out tris, so keep-out indices stay 0, making `areas` non-ascending. `pickTriangle`'s lower-bound binary search then returns wrong/keep-out indices, so surface hex samples are generated from the wrong triangle's vertices/normal — placing holes in incorrect locations (including on faces the user excluded).

**Evidence:** `if (keepOutTris.has(i)) continue;     ...     totalArea += triangleArea(a, b, c);     areas[i] = totalArea;`

### `src/workers/surface-sample-worker.ts:0` — meshSamplerFromMessage has the same non-monotonic cumulative-area array bug, so the parallel mesh sampling worker also picks wrong/keep-out triangles.
*CONFIRMED · correctness*

**Failure:** When generatePoissonSamplesParallel dispatches mesh-mode jobs, meshSamplerFromMessage skips keep-out triangles via `if (keepOut.has(i)) continue;` leaving areas[i]=0, producing a non-monotonic Float32Array that pickTriangle binary-searches. For any mesh with keep-out triangles selected, the parallel path returns samples on/near excluded triangles and a non-uniform distribution; because this is the primary (parallel) path, it is hit before the synchronous fallback whenever it returns >=80% of the target count.

**Evidence:** `if (keepOut.has(i)) continue;`

### `src/workers/surface-sample-worker.ts:219` — Keep-out triangles leave their cumulative-area slot at the default 0, destroying the monotonic prefix-sum invariant that pickTriangle's binary search depends on, so area-weighted triangle selection becomes wrong.
*CONFIRMED · correctness*

**Failure:** User clicks one or more interior faces to mark them keep-out (a common workflow per Viewer3D keepOutTris). In meshSamplerFromMessage the loop does `if (keepOut.has(i)) continue;` and never writes areas[i], so areas[i] stays 0 while neighbors hold the running cumulative sum. Example tris: tri0 area 10 -> areas[0]=10, tri1 keep-out -> areas[1]=0, tri2 area 10 -> areas[2]=20, totalArea=20. The array [10,0,20] is non-monotonic, so pickTriangle's binary search misbehaves: for r=5 it returns index 2 instead of 0, meaning tri0 can NEVER be sampled, and a keep-out triangle index (whose areas[]=0) can itself be returned and sampled. Result: surface samples are biased/absent on whole regions and can land on faces the user explicitly excluded.

**Evidence:** `if (keepOut.has(i)) continue;`

### `src/workers/surface-sample-worker.ts:225` — Keep-out triangles leave zeros in the cumulative-area array, breaking pickTriangle's binary search so area-proportional surface sampling is mis-weighted (and can even hit excluded faces).
*CONFIRMED · correctness*

**Failure:** User imports a mesh, marks some interior-indexed triangles as keep-out, and selects an 'implicit_conformal' hexagon/triangle lattice. buildMeshSampler/meshSamplerFromMessage skip keep-out tris with `if (keepOut.has(i)) continue;`, leaving `areas[i] = 0` (the Float32Array default) at those indices. The cumulative array is therefore non-monotonic (e.g. [10, 0, 30]). pickTriangle assumes a sorted cumulative array; with a random r=5 it binary-searches to index 2 instead of index 0, so surface samples (and thus lattice hole placement) are distributed wrong, over-representing triangles that follow keep-out tris in index order. For runs of consecutive keep-out indices it can also resolve to a keep-out triangle, placing samples on faces the user explicitly excluded.

**Evidence:** `if (keepOut.has(i)) continue;`

### `src/workers/validation-worker.ts:135` — Outer-deviation validation is a silent no-op (always passes, maxDeviation 0) for every procedural shape except 'sphere'.
*CONFIRMED · correctness*

**Failure:** User validates a lattice generated for a 'cube', 'cylinder', 'torus', or 'capsule' sample shape. runProceduralValidation only runs checkSphereDeviation when shape==='sphere'; for all other shapes it hard-codes { passed: true, maxDeviation: 0 }. A lattice surface that pokes far outside the cube/cylinder/torus/capsule envelope (e.g. 5 mm past a 0.2 mm tolerance) is reported as deviation = 0 and overall passed = true, so the deviation gate never catches an out-of-tolerance result for 4 of the 5 procedural shapes.

**Evidence:** `const outerDeviation = shape === 'sphere'       ? checkSphereDeviation(result, msg.sphereRadius || 25, msg.params.toleranceMm)       : { passed: true, maxDeviation: 0 };`

### `src/backend/webgpu/webgpu-backend.ts:418` — The 1-D dispatchWorkgroups count is uncapped and exceeds the WebGPU maxComputeWorkgroupsPerDimension limit (default 65535) at moderately high resolutions, failing the dispatch.
*PLAUSIBLE · correctness*

**Failure:** exportResolution 6 ('Ultra') yields resolution = 24 + 24*6 = 168, so fieldLength = 169^3 = 4,826,809 and dispatchWorkgroups(ceil(4826809/64)) = 75,419 workgroups in X, which is > the 65535 per-dimension limit -> WebGPU emits a validation error, mapAsync never gets correct data / submit fails, and field generation crashes. The MAX_FIELD_BYTES (256MiB) cap does not catch it: that field is only ~19MiB. Any resolution >= 161 (exportResolution >= 6) is affected. Currently gated behind ENABLE_WEBGPU_FIELD_CPU_MC=false, so it is latent until the flag is enabled.

**Evidence:** `pass.dispatchWorkgroups(Math.ceil(fieldLength / FIELD_WORKGROUP_SIZE));`

### `src/backend/webgpu/webgpu-backend.ts:370` — Every sampleFieldWebGPU / smoke-test call requests a brand-new GPUAdapter+GPUDevice that is never cached and never destroyed, leaking a full device per invocation.
*PLAUSIBLE · memory*

**Failure:** initializeWebGpu() (line 124-134) calls requestAdapter()+requestDevice() with no caching and is invoked fresh on every sampleFieldWebGPU call; the finally block (lines 438-442) destroys only paramsBuffer/fieldBuffer/readbackBuffer, not the device. Repeated regenerations (the normal edit-tweak-regenerate loop) accumulate abandoned GPUDevices; combined with no device.lost handler, a backend that hits the per-process device limit will start failing requestDevice and the field path silently degrades. runWebGpuSmokeTest has the same leak.

**Evidence:** `const context = await initializeWebGpu();`

### `src/store/useStore.ts:683` — The global subscriber persists the entire app state (originalMesh + resultMesh Float32Arrays) on every state change, including rapid progress/log updates during generation.
*PLAUSIBLE · efficiency*

**Failure:** During lattice generation the worker calls setProgress and addLog many times per second (useLatticeGeneration.ts lines 185-186). Each call fires the subscribe callback -> schedulePersistence; although debounced to 250ms, the debounced write runs buildPersistedAppState which deep-copies originalMesh.positions/normals and resultMesh.positions/normals (potentially millions of floats) into an IndexedDB structured clone on every settle, causing main-thread jank and excessive IndexedDB churn.

**Evidence:** `void savePersistedAppState(buildPersistedAppState(state));`

## MEDIUM (29)

### `src/backend/webgpu/webgpu-backend.ts:137` — runWebGpuSmokeTest awaits initializeWebGpu (which calls requestDevice) outside its try/catch, so a device-request rejection escapes instead of returning the documented { ok:false, reason } result.
*CONFIRMED · correctness*

**Failure:** On a machine where navigator.gpu and an adapter exist but requestDevice() rejects (e.g. device lost during creation, or a browser that throws on unsupported features), line 137 throws before the try block at line 151, so runWebGpuSmokeTest rejects with an unhandled error rather than returning WebGpuSmokeTestResult{ok:false}. Callers expecting a result object to drive fallback see an exception instead.

**Evidence:** `const context = await initializeWebGpu(scope);`

### `src/components/LeftPanel.tsx:69` — JSON import copies values by key presence only, applying no type/range validation or NaN/zero guard, so a malformed file can inject 0, negative, NaN, or absurd parameters that bypass the UI's `|| default` fallbacks.
*CONFIRMED · correctness*

**Failure:** User imports a JSON containing {"cellSize": 0} or {"exportResolution": 99999}; the loop copies it because the key is in DEFAULT_PARAMS, importParams stores it unchanged, and on Generate the worker divides by cellSize=0 (Infinity/NaN coordinates) or builds a resolution≈2.4M grid, crashing or hanging generation — the UI input fallbacks (`|| 8`) never run because the value never passes through onChange.

**Evidence:** `if (key in params) {           (filtered as Record<string, unknown>)[key] = params[key];           count++;         }`

### `src/components/LeftPanel.tsx:256` — Number inputs fall back to a hardcoded literal default instead of clamping or preserving the prior value, so transiently clearing a field discards a previously imported/edited value.
*CONFIRMED · edge-case*

**Failure:** User imports a project JSON with cellSize=20, then clicks into the Cell Size field and clears it to retype: the moment the input is empty, parseFloat('') is NaN so `|| 8` snaps cellSize to 8 (not 20), overwriting the imported value; the same pattern affects surfaceDepth (293,→8), shellThickness (307,→1.5), wallThickness (321,→1.0), strutDiameter (333,→1.0), minFeatureSize (346,→0.8) and toleranceMm (358,→0.2).

**Evidence:** `onChange={(e) => store.updateParams({ cellSize: parseFloat(e.target.value) || 8 })}`

### `src/components/LeftPanel.tsx:255` — The HTML min/max/step attributes on the numeric parameter inputs are not enforced in onChange (nor in the store/worker), so out-of-range values pass straight into geometry generation.
*CONFIRMED · correctness*

**Failure:** User types or pastes 0.4 into Cell Size (min=2) or 500 into a thickness field; updateParams stores it verbatim and the worker uses cellSize as a divisor (Math.floor(x / cellSize) in lattice-worker.ts ~line 599/607-609) and resolution = round(24 + exportResolution*24), so a tiny cellSize or a JSON-imported huge exportResolution produces an enormous grid / runaway compute or degenerate geometry, with no clamp anywhere to stop it.

**Evidence:** `onChange={(e) => store.updateParams({ cellSize: parseFloat(e.target.value) || 8 })}`

### `src/components/Viewer3D.tsx:444` — CrossSectionView rebuilds a THREE.Plane and reassigns material.clippingPlanes every single frame via useFrame, allocating garbage at 60fps even when nothing changed.
*CONFIRMED · efficiency*

**Failure:** Whenever a cross-section is shown, useFrame runs clipStateTo3(clip, bounds) on every animation frame, allocating a new THREE.Vector3 and THREE.Plane and replacing the material.clippingPlanes array 60 times per second, regardless of whether `clip` or `bounds` actually changed. With 12 demo tiles each rendering a CrossSectionView this multiplies into continuous per-frame allocation and GC pressure; the already-memoized `plane` (line 442) is computed but unused for the live material, so the work is pure waste.

**Evidence:** `useFrame(() => { const p = clipStateTo3(clip, bounds); if (meshRef.current) { const mat = meshRef.current.material as THREE.MeshPhongMaterial; mat.clippingPlanes = [p]; } });`

### `src/components/Viewer3D.tsx:444` — CrossSectionView's useFrame allocates a new THREE.Plane every frame and reassigns material.clippingPlanes, doing per-frame work even when the clip plane is static.
*CONFIRMED · efficiency*

**Failure:** While the cross-section view is mounted, `clipStateTo3` runs on every rendered frame (60fps) constructing a new Vector3+Plane and rebuilding the `[p]` array, even though `plane` is already memoized from the same `clip`/`bounds`. This is pure churn (GC pressure) since the memoized `plane` passed as the JSX prop is overwritten each frame regardless of whether `clip` changed.

**Evidence:** `const p = clipStateTo3(clip, bounds);`

### `src/components/Viewer3D.tsx:999` — AutoFit overwrites the camera independently of ViewerCameraSession's persisted-camera restore, with no coordination, so a saved camera pose can be clobbered back to iso-fit.
*CONFIRMED · correctness*

**Failure:** On load with a persisted viewerCameraState, ViewerCameraSession's effect restores the saved camera (position/target/up/zoom) and guards re-saves with applyingPersistedCameraRef. But AutoFit runs its own useEffect keyed on store.originalMesh / sampleShape / viewport size and unconditionally sets camera.up=ISO_VIEW_UP and an iso-fit position whenever any of those deps change (e.g. the mesh finishes loading after the camera was restored, or the canvas is resized). AutoFit never checks applyingPersistedCameraRef, so it silently discards the user's restored viewpoint and snaps to isometric, defeating camera persistence.

**Evidence:** `camera.up.copy(ISO_VIEW_UP);`

### `src/geometry/bvh.ts:452` — signedDistance does not handle closestPoint returning triIndex = -1 (empty mesh / nothing found), reading normals[-3] (undefined) and returning NaN * Infinity.
*CONFIRMED · edge-case*

**Failure:** If a MeshBVH is built with triCount = 0 (callers at lattice-worker.ts:1188 and validation-worker.ts:184 do not guard against an empty mesh), the root node's bounds are the inverted [Infinity, -Infinity] sentinel, so closestPoint prunes the root immediately and returns { triIndex: -1, distance: Infinity }. signedDistance then computes ni = -1 * 3 = -3, reads this.normals[-3] which is undefined, so nx/ny/nz become NaN, the dot product is NaN, sign resolves to -1, and it returns -Infinity. Every SDF sample then propagates NaN/Infinity into the lattice field, corrupting the entire marching-cubes result instead of failing fast.

**Evidence:** `const ni = res.triIndex * 3;`

### `src/geometry/lattice.ts:163` — Octet truss omits the face-center-to-face-center (octahedron) struts, generating only the 24 face-center-to-corner segments, so the result is not a true octet truss.
*CONFIRMED · correctness*

**Failure:** The nested loop only iterates faceCenters x corners, so adjacent face centers such as [h,h,0] and [h,0,h] (separation h*sqrt2, identical to the kept struts) are never connected. A real octet truss requires these octahedron edges; without them the lattice has far fewer struts than advertised ('stiffest periodic strut lattice ... nearly isotropic'), yielding a more compliant and anisotropic structure than the user expects when selecting 'octet'.

**Evidence:** `for (const fc of faceCenters) {       for (const cn of corners) {`

### `src/geometry/lattice.ts:133` — Strut SDFs allocate per-sample Vec3 arrays inside the hot path; these types are not covered by the optimized grid sampler so they hit the scalar route on every grid sample.
*CONFIRMED · efficiency*

**Failure:** bccStrutSDF allocates `center` and an `[lx,ly,lz]` array, and distToSegment is called with array args, for each of ~20 segments per sample; diamondStrutSDF allocates a fresh `[tx,ty,tz]` array on each of its 16 inner iterations; octetSDF/surfaceHexHolesSdf likewise allocate Vec3s per sample/bucket. Only TPMS types get attachTpmsGridSampler, so strut/voronoi/hex types evaluate scalar over (resolution+1)^3 samples (millions), generating millions of short-lived arrays and heavy GC pressure that stalls generation.

**Evidence:** `const center: Vec3 = [L/2, L/2, L/2];`

### `src/geometry/lattice.ts:217` — voronoiSDF (and every cellSize-based SDF) produces NaN/Infinity when cellSize is 0, with no clamp on the path from params to the evaluators.
*CONFIRMED · correctness*

**Failure:** cellSize is only coerced away from 0 at one UI input via `parseFloat(...) || 8`; PROCESS_DEFAULTS overrides, project import, and the worker pass params straight through with no clamping (useStore.updateParams does not clamp). With cellSize=0, voronoiSDF computes invL=1/0=Infinity, then Math.floor(x*Infinity)=NaN for ix/iy/iz, so every sample is NaN; the TPMS evaluators likewise get k=TWO_PI/0=Infinity and c=Infinity, yielding an all-NaN field and a crash/empty mesh in marching cubes.

**Evidence:** `const invL = 1 / cellSize;`

### `src/geometry/mesh-analysis.ts:8` — Edge/vertex quantization rounds to 1e4 (0.1 micron) absolute, so coincident vertices farther apart than that are split and distinct vertices closer than that are welded, corrupting edge counts and the manifold/watertight verdict.
*CONFIRMED · correctness*

**Failure:** An STL whose adjacent triangles share a vertex that differs by float rounding of ~2e-4 in a coordinate (common in meshes exported in mm at large coordinate magnitudes) produces two different quantized keys for what is the same shared edge. Each shared edge is then counted as two separate count===1 boundary edges, so a perfectly watertight closed mesh is reported isWatertight=false and isManifold=false, triggering an unnecessary 'repair' warning. The threshold is also unit-blind (absolute, not relative to mesh scale).

**Evidence:** `const q = (v: number) => Math.round(v * 1e4);`

### `src/geometry/mesh-analysis.ts:48` — Manifold check ignores triangle winding/edge orientation, so it cannot detect inconsistently-oriented (flipped-normal) neighbors and miscounts degenerate triangles as valid topology.
*CONFIRMED · correctness*

**Failure:** A mesh where two adjacent triangles share an edge but are wound the same direction (a normal-flip / non-orientable seam) still produces edgeCount===2 for that edge because edgeKey is order-independent (a<b sorted). The mesh is reported isManifold=true and isWatertight=true even though it is not consistently orientable, so the orientation defect silently passes validation and later breaks SDF inside/outside tests that rely on consistent winding.

**Evidence:** `return ak < bk ? `${ak}-${bk}` : `${bk}-${ak}`;`

### `src/geometry/stl-parser.ts:46` — Vertex coordinates are stored without any isFinite/NaN guard, so NaN or Infinity in the file silently corrupts the mesh and all downstream bounding-box / BVH math.
*CONFIRMED · correctness*

**Failure:** An STL containing a NaN float (0x7FC00000 in a binary vertex, or 'NaN'/'1e999' surviving parseFloat in ASCII) is read into positions. analyzeMesh's bounding box min/max comparisons become NaN, BVH spatial splits degenerate, and the lattice/marching-cubes pipeline produces wrong or empty geometry with no error surfaced to the user.

**Evidence:** `positions[i * 9 + v * 3]     = view.getFloat32(vOff, true);`

### `src/geometry/stl-parser.ts:41` — Facet normals are copied verbatim from the file with no validation or recompute, so zero/garbage normals from the source flow straight into the mesh.
*CONFIRMED · correctness*

**Failure:** Many STL writers emit (0,0,0) facet normals expecting the consumer to recompute from vertex winding. parseBinarySTL/parseASCIISTL store those zeros directly into `normals`; downstream rendering/shading and any code that trusts the per-face normal then gets a degenerate normal, producing black/incorrectly-lit faces, since nothing here recomputes cross(v1-v0, v2-v0).

**Evidence:** `normals[i * 3]     = view.getFloat32(offset, true);`

### `src/geometry/validation.ts:267` — When no sample ever enters material, minMeasured falls back to minRequired and the check passes, masking a genuine thickness failure.
*CONFIRMED · correctness*

**Failure:** Combined with the overshoot above (or a mesh whose face normals are all degenerate and skipped at line 242), no sample sets enteredMaterial, so minMeasured stays Infinity. The fallback overwrites it with minRequired, and minRequired >= minRequired*0.9 is true, so minThickness.passed is reported true even though the actual minimum thickness was never measured. A degenerate or extremely thin lattice reports a passing thickness check.

**Evidence:** `if (minMeasured === Infinity) minMeasured = minRequired; // fallback`

### `src/utils/notifications.ts:17` — A failed service-worker registration caches a resolved-null promise forever, so notifications never recover for the rest of the session.
*CONFIRMED · correctness*

**Failure:** On app start App.tsx calls registerNotificationServiceWorker() before /notification-sw.js is reachable (transient 404 during deploy, brief network hiccup, or SecurityError). The IIFE catches the error and returns null; notificationRegistrationPromise is now permanently a Promise<null>. Every later sendNotification() (e.g. 'Lattice generation complete') awaits getNotificationRegistration(), gets null, and falls through to new Notification(...) or silently fails — the SW path is dead for the whole session even though a retry would succeed. The memoization is intended as dedup but it also memoizes failures.

**Evidence:** `if (!notificationRegistrationPromise) {`

### `src/workers/lattice-worker.ts:1156` — await generatePoissonSamplesParallel is not wrapped in try/catch, so a single surface-sample worker module load/runtime error aborts the entire generation instead of falling back to the synchronous sampler.
*CONFIRMED · correctness*

**Failure:** If any of the spawned surface-sample-worker instances fires onerror (e.g. transient module-load failure, OOM during slice() of a large mesh), the per-job Promise rejects, Promise.all rejects, and the unguarded `await` throws out to the top-level catch which posts a 'error' message to the main thread. The robust synchronous fallback generatePoissonSamples right below (line 1168/1236) is never reached, so a recoverable sampling hiccup turns into a full user-visible generation failure.

**Evidence:** `surfaceSamples = await generatePoissonSamplesParallel(`

### `src/workers/lattice-worker.ts:1156` — A rejected surface-sample sub-worker promise propagates out of the await and aborts the whole generation, defeating the intended graceful fallback to the in-worker sampler.
*CONFIRMED · edge-case*

**Failure:** If any of the parallel surface-sample workers fails to load or errors (worker.onerror rejects the per-job promise, Promise.all rejects), the await on generatePoissonSamplesParallel throws. Because the throw happens before the `if (surfaceSamples.length < ...) generatePoissonSamples(fallbackSampler, ...)` fallback line, control jumps to the outer catch and posts a {type:'error'} to the UI, surfacing a hard failure to the user instead of degrading to the single-threaded sampler that was added precisely as a fallback.

**Evidence:** `surfaceSamples = await generatePoissonSamplesParallel(`

### `src/workers/lattice-worker.ts:942` — On cancel during tiled generation, runTiledGeneration's promise can never settle because the cancel message handler terminates tile workers but does not reject the in-flight promise.
*CONFIRMED · concurrency*

**Failure:** While runTiledGeneration is awaiting tile results, the main thread posts {type:'cancel'}; self.onmessage sets cancelled=true and calls terminateTileWorkers(), killing all tile workers. No further onmessage/postNext fires for the dead workers, and postNext's `if (cancelled) reject` is only reached when a worker requests its next job — which now never happens. The runTiledGeneration promise stays pending forever; only the main thread's 50ms terminate of the whole lattice worker eventually frees it, masking the leak but leaving the cancel path relying on external termination rather than clean rejection.

**Evidence:** `const postNext = () => { if (cancelled) { reject(new Error('Cancelled')); return; } ... worker.postMessage(job); };`

### `src/workers/lattice-worker.ts:199` — Poisson sample sub-workers spawned in generatePoissonSamplesParallel are never registered in activeTileWorkers, so a 'cancel' message cannot terminate them and they leak CPU/memory until they finish on their own.
*CONFIRMED · concurrency*

**Failure:** User picks a surface-polygon (hexagon/triangle) lattice on a large cube/mesh, generation enters the surface-sample phase which spawns up to 4 surface-sample-worker instances, then the user clicks Cancel. The 'cancel' handler (line 982) sets cancelled=true and calls terminateTileWorkers(), but activeTileWorkers is empty so the in-flight sample workers keep running a full Poisson batch (targetCount*3 attempts) to completion, wasting cores and memory; only the parent's await ever cleans them up via .finally.

**Evidence:** `const worker = new Worker(new URL('./surface-sample-worker.ts', import.meta.url), { type: 'module' });`

### `src/workers/lattice-worker.ts:982` — On 'cancel' only tile workers are terminated; the surface-sample sub-workers spawned by generatePoissonSamplesParallel are untracked and keep running.
*CONFIRMED · concurrency*

**Failure:** User cancels generation while the worker is awaiting generatePoissonSamplesParallel (conformal hex/triangle on a large mesh/shape). The cancel handler sets `cancelled=true` and calls terminateTileWorkers(), but the up-to-4 surface-sample Workers created at line 203 are never pushed into activeTileWorkers and are only terminated by their own `.finally()` after they finish. They continue consuming CPU until they complete their Poisson sampling, instead of being killed immediately on cancel.

**Evidence:** `const worker = new Worker(new URL('./surface-sample-worker.ts', import.meta.url), { type: 'module' });`

### `src/workers/surface-sample-worker.ts:167` — Capsule end-caps sample a full sphere and merely offset by +/-h, so roughly half of every cap's samples land inside the cylindrical body instead of on the rounded cap surface.
*CONFIRMED · correctness*

**Failure:** For a capsule the top cap should be only the upper hemisphere (sz>=0) translated to centerZ=+h, but the code samples sz over the full [-r,+r] sphere via phi=acos(2v-1). A top-cap point with sz<0 yields z = sz + h which falls below the cap center, i.e. embedded inside the cylinder body region (z in [-h,h]). About 50% of cap samples are therefore interior, not on-surface, and cluster incorrectly; the downstream projectToSurfaceSdf relaxation only partially masks this by snapping them, biasing the final point distribution near the caps.

**Evidence:** `const sz = r * Math.cos(phi);   const top = Math.random() > 0.5;   const centerZ = top ? h : -h;   return { pos: [sx, sy, sz + centerZ], normal: normalize([sx, sy, sz]) };`

### `worker/index.ts:3` — The Cloudflare Worker fallback returns a bare plaintext 404 for every request that does not match a static asset, instead of serving the SPA index.html (no not_found_handling/single-page-application configured in wrangler.json).
*CONFIRMED · correctness*

**Failure:** wrangler.json sets main=worker/index.ts and assets.directory=./dist with no assets.binding and no not_found_handling. Static assets are served first, but any non-asset path (a stale hashed-chunk request after a redeploy, a removed asset, a mistyped URL, or a future client route) falls through to this handler and returns 'Not found' as text/plain. Users hitting such a path get an unstyled 404 rather than the app shell, and there is no SPA fallback to index.html.

**Evidence:** `return new Response('Not found', { status: 404 });`

### `src/backend/wasm/wasm-backend.ts:50` — A 'threaded' WASM request on a non-isolated page returns hard-unavailable instead of gracefully downgrading to the single-threaded module that would actually work.
*PLAUSIBLE · correctness*

**Failure:** Caller invokes loadWasmBackend({ mode: 'threaded', artifactUrl }) on a page that is not crossOriginIsolated (or lacks SharedArrayBuffer). support.threaded is false, so the function returns { available: false } at line 51-56 and never attempts the single-threaded compile, even though support.singleThreaded is true and a working WASM module could have been produced. The promised 'graceful fallback' degrades all the way to CPU when single-threaded WASM was available; the returned result also still carries mode:'threaded', so any caller that inspects result.mode is told threaded mode when nothing was loaded.

**Evidence:** `if (mode === 'threaded' && !support.threaded) {       return { available: false, mode, reason: 'Threaded WASM requires cross-origin isolation and SharedArrayBuffer.', support, };`

### `src/hooks/useLatticeGeneration.ts:214` — cancelGeneration never terminates or clears the validation worker, so a running validation can leak and overwrite the 'Cancelled' state.
*PLAUSIBLE · concurrency*

**Failure:** A validation worker started by a prior completed run is still running (validation can be long for large meshes) when the user triggers cancelGeneration. cancelGeneration only posts 'cancel' to and terminates workerRef.current (the main worker); validationWorkerRef.current is never touched. The orphaned validation worker keeps consuming CPU and, on completion, calls current.setValidation(...) and current.addLog('Validation complete'), overwriting the 'Cancelled' progress/log the user just requested and leaving a leaked worker.

**Evidence:** `const cancelGeneration = useCallback(() => { if (workerRef.current) { ... workerRef.current = null; } ... }, []);`

### `src/store/useStore.ts:606` — Persisted snapshots write a `version` field but hydrateFromSnapshot never reads it, so there is no version-mismatch handling for restored IndexedDB/localStorage state.
*PLAUSIBLE · correctness*

**Failure:** buildPersistedAppState stamps version:1 but hydrateFromSnapshot (useStore.ts:626) ignores it and blindly spreads stored fields. Because DB_VERSION stays 1, a future schema change (e.g. a renamed/removed param or changed MarchingCubesResult shape) will not trigger an IndexedDB upgrade or any rejection — the app rehydrates a structurally incompatible snapshot from a returning user's browser, leading to stale/corrupt params or a deref crash with no migration or reset path.

**Evidence:** `params: snapshot.params ? { ...DEFAULT_PARAMS, ...snapshot.params } : { ...DEFAULT_PARAMS },`

### `src/utils/export.ts:13` — The download anchor is never inserted into the DOM and its object URL is revoked synchronously in the same tick as click(), which can abort large STL/JSON downloads.
*PLAUSIBLE · memory*

**Failure:** downloadSTL produces a multi-MB Blob for a dense lattice, sets a.href = url, calls a.click(), then immediately URL.revokeObjectURL(url). In browsers that start the blob fetch asynchronously after click() (older Firefox/Safari, and Chrome under load), revoking the URL in the same synchronous frame invalidates it before the download stream is opened, yielding a failed/empty .stl file. The same pattern is repeated in downloadValidationReport (line 42-43) and downloadProjectJSON (line 69-70). The fix is to defer revocation (e.g. setTimeout) and/or append the anchor to document.body before clicking.

**Evidence:** `  a.click();   URL.revokeObjectURL(url);`

### `src/workers/lattice-worker.ts:945` — If a tile worker reports a per-tile error, the pool rejects but in-flight workers that have not yet failed are only cleaned up by .finally; meanwhile the cancelled flag is not set, so the fallback re-runs full cpu-single generation even though the user may have already navigated away, and partial results array entries are silently abandoned.
*PLAUSIBLE · concurrency*

**Failure:** One tile out of many throws (e.g. an extreme params combination produces a degenerate SDF in marchingCubesRectangular); worker.onmessage sees response.type==='error' and rejects. runTiledGeneration's catch at line 1379 swallows it and falls back to cpu-single, re-sampling the entire volume single-threaded. The other tile workers' completed results (already stored in results[]) are discarded, doubling the work and the latency for a transient single-tile failure.

**Evidence:** `if (response.type === 'error') {           reject(new Error(response.message));           return;         }`

## LOW (24)

### `src/backend/webgpu/webgpu-backend.ts:142` — GPUBuffers are created before the try block, so if a later createBuffer throws the earlier buffers are never destroyed (their destroy() is only in the try's finally).
*CONFIRMED · memory*

**Failure:** In runWebGpuSmokeTest, storageBuffer is created at 142 and readbackBuffer at 146, both outside the try at 151. If readbackBuffer creation throws (e.g. allocation failure), storageBuffer leaks because the finally at 202 is attached to the try it never entered. The same pattern exists in sampleFieldWebGPU (paramsBuffer/fieldBuffer/readbackBuffer at 375-390 before the try at 392); a near-limit fieldBytes allocation failing for the readback buffer leaks paramsBuffer and fieldBuffer.

**Evidence:** `  } finally {     storageBuffer.destroy();     readbackBuffer.destroy();   }`

### `src/components/Viewer3D.tsx:444` — CrossSectionView allocates a fresh THREE.Plane and reassigns material.clippingPlanes every single frame via useFrame even when the clip state is unchanged, creating per-frame garbage.
*CONFIRMED · efficiency*

**Failure:** While the cross-section view is open and the user is not interacting, useFrame still runs at ~60fps, each time calling clipStateTo3 (which news up a THREE.Vector3 and THREE.Plane) and reassigning mat.clippingPlanes. This produces continuous allocation/GC churn even though the memoized `plane` already drives the material; the per-frame work is redundant since clip/bounds only change on state updates.

**Evidence:** `useFrame(() => { const p = clipStateTo3(clip, bounds); if (meshRef.current) { const mat = meshRef.current.material as THREE.MeshPhongMaterial; mat.clippingPlanes = [p]; } });`

### `src/components/Viewer3D.tsx:1278` — DemoGridView spawns up to 12 lattice workers, and hexagon/triangle tiles each fan out additional surface-sample sub-workers, with no concurrency cap.
*CONFIRMED · efficiency*

**Failure:** Entering demo mode with a source mesh/shape calls generateTiles(allTypes) which immediately constructs 12 lattice-worker instances (one per lattice type). The 'hexagon' and 'triangle' tiles use variant 'implicit_conformal', which inside each lattice worker triggers generatePoissonSamplesParallel and spawns up to 4 more workers each. On lower-core machines this oversubscribes the CPU and can stall the demo grid; nothing throttles the simultaneous worker count.

**Evidence:** `const worker = new Worker(new URL('../workers/lattice-worker.ts', import.meta.url), { type: 'module' });`

### `src/components/Viewer3D.tsx:1322` — DemoGridView posts the full source mesh to each of the 12 tile workers without a transfer list, structured-cloning the entire positions/normals arrays 12 times.
*CONFIRMED · efficiency*

**Failure:** With a large imported STL (e.g. several million triangles), entering demo mode spawns 12 workers and worker.postMessage(msg) is called with no Transferable list, so the browser deep-copies sourceMesh.positions and sourceMesh.normals for every worker. The main lattice path (useLatticeGeneration.ts) deliberately builds a transfer list and a shared/transfer buffer kind; the demo path ignores all of that, causing 12x redundant large-array copies and a memory/time spike when opening the demo grid.

**Evidence:** `worker.postMessage(msg);`

### `src/components/Viewer3D.tsx:805` — ViewCubeFace's useFrame allocates several Vector3 clones per frame via shouldShowViewCubeFaceLabel, multiplied across all six faces.
*CONFIRMED · efficiency*

**Failure:** Each of the 6 ViewCubeFace components runs a useFrame that calls shouldShowViewCubeFaceLabel(faceNormalWorld, toCameraWorld), which internally does faceNormalWorld.clone().normalize() and toCameraWorld.clone().normalize() (line 992) — two fresh Vector3 allocations per face per frame, i.e. 12 allocations/frame just for label visibility, even though faceNormalWorld and toCameraWorld are already normalized at the call site. Persistent micro-garbage during every frame the gizmo is visible.

**Evidence:** `return faceNormalWorld.clone().normalize().dot(toCameraWorld.clone().normalize()) > threshold;`

### `src/geometry/lattice.ts:631` — Density gradient multiplies the lattice SDF by (1 - gradientStrength*exp(...)); if gradientStrength exceeds 1 the factor goes negative and flips the lattice inside/outside sign.
*CONFIRMED · correctness*

**Failure:** gradientStrength is documented as 0..1 but is not clamped in lattice.ts. With gradientStrength>1 near the surface (exp term ~1), the multiplier 1-gradientStrength*exp becomes negative, inverting the sign of the lattice term so material and void swap inside the gradient band, producing inverted/garbage geometry. Only reachable if an out-of-range value is supplied, hence low.

**Evidence:** `adjustedLat *= 1.0 - gradientStrength * Math.exp(-gd / (cellSize * 3));`

### `src/geometry/lattice.ts:145` — strutDiameter/wallThickness are subtracted as radius/thickness with no lower bound, so negative or zero values silently invert or null out the surface instead of being rejected.
*CONFIRMED · edge-case*

**Failure:** A negative strutDiameter (reachable: number inputs don't enforce `min` on typed values and updateParams does not clamp) makes r<0, so `minDist - r` inflates struts to fill the whole cell; a negative wallThickness makes c<0 so `Math.abs(val) - c` is always positive (no surface) — both yield wrong geometry (solid blob or empty) rather than a guarded error.

**Evidence:** `return minDist - r;`

### `src/geometry/marching-cubes.ts:361` — Degenerate triangles leave the per-facet normal as (0,0,0) instead of a valid unit vector.
*CONFIRMED · correctness*

**Failure:** When interpolation clamps t to 0 or 1 on two edges so two of a triangle's vertices coincide (zero-area facet, common where the iso-surface grazes a grid corner), len <= 1e-12 and the normal stays the zero-initialized (0,0,0). That zero normal is then written directly into the binary STL facet record (stl-parser.ts:97-99), yielding a degenerate facet with a null normal that some slicers flag as a mesh error.

**Evidence:** `if (len > 1e-12) {`

### `src/geometry/mesh-analysis.ts:76` — repairMesh claims to 'fix non-manifold edges by welding' but only recomputes per-face normals; no welding/topology repair occurs, and degenerate faces silently get a [0,0,0] normal.
*CONFIRMED · correctness*

**Failure:** A non-manifold mesh is imported; LeftPanel calls repairMesh and logs 'Basic repair applied' and sets repaired=true, but the topology is unchanged, so the mesh is still non-manifold/non-watertight even though the UI/state now claims it was repaired. Degenerate (zero-area) triangles keep a zero normal, which corrupts lighting and any normal-based inside/outside test.

**Evidence:** `/** Basic mesh repair: recalculate normals, attempt to fix non-manifold edges by welding */`

### `src/geometry/validation.ts:262` — Measured thickness is biased high by up to one step (0.1*minRequired) because the break happens after overshooting the far surface, weakening the 0.9 pass threshold.
*CONFIRMED · correctness*

**Failure:** For a strut sampled at its center with true thickness exactly minRequired, the march records thickness only once val>0 is observed, i.e. up to one stepSize (0.1*minRequired) past the real exit point. minMeasured is thus inflated by ~10%; together with the lenient passed = minMeasured >= minRequired*0.9 threshold, struts up to ~20% under the required minimum can still report as passing.

**Evidence:** `if (minMeasured === Infinity) minMeasured = minRequired; // fallback   return { passed: minMeasured >= minRequired * 0.9, minMeasured };`

### `src/geometry/validation.ts:15` — edgeKey = lo*2^32 + hi loses low-bit precision once the smaller vertex id exceeds 2^21, causing edge-key collisions that corrupt manifold and connectivity counts on very large meshes.
*CONFIRMED · correctness*

**Failure:** A high-resolution mesh whose merged unique-vertex count exceeds ~2,097,152 (2^21). For lo > 2^21, lo*2^32 exceeds 2^53 and the double can no longer represent the additive hi term exactly, so distinct edges (lo,hi) and (lo,hi+1) can hash to the same number. addEdge then bins unrelated edges together, inflating triangle-per-edge counts and producing false non-manifold/boundary classifications. Only triggers on meshes well beyond current ~48^3 grids, hence low.

**Evidence:** `return lo * 0x100000000 + hi;`

### `src/geometry/vec3.ts:35` — normalize() silently returns [0,0,0] for a large finite vector whose squared-length overflows to Infinity, producing a non-unit (zero) normal instead of a valid direction.
*CONFIRMED · edge-case*

**Failure:** Call normalize([1e200, 1e200, 1e200]): length() computes Math.sqrt(1e400) = Infinity (each square is 1e400 = Infinity), the guard `Infinity < 1e-12` is false, so it returns [1e200/Infinity, 1e200/Infinity, 1e200/Infinity] = [0,0,0] -- a degenerate normal rather than the correct ~[0.577,0.577,0.577]. Any downstream consumer (e.g. estimateNormal in lattice-worker.ts line 397, projectToSurfaceSdf) would then operate on a zeroed direction. This only triggers for component magnitudes near 1e154+, so it is an extreme edge case, but the silent collapse to [0,0,0] masks it rather than guarding it.

**Evidence:** `if (len < 1e-12) return [0, 0, 0];`

### `src/hooks/useLatticeGeneration.ts:217` — cancelGeneration nulls workerRef before the 50ms terminate fires, so a 'result' that arrives within that window is dropped but the worker had already transferred its result buffers, and generating state may be left inconsistent.
*CONFIRMED · concurrency*

**Failure:** User clicks cancel just as the worker posts its final 'result'. cancelGeneration posts 'cancel', sets workerRef.current=null, and schedules terminate in 50ms. The worker's onmessage was still attached and may run setResultMesh/setGenerating(false) for a result the user explicitly cancelled, racing with the cancel path that already set setProgress(0,'Cancelled') — the UI can flip between 'Cancelled' and a completed mesh depending on timing.

**Evidence:** `window.setTimeout(() => worker.terminate(), 50); workerRef.current = null;`

### `src/store/useStore.ts:534` — addLog keeps the last 200 entries then appends one, so the in-memory buffer settles at 201, and the hardcoded 200 diverges from the MAX_PERSISTED_LOGS=250 constant so the documented 250-entry history is never reachable.
*CONFIRMED · convention*

**Failure:** After more than 200 log messages, every addLog allocates a fresh 201-element array (slice(-200) + 1) on each call; the tighter in-memory cap silently overrides the intended MAX_PERSISTED_LOGS=250 persistence budget, so the persisted log history is always truncated to ~200 regardless of the constant.

**Evidence:** `logs: [...s.logs.slice(-200), { time: Date.now(), message, level }],`

### `src/store/useStore.ts:534` — addLog hardcodes slice(-200) instead of the MAX_PERSISTED_LOGS (250) constant, silently capping the in-memory log ring at a different size than the documented limit.
*CONFIRMED · correctness*

**Failure:** MAX_PERSISTED_LOGS = 250 is defined and used in buildPersistedAppState's slice(-250), implying logs should retain up to 250 entries. addLog instead truncates to the last 200 on every append, so the in-memory log buffer can never exceed 201 entries and the persisted slice(-250) never sees more than 201 — the two limits silently disagree and 50 entries of intended history are lost.

**Evidence:** `logs: [...s.logs.slice(-200), { time: Date.now(), message, level }],`

### `src/workers/lattice-worker.ts:966` — Tile worker onerror handler discards the underlying error and rejects with a generic 'Tile worker failed' message, hiding the real failure (e.g. module load error, OOM, NaN in SDF) from the fallback log and the user.
*CONFIRMED · correctness*

**Failure:** A tile worker hits an uncaught exception (e.g. lattice-tile-worker module fails to load, or marchingCubesRectangular throws on a huge tile), onerror fires; instead of surfacing the ErrorEvent's message/filename/lineno, the pool rejects with a constant string, so the cpu-single fallback log says 'cpu-tiled unavailable (Tile worker failed)' with no diagnostic detail, making the real defect undebuggable.

**Evidence:** `worker.onerror = () => reject(new Error('Tile worker failed'));`

### `src/backend/generation-backend.ts:42` — Threaded-WASM capability is reimplemented here independently from getBrowserFeatureFlags.threadedWasmReady, so the two detection paths can silently drift.
*PLAUSIBLE · convention*

**Failure:** detectGenerationBackendCapabilities computes hasThreadedWasm = (WebAssembly object && crossOriginIsolated && SharedArrayBuffer function), duplicating the identical formula in src/utils/browser-features.ts (threadedWasmReady). If one site is later updated (e.g. to also require WebAssembly.Memory shared support or a feature-detect probe) and the other is not, selectBestBackend and loadWasmBackend will disagree about whether threaded WASM is available, producing a backend selection that the loader then refuses — inconsistent backend reporting between the worker's selection log and the actual loadable backend.

**Evidence:** `hasThreadedWasm: typeof scope.WebAssembly === 'object' &&       scope.crossOriginIsolated === true &&       typeof scope.SharedArrayBuffer === 'function',`

### `src/backend/wasm/wasm-backend.ts:87` — Both modes compile from the single options.artifactUrl, so a successful 'threaded' load reports mode:'threaded' for a module that may actually be the single-threaded build.
*PLAUSIBLE · correctness*

**Failure:** Caller passes a single-threaded .wasm artifact as artifactUrl but requests mode:'threaded' on an isolated page; support.threaded passes, the single-threaded artifact is compiled, and the result is returned as { available: true, mode: 'threaded' }. A downstream instantiator that branches on result.mode to provide a SharedArrayBuffer memory / thread imports will then mis-instantiate the module (or import-mismatch crash), because the WasmBackendLoaderOptions exposes no separate threaded-artifact URL and the loader performs no validation that the compiled module's imports match the reported mode.

**Evidence:** `return { available: true, mode, module, support };`

### `src/components/Viewer3D.tsx:1131` — The 'change' listener effect in ViewerCameraSession lists viewportResetSignal in its deps, tearing down and re-adding the OrbitControls listener (and dropping any pending debounced save) on every viewport reset.
*PLAUSIBLE · correctness*

**Failure:** Each time the user triggers resetViewport (incrementing viewportResetSignal), this effect re-runs: it removes the 'change' listener, and its cleanup clears saveTimerRef, discarding an in-flight 200ms debounced camera save. A camera move made just before a viewport reset can therefore be silently dropped instead of persisted. viewportResetSignal is not otherwise used inside the effect body, so it is an unnecessary dependency that only causes listener churn.

**Evidence:** `}, [camera, controls, setViewerCameraState, viewportResetSignal]);`

### `src/geometry/marching-cubes.ts:357` — Local normal-accumulator variables nx/ny shadow the outer cell-count nx/ny, which is error-prone.
*PLAUSIBLE · convention*

**Failure:** Inside the normal loop, `const nx`, `const ny` (and `nz2`) shadow the `nx, ny, nz` cell counts declared at line 287. It is currently harmless because the loop does not reference the cell counts, but any future edit that needs the grid dimensions inside this loop would silently pick up the cross-product component instead, producing wrong indexing.

**Evidence:** `const nx = e1y * e2z - e1z * e2y;`

### `src/geometry/validation.ts:77` — Vertex merge quantizes at 1e3 (0.001 unit) and can falsely merge two distinct nearby vertices from different struts, corrupting the manifold/watertight and fragment-count topology results.
*PLAUSIBLE · correctness*

**Failure:** Two independent lattice surfaces pass within 0.001 mm of each other (sub-quantization). getQuantizedVertexId collapses their vertices to one shared id, so addEdge produces an edge shared by >2 triangles (reported as a spurious non-manifold edge) or stitches two separate fragments into one component, making checkDisconnected under-count fragments. Watertightness/manifold and fragment results become wrong for closely-spaced geometry.

**Evidence:** `Math.round(positions[base] * 1e3),`

### `src/utils/export.ts:13` — URL.revokeObjectURL is called synchronously on the line immediately after a.click(), which can race the browser's asynchronous download fetch in some engines and cancel the download.
*PLAUSIBLE · correctness*

**Failure:** On Export STL/Project JSON for a large mesh, certain browsers begin reading the blob URL asynchronously after click(); revoking it on the next statement can intermittently produce an empty or failed download. The robust pattern is to revoke on a setTimeout/next tick rather than the immediately following line.

**Evidence:** `a.click();   URL.revokeObjectURL(url);`

### `src/utils/notifications.ts:39` — getReadyNotificationRegistration races navigator.serviceWorker.ready (which resolves for whatever SW controls the page) against a 2s timeout, and on first load may return a registration whose .active is null.
*PLAUSIBLE · correctness*

**Failure:** On the very first visit, register() returns a registration whose worker is still installing/waiting and is not yet controlling the page, so navigator.serviceWorker.ready does not resolve within 2000ms. The race resolves to null and the code returns the not-yet-active `registration`; registration.showNotification then throws (no active worker) and silently falls through to new Notification(...). Functionally it degrades, but the 'ready' value is also not guaranteed to correspond to this specific notification SW if another SW ever controls scope '/'.

**Evidence:** `return ready ?? registration;`

### `src/workers/surface-sample-worker.ts:216` — Cumulative triangle areas are accumulated in a Float32Array, so for high-poly meshes with large total surface area the prefix sums lose precision and can plateau (equal consecutive values), biasing or starving selection of some triangles.
*PLAUSIBLE · efficiency*

**Failure:** With tens of thousands of triangles and a large model, adding small per-triangle areas into a Float32 running total loses mantissa precision once totalArea grows; many late triangles get an areas[i] identical to areas[i-1], so pickTriangle's `r <= areas[mid]` lands on the earlier index and those triangles are effectively never sampled, mildly skewing coverage. Using Float64 (number[] or Float64Array) for the cumulative array avoids this.

**Evidence:** `const areas = new Float32Array(msg.triCount);`
