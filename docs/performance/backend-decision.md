# Generation backend decision

OpenLattice3D ships the two production backends that are exercised by CI and
the browser application:

- `cpu-tiled` for procedural shapes, using bounded Web Worker fan-out and
  sparse tile skipping.
- `cpu-single` for imported meshes and as the universal fallback.

The former WebGPU field sampler supported only Gyroid and Schwarz P, copied the
entire scalar field back to the CPU, and was permanently disabled. The WASM
loader exposed placeholder backend names without a compiled geometry core.
Both runtime scaffolds were removed because neither had a correctness and
end-to-end performance result strong enough to ship.

The proposed full GPU implementation remains documented in
`webgpu-marching-cubes-design.md`. It can return to the runtime only after it:

1. covers every supported TPMS formula with the same millimetre-valued field,
2. matches CPU topology, bounds, and wall thickness within the geometry test
   tolerances,
3. keeps classification and triangle emission on the GPU so field readback is
   not the dominant cost, and
4. demonstrates a repeatable end-to-end speedup on representative parts while
   preserving automatic CPU fallback.

These requirements are executable gates, not aspirations: `src/backend/`
compares any candidate backend against the CPU reference on deterministic
fixtures, tests its fallback behavior, and benchmarks warm runs against a
minimum 1.5x end-to-end speedup. See `parity-gates.md`.

## Post-extraction cleanup

Both CPU backends end with the same boundary-loop cleanup, which closes the
pinholes left by ambiguous marching-cubes faces. It used to dominate every
run: on the resolution-160 benchmark parts it took 3284–5801 ms of
3862–6810 ms end to end (Linux x64, Intel Xeon @ 2.10GHz). The typed-array
rewrite produces bit-identical output in 206–506 ms, bringing the end-to-end
medians to 688–1353 ms on the same machine. Cleanup is now 28–41% of a run
rather than 85–92%, so faster extraction translates into end-to-end gains.
Details and the evidence that padding the sampling field would not help are in
`boundary-loop-cleanup.md`.
