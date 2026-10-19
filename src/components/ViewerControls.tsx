import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { resultBounds } from './viewer/ViewerMeshViews';
import { useShallow } from 'zustand/react/shallow';
import { canSelectView, useStore } from '../store/useStore';
import type { CameraPreset, ViewMode } from '../store/useStore';
import { ChevronDownIcon, EyeIcon } from './icons';

const VIEW_LABELS: Record<ViewMode, string> = {
  original: 'Original',
  lattice: 'Solid',
  cross_section: 'Cross-Section',
  xray: 'X-Ray',
};

const CAMERA_PRESETS: readonly { view: CameraPreset; label: string }[] = [
  { view: 'y', label: 'Front' },
  { view: 'z', label: 'Top' },
  { view: 'x', label: 'Right' },
  { view: 'iso', label: 'Isometric' },
];

const VIEW_HOTKEYS: Record<ViewMode, string> = {
  original: '1',
  lattice: '2',
  cross_section: '3',
  xray: '4',
};

export function ViewerControls() {
  const [crossSectionSettingsOpen, setCrossSectionSettingsOpen] = useState(false);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const store = useStore(useShallow((s) => ({
    resultMesh: s.resultMesh,
    viewMode: s.viewMode,
    viewerBackground: s.viewerBackground,
    demoModeActive: s.demoModeActive,
    clipPlane: s.clipPlane,
    originalMesh: s.originalMesh,
    sphereMode: s.sphereMode,
    setViewMode: s.setViewMode,
    setClipPlane: s.setClipPlane,
    setViewerBackground: s.setViewerBackground,
    requestCameraView: s.requestCameraView,
    resetViewport: s.resetViewport,
  })));
  const {
    resultMesh,
    viewMode,
    viewerBackground,
    demoModeActive,
    clipPlane,
  } = store;
  const crossSectionDisabled = !demoModeActive && !resultMesh;
  // Position in millimetres along the cut axis, so the slider means something physical.
  const cutMm = useMemo(() => {
    if (!resultMesh) return null;
    const bounds = resultBounds(resultMesh);
    const axisIndex = 'xyz'.indexOf(clipPlane.axis);
    const min = bounds.min.getComponent(axisIndex);
    const max = bounds.max.getComponent(axisIndex);
    return { value: min + clipPlane.position * (max - min), min, max };
  }, [clipPlane.axis, clipPlane.position, resultMesh]);

  // Dismiss the cross-section popover on Escape (returning focus to its trigger)
  // or on an outside click (WCAG 2.1.2 / 2.4.3).
  useEffect(() => {
    if (!crossSectionSettingsOpen) return;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setCrossSectionSettingsOpen(false);
        settingsButtonRef.current?.focus();
      }
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target) || settingsButtonRef.current?.contains(target)) return;
      setCrossSectionSettingsOpen(false);
    }

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [crossSectionSettingsOpen]);

  return (
    <div className="viewer-toolbar" role="group" aria-label="Viewer controls">
      <div className="view-buttons">
        {(Object.keys(VIEW_LABELS) as ViewMode[]).map((mode) => {
          const disabled = !canSelectView(store, mode);
          const selected = viewMode === mode && !disabled;

          if (mode !== 'cross_section') {
            return (
              <button
                key={mode}
                className={`btn btn-small ${selected ? 'btn-active' : ''}`}
                title={`Switch viewer to ${VIEW_LABELS[mode]} mode (${VIEW_HOTKEYS[mode]}).`}
                onClick={() => store.setViewMode(mode)}
                disabled={disabled}
                aria-pressed={selected}
              >
                {VIEW_LABELS[mode]}
              </button>
            );
          }

          return (
            <div key={mode} className="view-mode-slot view-mode-slot-settings">
              <button
                className={`btn btn-small ${selected ? 'btn-active' : ''}`}
                title={`Switch viewer to ${VIEW_LABELS[mode]} mode (${VIEW_HOTKEYS[mode]}).`}
                onClick={() => store.setViewMode(mode)}
                disabled={disabled}
                aria-pressed={selected}
              >
                {VIEW_LABELS[mode]}
              </button>
              <button
                ref={settingsButtonRef}
                className={`btn btn-small view-settings-button ${viewMode === mode || crossSectionSettingsOpen ? 'btn-active' : ''}`}
                type="button"
                title="Cross-section settings"
                aria-label="Cross-section settings"
                aria-expanded={crossSectionSettingsOpen}
                onClick={() => setCrossSectionSettingsOpen((open) => !open)}
                disabled={crossSectionDisabled}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                  <path d="M3 4h10" />
                  <path d="M3 8h10" />
                  <path d="M3 12h10" />
                  <path d="M6 2.75v2.5" />
                  <path d="M10 6.75v2.5" />
                  <path d="M7.5 10.75v2.5" />
                </svg>
              </button>
              {crossSectionSettingsOpen && !crossSectionDisabled && (
                <div ref={popoverRef} className="cross-section-popover" role="group" aria-label="Cross-section settings">
                  <div className="popover-row">
                    <span>Cut axis</span>
                    <div className="axis-buttons">
                      {(['x', 'y', 'z'] as const).map((axis) => (
                        <button
                          key={axis}
                          type="button"
                          className={`btn btn-tiny ${clipPlane.axis === axis ? 'btn-active' : ''}`}
                          onClick={() => store.setClipPlane({ axis })}
                          aria-pressed={clipPlane.axis === axis}
                        >
                          {axis.toUpperCase()}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="popover-row">
                    <span>Position</span>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={clipPlane.position}
                      onChange={(e) => store.setClipPlane({ position: Number(e.target.value) })}
                    />
                    <strong>
                      {cutMm ? `${cutMm.value.toFixed(1)} mm` : `${Math.round(clipPlane.position * 100)}%`}
                    </strong>
                  </label>
                  {cutMm && (
                    <div className="popover-row popover-note">
                      <span>{clipPlane.axis.toUpperCase()} range</span>
                      <span>{cutMm.min.toFixed(1)} to {cutMm.max.toFixed(1)} mm · {Math.round(clipPlane.position * 100)}%</span>
                    </div>
                  )}
                  <label className="popover-row popover-checkbox-row">
                    <input
                      type="checkbox"
                      checked={clipPlane.flipped}
                      onChange={(e) => store.setClipPlane({ flipped: e.target.checked })}
                    />
                    <span>Flip direction</span>
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!demoModeActive && (
        <>
          <span className="viewer-toolbar-divider" aria-hidden="true" />
          <CameraViewsMenu
            onSelect={(view) => store.requestCameraView(view)}
            onReset={() => store.resetViewport()}
          />
        </>
      )}
      <div className="viewer-background-swatch" title="Set the 3D viewer background color.">
        <input
          type="color"
          value={viewerBackground}
          title="Set the 3D viewer background color."
          onChange={(e) => store.setViewerBackground(e.target.value)}
          aria-label="Viewer background color"
        />
      </div>
    </div>
  );
}

/**
 * The view cube is drawn in the canvas and cannot take focus, so this menu is the
 * keyboard path to every camera preset. It follows the ARIA menu pattern.
 */
function CameraViewsMenu({ onSelect, onReset }: { onSelect: (view: CameraPreset) => void; onReset: () => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutside);
    return () => document.removeEventListener('pointerdown', closeOnOutside);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  const handleMenuKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (next: number) => items[(next + items.length) % items.length]?.focus();
    if (event.key === 'ArrowDown') { event.preventDefault(); focusAt(index + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); focusAt(index - 1); }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0); }
    else if (event.key === 'End') { event.preventDefault(); focusAt(items.length - 1); }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') setOpen(false);
  };

  return (
    <div className="viewer-menu-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-small viewer-toolbar-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? 'viewer-camera-menu' : undefined}
        title="Camera views"
        onClick={() => setOpen((value) => !value)}
      >
        <EyeIcon size={15} />
        <span className="viewer-toolbar-label">Views</span>
        <ChevronDownIcon size={13} />
      </button>
      {open && (
        <div ref={menuRef} id="viewer-camera-menu" className="viewer-menu" role="menu" aria-label="Camera views" onKeyDown={handleMenuKeyDown}>
          {CAMERA_PRESETS.map((preset) => (
            <button key={preset.view} type="button" role="menuitem" tabIndex={-1} onClick={() => { onSelect(preset.view); close(true); }}>
              {preset.label}
            </button>
          ))}
          <div className="viewer-menu-separator" role="separator" />
          <button type="button" role="menuitem" tabIndex={-1} onClick={() => { onReset(); close(true); }}>
            Reset view <kbd>H</kbd>
          </button>
        </div>
      )}
    </div>
  );
}
