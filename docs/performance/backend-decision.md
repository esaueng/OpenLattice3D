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
