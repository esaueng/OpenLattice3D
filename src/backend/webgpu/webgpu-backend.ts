import type { Vec3 } from '../../geometry/vec3';
import { tpmsIsoValue } from '../../geometry/lattice';
import type { SheetLatticeType } from '../../geometry/lattice';
import type { LatticeParams, SampleShape } from '../../types/project';

type GpuMapModeFlags = { READ: number };
type GpuBufferUsageFlags = {
  MAP_READ: number;
  COPY_SRC: number;
  COPY_DST: number;
  STORAGE: number;
};

type MinimalGpuBuffer = {
  getMappedRange(): ArrayBuffer;
  mapAsync(mode: number): Promise<void>;
  unmap(): void;
  destroy(): void;
};

type MinimalGpuQueue = {
  submit(commandBuffers: Iterable<unknown>): void;
};

type MinimalGpuDevice = {
  queue: MinimalGpuQueue;
  createBindGroup(descriptor: unknown): unknown;
  createBindGroupLayout(descriptor: unknown): unknown;
  createBuffer(descriptor: unknown): MinimalGpuBuffer;
  createCommandEncoder(): {
    beginComputePass(): {
      setPipeline(pipeline: unknown): void;
      setBindGroup(index: number, bindGroup: unknown): void;
      dispatchWorkgroups(x: number): void;
      end(): void;
    };
    copyBufferToBuffer(
      source: MinimalGpuBuffer,
      sourceOffset: number,
      destination: MinimalGpuBuffer,
      destinationOffset: number,
      size: number
    ): void;
    finish(): unknown;
  };
  createComputePipeline(descriptor: unknown): unknown;
  createPipelineLayout(descriptor: unknown): unknown;
  createShaderModule(descriptor: unknown): unknown;
};

type MinimalGpuAdapter = {
  requestDevice(): Promise<MinimalGpuDevice>;
};

type MinimalGpu = {
  requestAdapter(): Promise<MinimalGpuAdapter | null>;
};

type NavigatorWithGpu = Navigator & { gpu?: MinimalGpu };

const GPU_MAP_MODE: GpuMapModeFlags = { READ: 1 };
const GPU_BUFFER_USAGE: GpuBufferUsageFlags = {
  MAP_READ: 1,
  COPY_SRC: 4,
  COPY_DST: 8,
  STORAGE: 128,
};

export interface WebGpuSupport {
  supported: boolean;
  reason?: string;
}

export interface WebGpuContext {
  adapter: MinimalGpuAdapter;
  device: MinimalGpuDevice;
}

export interface WebGpuSmokeTestResult {
  ok: boolean;
  values?: Uint32Array;
  reason?: string;
}

export interface WebGpuFieldSampleOptions {
  bounds: { min: Vec3; max: Vec3 };
  resolution: number;
  shape: SampleShape;
  sphereRadius: number;
  params: LatticeParams;
}

export interface WebGpuFieldSampleResult {
  field: Float32Array;
  timing: {
    webgpuFieldMs: number;
    readbackMs: number;
    totalMs: number;
  };
}

const MAX_FIELD_BYTES = 256 * 1024 * 1024;
const FIELD_WORKGROUP_SIZE = 64;

const SHAPE_IDS: Record<SampleShape, number> = {
  sphere: 0,
  cube: 1,
  cylinder: 2,
  torus: 3,
  capsule: 4,
};

const LATTICE_IDS: Partial<Record<LatticeParams['latticeType'], number>> = {
  gyroid: 0,
  schwarzP: 1,
};

export function detectWebGpuSupport(scope: typeof globalThis = globalThis): WebGpuSupport {
  const navigatorWithGpu = scope.navigator as NavigatorWithGpu | undefined;
  if (!navigatorWithGpu?.gpu) {
    return { supported: false, reason: 'navigator.gpu is unavailable.' };
  }
  return { supported: true };
}

export async function initializeWebGpu(scope: typeof globalThis = globalThis): Promise<WebGpuContext | null> {
  const navigatorWithGpu = scope.navigator as NavigatorWithGpu | undefined;
  const gpu = navigatorWithGpu?.gpu;
  if (!gpu) return null;

  const adapter = await gpu.requestAdapter();
  if (!adapter) return null;

  const device = await adapter.requestDevice();
  return { adapter, device };
}

export async function runWebGpuSmokeTest(scope: typeof globalThis = globalThis): Promise<WebGpuSmokeTestResult> {
  const context = await initializeWebGpu(scope);
  if (!context) return { ok: false, reason: 'WebGPU adapter or device unavailable.' };

  const { device } = context;
  const outputSize = 4 * Uint32Array.BYTES_PER_ELEMENT;
  const storageBuffer = device.createBuffer({
    size: outputSize,
    usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: outputSize,
    usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
  });

  try {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: 4,
        buffer: { type: 'storage' },
      }],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: {
        module: device.createShaderModule({
          code: `
            @group(0) @binding(0) var<storage, read_write> outData: array<u32>;

            @compute @workgroup_size(4)
            fn main(@builtin(global_invocation_id) id: vec3<u32>) {
              outData[id.x] = id.x + 7u;
            }
          `,
        }),
        entryPoint: 'main',
      },
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: storageBuffer } }],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(storageBuffer, 0, readbackBuffer, 0, outputSize);
    device.queue.submit([encoder.finish()]);

    await readbackBuffer.mapAsync(GPU_MAP_MODE.READ);
    const values = new Uint32Array(readbackBuffer.getMappedRange()).slice();
    readbackBuffer.unmap();

    const ok = values[0] === 7 && values[1] === 8 && values[2] === 9 && values[3] === 10;
    return ok
      ? { ok, values }
      : { ok, values, reason: `Unexpected smoke test output: ${Array.from(values).join(',')}` };
  } catch (err: unknown) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'WebGPU smoke test failed.',
    };
  } finally {
    storageBuffer.destroy();
    readbackBuffer.destroy();
  }
}

function shapeDimensions(shape: SampleShape, sphereRadius: number): [number, number, number] {
  switch (shape) {
    case 'sphere':
      return [sphereRadius || 25, 0, 0];
    case 'cube':
      return [15, 0, 0];
    case 'cylinder':
      return [15, 20, 0];
    case 'torus':
      return [20, 8, 0];
    case 'capsule':
      return [12, 15, 0];
  }
}

function packFieldParams(options: WebGpuFieldSampleOptions): Float32Array {
  const { bounds, resolution, shape, sphereRadius, params } = options;
  const [shapeA, shapeB, shapeC] = shapeDimensions(shape, sphereRadius);
  const latticeId = LATTICE_IDS[params.latticeType];
  if (latticeId === undefined) {
    throw new Error(`WebGPU field sampling does not support lattice type ${params.latticeType}`);
  }

  return new Float32Array([
    bounds.min[0], bounds.min[1], bounds.min[2], bounds.max[0],
    bounds.max[1], bounds.max[2], resolution, SHAPE_IDS[shape],
    latticeId, params.cellSize, params.wallThickness, params.shellThickness,
    params.strutDiameter, params.noShell ? 1 : 0, params.surfaceOnly ? 1 : 0, params.surfaceDepth,
    params.gradientEnabled ? 1 : 0, params.gradientStrength, params.thinSectionFilter,
    params.variant === 'shell_core' ? 0 : 1,
    shapeA, shapeB, shapeC,
    tpmsIsoValue(params.latticeType as SheetLatticeType, params.wallThickness, params.cellSize),
  ]);
}

const FIELD_SAMPLE_SHADER = `
@group(0) @binding(0) var<storage, read> p: array<f32>;
@group(0) @binding(1) var<storage, read_write> field: array<f32>;

fn smooth_min(a: f32, b: f32, k: f32) -> f32 {
  if (k <= 0.0) {
    return min(a, b);
  }
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * h * k * (1.0 / 6.0);
}

fn object_sdf(pos: vec3<f32>) -> f32 {
  let shape = u32(p[7]);
  if (shape == 0u) {
    return length(pos) - p[20];
  }
  if (shape == 1u) {
    let q = abs(pos) - vec3<f32>(p[20]);
    let outside = length(max(q, vec3<f32>(0.0)));
    let inside = min(max(q.x, max(q.y, q.z)), 0.0);
    return outside + inside;
  }
  if (shape == 2u) {
    let d_radial = length(pos.xy) - p[20];
    let d_axial = abs(pos.z) - p[21];
    let outside = length(max(vec2<f32>(d_radial, d_axial), vec2<f32>(0.0)));
    let inside = min(max(d_radial, d_axial), 0.0);
    return outside + inside;
  }
  if (shape == 3u) {
    let qx = length(pos.xy) - p[20];
    return length(vec2<f32>(qx, pos.z)) - p[21];
  }
  let cz = clamp(pos.z, -p[21], p[21]);
  return length(vec3<f32>(pos.x, pos.y, pos.z - cz)) - p[20];
}

fn lattice_sdf(pos: vec3<f32>) -> f32 {
  let k = 6.283185307179586 / p[9];
  // Calibrated on the CPU (see tpmsIsoValue); deriving it here again would let
  // this backend drift away from the others.
  let c = p[23];
  let lattice = u32(p[8]);
  if (lattice == 0u) {
    let sx = sin(k * pos.x);
    let sy = sin(k * pos.y);
    let sz = sin(k * pos.z);
    let cx = cos(k * pos.x);
    let cy = cos(k * pos.y);
    let cz = cos(k * pos.z);
    let v = sx * cy + sy * cz + sz * cx;
    return abs(v) - c;
  }
  let v = cos(k * pos.x) + cos(k * pos.y) + cos(k * pos.z);
  return abs(v) - c;
}

fn combined_sdf(d_obj: f32, lat_in: f32) -> f32 {
  var lat = lat_in;
  let shell_thickness = p[11];
  let strut_diameter = p[12];
  let no_shell = p[13] > 0.5;
  let surface_only = p[14] > 0.5;
  let surface_depth = p[15];
  let gradient_enabled = p[16] > 0.5;
  let gradient_strength = p[17];
  let thin_filter = p[18];
  let shell_core = p[19] < 0.5;
  let blend_k = min(p[10], strut_diameter) * 0.3;

  if (gradient_enabled) {
    let gd = select(max(0.0, -(d_obj + shell_thickness)), max(0.0, -d_obj), no_shell || surface_only);
    lat *= 1.0 - gradient_strength * exp(-gd / (p[9] * 3.0));
  }

  var out_sdf: f32;
  if (surface_only) {
    out_sdf = max(lat, max(d_obj, -(d_obj + surface_depth)));
  } else if (no_shell) {
    out_sdf = max(lat, d_obj);
  } else {
    let shell_sdf = max(d_obj, -(d_obj + shell_thickness));
    if (shell_core) {
      let core_sdf = -(d_obj + shell_thickness);
      out_sdf = smooth_min(shell_sdf, max(-core_sdf, lat), blend_k);
    } else {
      out_sdf = smooth_min(shell_sdf, max(lat, d_obj), blend_k);
    }
  }
  return out_sdf + thin_filter;
}

@compute @workgroup_size(${FIELD_WORKGROUP_SIZE})
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let resolution = u32(p[6]);
  let count = resolution + 1u;
  let total = count * count * count;
  let index = id.x;
  if (index >= total) {
    return;
  }

  let x = index % count;
  let y = (index / count) % count;
  let z = index / (count * count);
  let min_pos = vec3<f32>(p[0], p[1], p[2]);
  let max_pos = vec3<f32>(p[3], p[4], p[5]);
  let t = vec3<f32>(f32(x), f32(y), f32(z)) / f32(resolution);
  let pos = min_pos + (max_pos - min_pos) * t;
  field[index] = combined_sdf(object_sdf(pos), lattice_sdf(pos));
}
`;

export async function sampleFieldWebGPU(options: WebGpuFieldSampleOptions): Promise<WebGpuFieldSampleResult> {
  if (options.resolution < 1) {
    throw new Error('WebGPU field sampling requires resolution >= 1');
  }
  if (LATTICE_IDS[options.params.latticeType] === undefined) {
    throw new Error(`WebGPU field sampling only supports gyroid and schwarzP, got ${options.params.latticeType}`);
  }

  const count = options.resolution + 1;
  const fieldLength = count * count * count;
  const fieldBytes = fieldLength * Float32Array.BYTES_PER_ELEMENT;
  if (fieldBytes > MAX_FIELD_BYTES) {
    throw new Error(`WebGPU field buffer ${Math.round(fieldBytes / 1024 / 1024)}MiB exceeds safety limit`);
  }

  const start = performance.now();
  const context = await initializeWebGpu();
  if (!context) throw new Error('WebGPU adapter or device unavailable');
  const { device } = context;

  const packedParams = packFieldParams(options);
  const paramsBuffer = device.createBuffer({
    size: packedParams.byteLength,
    usage: GPU_BUFFER_USAGE.STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(paramsBuffer.getMappedRange()).set(packedParams);
  paramsBuffer.unmap();

  const fieldBuffer = device.createBuffer({
    size: fieldBytes,
    usage: GPU_BUFFER_USAGE.STORAGE | GPU_BUFFER_USAGE.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: fieldBytes,
    usage: GPU_BUFFER_USAGE.MAP_READ | GPU_BUFFER_USAGE.COPY_DST,
  });

  try {
    const bindGroupLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
        { binding: 1, visibility: 4, buffer: { type: 'storage' } },
      ],
    });
    const pipeline = device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      compute: {
        module: device.createShaderModule({ code: FIELD_SAMPLE_SHADER }),
        entryPoint: 'main',
      },
    });
    const bindGroup = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: paramsBuffer } },
        { binding: 1, resource: { buffer: fieldBuffer } },
      ],
    });

    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(fieldLength / FIELD_WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(fieldBuffer, 0, readbackBuffer, 0, fieldBytes);
    device.queue.submit([encoder.finish()]);

    const submitted = performance.now();
    await readbackBuffer.mapAsync(GPU_MAP_MODE.READ);
    const mapped = readbackBuffer.getMappedRange();
    const field = new Float32Array(mapped).slice();
    readbackBuffer.unmap();
    const end = performance.now();

    return {
      field,
      timing: {
        webgpuFieldMs: submitted - start,
        readbackMs: end - submitted,
        totalMs: end - start,
      },
    };
  } finally {
    paramsBuffer.destroy();
    fieldBuffer.destroy();
    readbackBuffer.destroy();
  }
}
