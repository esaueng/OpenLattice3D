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
