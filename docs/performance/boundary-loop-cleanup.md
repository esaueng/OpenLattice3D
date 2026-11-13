# Boundary-loop cleanup performance

`closeBoundaryLoops` (`src/geometry/mesh-repair.ts`) runs after every
whole-volume and tiled extraction. Before November 2026 it was 85–92% of
end-to-end generation time in the committed backend benchmarks (for example
5190 of 5614 ms for `cpu-single` on `sphere-gyroid-bench`), which is why
`parity-gates.md` noted that a GPU extractor could not win end-to-end.

## Why it was slow

The repair itself is tiny: on the resolution-160 benchmark parts it closes
46–49 loops, every one a four-vertex pinhole filled with two triangles. The
cost was entirely in the whole-mesh passes that find them:

- vertex welding built a string key (`"x,y,z"` of float bits) per corner and
  looked it up in a `Map` — about 3.6 million string allocations and hashes
  for a 1.19-million-triangle part;
- edge counting used a `Map` keyed by `lo * 2^31 + hi` (heap-number keys
  above the small-integer range) and allocated a nested array literal per
  triangle, twice;
- a third `Map` held per-vertex positions as three-element arrays.

The algorithm was linear, but at 2.2–3.0 µs per triangle, rising with size as
the maps outgrew cache and the collector worked harder (measured on
`sphere-gyroid` at resolutions 48–192 on the Linux machine below).

## What changed

Same algorithm, flat typed arrays:

- **Welding:** open-addressing table over interleaved `[x, y, z, id]` Int32
  words with a MurmurHash3 mix (float bits from grid-derived vertices differ
  mostly in low mantissa bits and cluster under weak mixing). Ids are still
  assigned in first-occurrence order; signed zero still welds. Measured 1.14–
  1.20 probes per corner on marching-cubes output.
- **Edge counting:** no hashing. Non-degenerate edges are counting-sorted into
  buckets under their lower vertex id, then uses are counted per bucket against
  a per-vertex tag. Exactly two visits per edge reference.
- **Loop walking:** `next` and `visited` are Int32/Uint8 arrays indexed by
  vertex id; loop starts keep the original `Map` insertion order, and a vertex
  that starts several unmatched edges still keeps the last one.
- **Fill emission:** coordinates are read from the first corner that produced
  each vertex, exactly as the old position map stored them.

Approximate transient memory for a 1.19-million-triangle part (computed from
array sizes, not measured): about 62 MB while welding and 66 MB while counting
edges, released when the call returns.

`closeBoundaryLoops(result, counters?)` accepts an optional
`RepairWorkCounters` object that accumulates corners, weld probes, edge visits
and loop steps; the complexity tests assert on those rather than on wall-clock
time.

## Output identity

The output is bit-for-bit identical: same positions, normals, triangle count,
report, and the same object returned when nothing is filled.

- `src/geometry/mesh-repair.test.ts` holds digests captured from the original
  implementation before the rewrite: sealed single-volume `sphere-gyroid` and
  `cube-gyroid`, merged `sphere-gyroid` tiles, and synthetic meshes covering
  signed zeros, a bowtie (branching boundary), degenerate and non-manifold
  edges, a perforated grid with 103 unresolved loops, a triangle soup that
  grows the weld table, an integer-coordinate grid with one 160-vertex loop,
  and a closed mesh.
- A scratch comparison against the original code was byte-identical on both
  resolution-160 benchmark fixtures (single and tiled), `cylinder-iwp` at 96,
  and a shelled gyroid torus tiled at 192.

## Measurements

Linux x64, Intel Xeon @ 2.10GHz, 4 cores, Node v22.23.4, shared with other
jobs (load average up to 18 during runs, so absolute numbers are noisy; ratios
come from interleaved runs).

`npm run bench:backends`, median of 5 warm runs (before: the original code on
the same machine minutes earlier; after:
`results/backend-benchmark-linux-x64.json`):

| Fixture | Backend | Total before | Total after | Cleanup before | Cleanup after | Cleanup share after |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| sphere-gyroid-bench | cpu-single | 5194 ms | 1240 ms | 4460 ms | 506 ms | 41% |
| sphere-gyroid-bench | cpu-tiled | 5479 ms | 1353 ms | 4874 ms | 422 ms | 31% |
| sphere-schwarzP-bench | cpu-single | 3862 ms | 688 ms | 3284 ms | 208 ms | 30% |
| sphere-schwarzP-bench | cpu-tiled | 6810 ms | 746 ms | 5801 ms | 206 ms | 28% |

Cleanup alone, old and new interleaved on the same input, median of 5: about
12–15x faster at every resolution from 48 to 192 on `sphere-gyroid`, and
roughly flat per triangle (275–495 ns/triangle under load, against
3.5–7.4 µs/triangle for the old code in the same run). On a quieter run the
resolution-160 parts took 214–285 ms against 3.0–4.4 s.

## Where the open boundaries come from

A scratch experiment classified every closed loop by its distance from the
sampling bounds, and re-extracted each fixture with and without
`sealFieldBoundary` and with the bounds padded by two extra cells:

| Fixture | Loops | Nearest loop to bounds | Unsealed | +2 cell pad |
| --- | ---: | ---: | ---: | ---: |
| sphere-gyroid (64) | 23 | 6 cells | 23 | 23 |
| cube-gyroid (64) | 22 | 9 cells | 22 | 22 |
| sphere-schwarzP (64) | 0 | — | 0 | 0 |
| cylinder-iwp-tile-crossing (96) | 0 | — | 0 | 0 |
| sphere-gyroid-bench (160) | 49 | 13 cells | 49 | 49 |
| sphere-schwarzP-bench (160) | 46 | 17 cells | 46 | 46 |

Every loop is an interior four-vertex pinhole from an ambiguous marching-cubes
face, never a cut at the sampling bounds, and tiled extraction produced the
same loop counts as single-volume extraction (seams merge cleanly).

**Recommendation for `src/workers/lattice-worker.ts`: no change.** It already
calls `sealFieldBoundary` before whole-volume extraction, and padding the
field changes neither the loop count nor the cleanup cost, which is set by
the size of the mesh rather than the number of holes. Further cleanup savings
would have to come from marching cubes itself: emitting shared-edge vertex ids
would make welding unnecessary, and MC33 disambiguation would remove the
pinholes at source.

## Grid vertex ids from marching cubes (November 2026)

After the typed-array rewrite, welding was still the largest part of cleanup:
it hashes every vertex reference (three per triangle) to rediscover which
references marching cubes emitted from the same grid edge. Marching cubes
knows that already.

### API

- `marchingCubesFromField(field, bounds, cells, iso, onProgress, { vertexIds: true })`
  and `marchingCubesFromFieldWindow(field, gridBounds, gridCells, origin, cells, iso, { vertexIds: true })`
  return `vertexIds: { ids: Uint32Array, gridCells }` with one id per vertex
  reference. Without the option nothing changes (no allocation, same loop).
- `closeBoundaryLoops(result, counters?, { vertexIds })` welds through the ids
  instead of hashing positions. Output is byte-identical to the hash path.

### Id scheme and why it matches the float-bit weld

With `sample = x + y·(gx+1) + z·(gx+1)(gy+1)` the whole-grid sample index, a
vertex strictly inside the edge that starts at `sample` along `axis` gets
`sample·4 + axis`; a vertex whose Float32 position is exactly a grid sample's
position gets `sample·4 + 3`, whichever edge emitted it. The maximum grid
(265³ samples, `MAX_GENERATION_FIELD_SAMPLES`) needs ids below 4·265³ ≈ 74.4 M,
so Uint32 suffices; ids come from whole-grid coordinates, so every window
agrees with the whole grid.

The hash path welds by exact Float32 bits (signed zero folded). The ids induce
the same classes because:

- An x-edge vertex is `ax + t·(bx − ax)` with y and z computed as `ay + t·0`,
  so its y and z are exactly the edge's grid coordinates and only x varies.
  Each cube corner coordinate is the same expression (`min + k·d`) in every
  cube and window, and every edge is interpolated in the positive axis
  direction, so one id always yields the same position.
- The canonicalization compares the emitted Float32 coordinate with the
  Float32 sample planes: equal to the start or end plane → corner id (this is
  the degenerate case: exact-zero samples give t = 0 or 1, and t that rounds
  to a plane, so up to six edges emit the same corner position); strictly
  between → edge id. A position then determines its id uniquely, provided the
  Float32 sample planes are strictly increasing on each axis.
- Anything outside those cases — NaN (an infinite sample), rounding past a
  plane, colliding Float32 planes (e.g. bounds near 1e8 with millimetre
  cells), or ids that would not fit Uint32 — makes marching cubes return no
  ids, and callers use the hash path.

`closeBoundaryLoops` assigns dense ids in first-occurrence order exactly as
the hash weld does, so edge counting, loop starts and fill order are
untouched. Triangles arrive in z-slab order and a cube only touches its own two
sample slices, so a two-slice ring of slots (≈1.7 MB at resolution 160, versus
a ≈32 MB hash table) replaces hashing: one direct lookup per reference. It
also checks that every reference to a vertex has the same position as its
first one; if ids revisit an evicted slice or that check fails (stale or
foreign ids), it falls back to the hash weld, so the output stays identical.

### Verification

- `src/geometry/mesh-repair-vertex-ids.test.ts`: digests captured from the
  hash path before the change for eight fields — sealed sphere/cube gyroids at
  64³, quantized gyroids at 64³ (many exact-zero samples), an offset
  non-cubic grid, planes through grid corners (every vertex on a sample), and
  two random {−1, 0, 1} fields. The id path, whole-grid and windowed (20-cell
  windows interleaved by `rowTriangleStarts`), reproduces every digest and
  report; a bijection check confirms ids and Float32 positions partition the
  vertex references identically, and corner ids appear thousands of times
  in the exact-zero fields. Fallback and complexity (one lookup per corner,
  linear growth) are covered too.
- Scratch differential sweep: 4000 random grids (1–18 cells per axis, offsets
  up to ±1000 mm, ternary/quantized/±1e-30/±5e-7 samples): every case
  byte-identical, ids bijective with positions, no fallback.
- Both resolution-160 benchmark fixtures and all parity fixtures:
  byte-identical to the pre-change code.

### Measurements

Scratch benchmark (`marchingCubesFromField` + `closeBoundaryLoops`, both ways
interleaved on the same sealed field, median of 7), same Linux machine as
above, load average 4–8 from other jobs:

| Fixture | Triangles | MC | MC + ids | Cleanup (hash) | Cleanup (ids) | MC + cleanup before | after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| sphere-gyroid-bench (160) | 1.19 M | 209–238 ms | 224–240 ms | 264–285 ms | 136–160 ms | 473–524 ms | 360–400 ms |
| sphere-schwarzP-bench (160) | 0.93 M | 139–154 ms | 169–186 ms | 193–217 ms | 100–104 ms | 332–372 ms | 269–290 ms |

Cleanup is 1.8–2.1× faster; the weld phase alone went from 145–192 ms to
34–60 ms, leaving edge counting (35–68 ms) as the largest cleanup phase.
Emitting ids costs 15–35 ms in marching cubes (canonicalization plus a Uint32
per reference: 14 MB at 1.19 M triangles), so extraction plus cleanup is
17–24% faster end to end. Extraction without ids is unchanged (measured
against the pre-change code in a plain-only run, within noise).

`npm run bench:backends` is unchanged by this commit: `cpu-single` mirrors
`lattice-worker.ts`, which does not request ids yet.

### Wiring (not done here; those files belong to other work)

- **Whole-volume path** (`lattice-worker.ts`): pass
  `{ vertexIds: true }` as the sixth argument of `marchingCubesFromField`,
  then `closeBoundaryLoops(rawResult, undefined, { vertexIds: rawResult.vertexIds })`.
  Do not keep `vertexIds` on anything posted to the main thread.
- **Imported-mesh windows** (`mesh-tiles.ts` `computeMeshTile`,
  `lattice-tile-worker.ts`): pass `{ vertexIds: true }` as the seventh
  argument of `marchingCubesFromFieldWindow`, and return
  `result.vertexIds?.ids` with the tile response (transfer its buffer).
  `mergeMeshTilesInGridOrder` copies `ids.subarray(start * 3, end * 3)` to
  `written * 3` alongside positions; if any tile has no ids, merge none.
  Then `closeBoundaryLoops(merged, undefined, { vertexIds: { ids, gridCells: [resolution, resolution, resolution] } })`.
- **Procedural tiles** (`tiled-generation.ts`): no change. Each tile samples
  its own bounds with `marchingCubesRectangular` and they are merged by tile
  id, not grid row, so they keep the hash weld.

## MC33 / ambiguity resolution: assessment

Measured on the sealed fixtures (scratch census; a face counts as ambiguous
when its diagonal corners agree and adjacent ones differ):

| Fixture | Resolution | Triangles | Ambiguous faces | Loops closed |
| --- | ---: | ---: | ---: | ---: |
| sphere-gyroid | 64 | 199,562 | 9,222 | 23 |
| sphere-gyroid | 128 | 761,788 | 1,134 | 46 |
| cube-gyroid | 64 | 154,828 | 216 | 22 |
| cube-gyroid | 128 | 653,232 | 0 | 0 |
| sphere-schwarzP | 64 | 156,352 | 5,376 | 0 |
| sphere-schwarzP | 128 | 591,208 | 552 | 12 |
| cylinder-iwp-tile-crossing | 96 / 128 | 290,928 / 503,904 | 80 / 240 | 0 / 0 |
| sphere-gyroid-bench | 160 | 1,186,510 | 1,380 | 49 |
| sphere-schwarzP-bench | 160 | 932,036 | 1,368 | 46 |

Every closed loop is a four-vertex interior pinhole (two fill triangles), and
no loop is ever left unresolved on these fields. MC33 (or face-consistent
asymptotic-decider tables) would remove them at source, but:

- it changes output topology and triangle counts in every cube touching an
  ambiguous face, invalidating the characterization digests, backend parity
  gates and the WebGPU extractor's table contract;
- it does not remove the need for `closeBoundaryLoops` on meshes that did not
  come from one consistent extraction (procedural tile seams, imported or
  edited meshes), and skipping the pass even for whole-grid output would
  save only the remaining cleanup cost — about 100–160 ms at resolution 160
  with grid ids, roughly a quarter of extraction plus cleanup;
- the loops are already closed correctly at negligible per-hole cost; cleanup
  time is set by mesh size, not hole count.

**Recommendation: do not adopt MC33 now.** Revisit only if a GPU extractor
makes the remaining cleanup dominant again; in that case adopt it as a
deliberate, versioned output change with new digests, and keep
`closeBoundaryLoops` for tiled and imported paths.
