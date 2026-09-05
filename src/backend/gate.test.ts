// Fallback and promotion-gate tests for backend selection. Stale-result
// rejection is covered end-to-end in src/hooks/generation-worker-controller
// .test.ts ("ignores stale messages after a replacement generation starts").
import { describe, expect, it } from 'vitest';
import { cpuSingleBackend, createCpuTiledBackend, runBackendWithFallback } from './cpu-backends';
import { PARITY_FIXTURES } from './fixtures';
import {
  evaluateGpuPromotion,
  GPU_PROMOTION_EVIDENCE,
  GPU_PROMOTION_MIN_SPEEDUP,
  resolveGpuEligibility,
  type GpuPromotionEvidence,
} from './gate';
import type { BackendFixture, BackendRunResult, MarchingCubesBackend } from './types';

const tinyFixture: BackendFixture = { ...PARITY_FIXTURES[0], name: 'tiny-sphere', resolution: 16 };

const passingEvidence: GpuPromotionEvidence = {
  parityPassed: true,
  fallbackPassed: true,
  medianSpeedupVsCpuTiled: GPU_PROMOTION_MIN_SPEEDUP,
};

describe('GPU promotion gate', () => {
  it('keeps GPU selection disabled with the committed evidence', () => {
    const decision = evaluateGpuPromotion(GPU_PROMOTION_EVIDENCE);
    expect(decision.enabled).toBe(false);
    expect(decision.reasons.length).toBeGreaterThan(0);
  });

  it('enables only when parity, fallback, and the speedup threshold all pass', () => {
    expect(evaluateGpuPromotion(passingEvidence).enabled).toBe(true);

    const slow = evaluateGpuPromotion({
      ...passingEvidence,
      medianSpeedupVsCpuTiled: GPU_PROMOTION_MIN_SPEEDUP - 0.01,
    });
    expect(slow.enabled).toBe(false);
    expect(slow.reasons.join(' ')).toMatch(/below the minimum/);

    expect(evaluateGpuPromotion({ ...passingEvidence, parityPassed: false }).enabled).toBe(false);
    expect(evaluateGpuPromotion({ ...passingEvidence, fallbackPassed: false }).enabled).toBe(false);
    expect(evaluateGpuPromotion({ ...passingEvidence, medianSpeedupVsCpuTiled: null }).enabled).toBe(false);
  });

  it('blocks GPU selection on the promotion gate before probing hardware', () => {
    const eligibility = resolveGpuEligibility({ webgpuAvailable: true, modeSupportedByGpu: true });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reason).toBe('promotion-gates-open');
  });

  it('falls back explicitly when WebGPU is unavailable or the mode is unsupported', () => {
    const unavailable = resolveGpuEligibility(
      { webgpuAvailable: false, modeSupportedByGpu: true },
      passingEvidence,
    );
    expect(unavailable).toMatchObject({ eligible: false, reason: 'webgpu-unavailable' });

    // Imported meshes and lattice types outside the GPU pipeline land here.
    const unsupported = resolveGpuEligibility(
      { webgpuAvailable: true, modeSupportedByGpu: false },
      passingEvidence,
    );
    expect(unsupported).toMatchObject({ eligible: false, reason: 'unsupported-mode' });

    expect(resolveGpuEligibility(
      { webgpuAvailable: true, modeSupportedByGpu: true },
      passingEvidence,
    ).eligible).toBe(true);
  });
});

describe('backend fallback behavior', () => {
  it('falls back explicitly when the preferred backend loses its device', async () => {
    const deviceLost: MarchingCubesBackend = {
      id: 'webgpu-mc',
      run: () => Promise.reject(new Error('GPU device lost')),
    };
    const outcome = await runBackendWithFallback(deviceLost, cpuSingleBackend, tinyFixture);
    expect(outcome.fellBack).toBe(true);
    expect(outcome.fallbackReason).toMatch(/device lost/);
    expect(outcome.run.backend).toBe('cpu-single');
    expect(outcome.run.result.triCount).toBeGreaterThan(0);
  });

  it('falls back when the preferred backend errors mid-run', async () => {
    const failing: MarchingCubesBackend = {
      id: 'webgpu-mc',
      run: () => Promise.reject(new Error('shader compilation failed')),
    };
    const outcome = await runBackendWithFallback(failing, createCpuTiledBackend(), tinyFixture);
    expect(outcome.fellBack).toBe(true);
    expect(outcome.run.backend).toBe('cpu-tiled');
  });

  it('uses the preferred backend without fallback when it succeeds', async () => {
    const outcome = await runBackendWithFallback(createCpuTiledBackend(), cpuSingleBackend, tinyFixture);
    expect(outcome.fellBack).toBe(false);
    expect(outcome.fallbackReason).toBeNull();
    expect(outcome.run.backend).toBe('cpu-tiled');
  });

  it('treats cancellation as an abort, never a silent fallback delivery', async () => {
    let fallbackRan = false;
    const probe: MarchingCubesBackend = {
      id: 'cpu-single',
      run: () => {
        fallbackRan = true;
        return cpuSingleBackend.run(tinyFixture);
      },
    };
    await expect(runBackendWithFallback(
      createCpuTiledBackend(),
      probe,
      tinyFixture,
      { isCancelled: () => true },
    )).rejects.toThrow(/Cancelled/);
    expect(fallbackRan).toBe(false);
  });

  it('rejects a cancelled tiled run before delivering geometry', async () => {
    const tiles = createCpuTiledBackend();
    await expect(tiles.run(tinyFixture, { isCancelled: () => true })).rejects.toThrow(/Cancelled/);
    const completed: BackendRunResult = await tiles.run(tinyFixture);
    expect(completed.result.triCount).toBeGreaterThan(0);
  });
});
