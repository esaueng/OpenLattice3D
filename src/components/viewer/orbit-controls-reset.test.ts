import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  finishOrbitControlsAfterCameraReset,
  prepareOrbitControlsForCameraReset,
} from './orbit-controls-reset';

describe('viewer orbit control camera resets', () => {
  it('restores controls after overlapping camera resets finish', () => {
    const controls = {
      enabled: true,
      target: new THREE.Vector3(),
      update: vi.fn(),
      state: -1,
    };
    const firstReset = prepareOrbitControlsForCameraReset(controls);
    const secondReset = prepareOrbitControlsForCameraReset(controls);

    expect(controls.enabled).toBe(false);

    finishOrbitControlsAfterCameraReset(firstReset, new THREE.Vector3(1, 2, 3));
    expect(controls.enabled).toBe(false);

    finishOrbitControlsAfterCameraReset(secondReset, new THREE.Vector3(1, 2, 3));
    expect(controls.enabled).toBe(true);
    expect(controls.target.toArray()).toEqual([1, 2, 3]);
  });

  it('preserves an intentionally disabled controller', () => {
    const controls = {
      enabled: false,
      target: new THREE.Vector3(),
      update: vi.fn(),
      state: -1,
    };
    const reset = prepareOrbitControlsForCameraReset(controls);

    finishOrbitControlsAfterCameraReset(reset, new THREE.Vector3());

    expect(controls.enabled).toBe(false);
  });
});
