// GPU backend promotion gate. The webgpu-mc backend stays disabled until
// parity, fallback, and performance evidence says otherwise; this module is
// the only place that decides. See docs/performance/parity-gates.md.
import type { GenerationBackendId } from './types';

export const GPU_BACKEND_ID: GenerationBackendId = 'webgpu-mc';

/**
 * Reviewed minimum end-to-end speedup versus cpu-tiled (median of warm runs
 * on documented hardware) required before webgpu-mc may be selected. Below
 * this, GPU setup and readback overheads are not worth the selection risk.
 */
export const GPU_PROMOTION_MIN_SPEEDUP = 1.5;

export interface GpuPromotionEvidence {
  /** Parity gate green on every fixture against both CPU backends. */
  parityPassed: boolean;
  /** Cancellation, stale-result, device-loss, and unsupported-mode tests green. */
  fallbackPassed: boolean;
  /** Median warm-run end-to-end speedup vs cpu-tiled from a committed report. */
  medianSpeedupVsCpuTiled: number | null;
}

export interface GpuPromotionDecision {
  enabled: boolean;
  reasons: string[];
}

export function evaluateGpuPromotion(evidence: GpuPromotionEvidence): GpuPromotionDecision {
  const reasons: string[] = [];
  if (!evidence.parityPassed) reasons.push('parity gate has not passed on every fixture');
  if (!evidence.fallbackPassed) reasons.push('fallback gate has not passed');
  if (evidence.medianSpeedupVsCpuTiled === null) {
    reasons.push('no warm-run benchmark speedup recorded against cpu-tiled');
  } else if (evidence.medianSpeedupVsCpuTiled < GPU_PROMOTION_MIN_SPEEDUP) {
    reasons.push(
      `median speedup ${evidence.medianSpeedupVsCpuTiled.toFixed(2)}x is below the minimum ${GPU_PROMOTION_MIN_SPEEDUP}x`,
    );
  }
  return { enabled: reasons.length === 0, reasons };
}

/**
 * Current evidence. All gates start closed: there is no webgpu-mc
 * implementation yet, so no parity or benchmark evidence exists. Update this
 * only together with a committed parity/benchmark report proving the values.
 */
export const GPU_PROMOTION_EVIDENCE: GpuPromotionEvidence = {
  parityPassed: false,
  fallbackPassed: false,
  medianSpeedupVsCpuTiled: null,
};

export type GpuIneligibilityReason = 'promotion-gates-open' | 'webgpu-unavailable' | 'unsupported-mode';

export interface GpuEligibilityRequest {
  /** navigator.gpu (or WorkerNavigator.gpu) is present and an adapter was acquired. */
  webgpuAvailable: boolean;
  /** The job's shape, lattice type, variant, and mode are covered by the GPU pipeline. */
  modeSupportedByGpu: boolean;
}

export interface GpuEligibility {
  eligible: boolean;
  reason: GpuIneligibilityReason | null;
  /** Why the promotion gate is closed, when it is the blocking reason. */
  gateReasons: string[];
}

/**
 * Whether a generation job may select the GPU backend. The promotion gate is
 * evaluated first so hardware probing never masks an unproven backend.
 */
export function resolveGpuEligibility(
  request: GpuEligibilityRequest,
  evidence: GpuPromotionEvidence = GPU_PROMOTION_EVIDENCE,
): GpuEligibility {
  const promotion = evaluateGpuPromotion(evidence);
  if (!promotion.enabled) {
    return { eligible: false, reason: 'promotion-gates-open', gateReasons: promotion.reasons };
  }
  if (!request.webgpuAvailable) {
    return { eligible: false, reason: 'webgpu-unavailable', gateReasons: [] };
  }
  if (!request.modeSupportedByGpu) {
    return { eligible: false, reason: 'unsupported-mode', gateReasons: [] };
  }
  return { eligible: true, reason: null, gateReasons: [] };
}
