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
