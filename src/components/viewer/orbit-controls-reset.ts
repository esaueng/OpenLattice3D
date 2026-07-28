import * as THREE from 'three';

export type ResettableOrbitControls = {
  enabled?: boolean;
  target?: THREE.Vector3;
  update?: () => void;
  addEventListener?: (type: 'change', listener: () => void) => void;
  removeEventListener?: (type: 'change', listener: () => void) => void;
  state?: number;
  _sphericalDelta?: { set: (radius: number, phi: number, theta: number) => void };
  _panOffset?: { set: (x: number, y: number, z: number) => void };
  _scale?: number;
  _performCursorZoom?: boolean;
  _dollyDirection?: { set: (x: number, y: number, z: number) => void };
};

type OrbitControlsResetSession = {
  controls: ResettableOrbitControls;
};

type OrbitControlsResetState = {
  depth: number;
  wasEnabled: boolean | undefined;
};

// Auto-fit and persisted-camera restoration can run in the same frame. Treat
// their temporary disables as nested so the second reset cannot preserve the
// first reset's already-disabled state.
const activeOrbitControlsResets = new WeakMap<ResettableOrbitControls, OrbitControlsResetState>();

export function prepareOrbitControlsForCameraReset(controls: unknown): OrbitControlsResetSession | null {
  const orbitControls = controls as ResettableOrbitControls | null;
  if (!orbitControls) return null;

  const activeReset = activeOrbitControlsResets.get(orbitControls);
  if (activeReset) {
    activeReset.depth += 1;
  } else {
    activeOrbitControlsResets.set(orbitControls, {
      depth: 1,
      wasEnabled: orbitControls.enabled,
    });
  }

  orbitControls.enabled = false;
  orbitControls.state = -1;
  orbitControls._sphericalDelta?.set(0, 0, 0);
  orbitControls._panOffset?.set(0, 0, 0);
  orbitControls._scale = 1;
  orbitControls._performCursorZoom = false;
  orbitControls._dollyDirection?.set(0, 0, 0);
  return { controls: orbitControls };
}

export function finishOrbitControlsAfterCameraReset(
  resetSession: OrbitControlsResetSession | null,
  target: THREE.Vector3
): (() => void) | undefined {
  if (!resetSession) return undefined;

  const { controls } = resetSession;
  controls.target?.copy(target);
  controls.update?.();

  let finished = false;
  const restoreControls = () => {
    if (finished) return;
    finished = true;

    const activeReset = activeOrbitControlsResets.get(controls);
    if (!activeReset) return;

    activeReset.depth -= 1;
    if (activeReset.depth > 0) return;

    activeOrbitControlsResets.delete(controls);
    if (activeReset.wasEnabled !== undefined) controls.enabled = activeReset.wasEnabled;
    controls.state = -1;
    controls.update?.();
  };

  if (typeof window === 'undefined') {
    restoreControls();
    return undefined;
  }

  const frameId = window.requestAnimationFrame(restoreControls);
  return () => {
    window.cancelAnimationFrame(frameId);
    restoreControls();
  };
}
