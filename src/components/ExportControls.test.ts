import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { buildGenerationSnapshot } from '../store/generation-snapshot';
import { selectGenerationInputs } from '../store/useResultStaleness';
import { useStore } from '../store/useStore';
import { download3MF, downloadOBJ, downloadSTL } from '../utils/export';
import { trackUsage } from '../analytics';
import { ExportControls } from './ExportControls';

vi.mock('../analytics', () => ({ trackUsage: vi.fn() }));

const captured = vi.hoisted(() => ({
  buttons: [] as { children?: unknown; disabled?: boolean; onClick?: () => void }[],
  busyFormat: null as '3MF' | 'STL' | 'OBJ' | null,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useState: (initial: unknown) => actual.useState(initial === null ? captured.busyFormat : initial) };
});

// Retain real rendering while exposing the buttons' event handlers for the
// same click paths used in Chrome, without adding a DOM test dependency.
vi.mock('react/jsx-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-runtime')>();
  const wrap = (original: typeof actual.jsx) => (type: Parameters<typeof actual.jsx>[0], props: Parameters<typeof actual.jsx>[1], key?: string) => {
    if (type === 'button') captured.buttons.push(props as (typeof captured.buttons)[number]);
    return original(type, props, key);
  };
  return { ...actual, jsx: wrap(actual.jsx), jsxs: wrap(actual.jsxs) };
});

vi.mock('react/jsx-dev-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react/jsx-dev-runtime')>();
  return { ...actual, jsxDEV: (...args: Parameters<typeof actual.jsxDEV>) => {
    if (args[0] === 'button') captured.buttons.push(args[1] as (typeof captured.buttons)[number]);
    return actual.jsxDEV(...args);
  } };
});

vi.mock('../store/useStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/useStore')>();
  return {
    ...actual,
    useStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useStore.getState>) => unknown) => selector(actual.useStore.getState()),
      actual.useStore,
    ),
  };
});

vi.mock('../utils/export', () => ({
  download3MF: vi.fn(), downloadSTL: vi.fn(), downloadOBJ: vi.fn(), downloadProjectJSON: vi.fn(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  captured.buttons = [];
  captured.busyFormat = null;
  useStore.getState().resetProject();
  useStore.getState().setSampleShape('cube');
  useStore.setState({ generationSeed: 11 });
  const snapshot = buildGenerationSnapshot(selectGenerationInputs(useStore.getState()));
  useStore.getState().setResultMesh(generateCubeMesh(10), snapshot);
});

afterEach(() => vi.useRealTimers());

describe('mesh export provenance', () => {
  it.each(['3MF', 'STL', 'OBJ'] as const)('exports the completed run settings for %s after edits', async (format) => {
    const original = useStore.getState().resultSnapshot!;
    useStore.setState({
      params: { ...useStore.getState().params, cellSize: 12, latticeType: 'bcc', toleranceMm: 0.01 },
      generationSeed: 22,
      generating: true,
    });
    renderToStaticMarkup(createElement(ExportControls));
    const button = captured.buttons.find((entry) => entry.children === `Export previous ${format}`)!;
    expect(button).toBeDefined();
    button.onClick!();
    await vi.runAllTimersAsync();
    const exporter = { '3MF': download3MF, STL: downloadSTL, OBJ: downloadOBJ }[format];
    const call = vi.mocked(exporter).mock.calls[0];
    expect(call[0]).toBe(useStore.getState().resultMesh);
    expect(call.at(-1)).toMatchObject({ generationSeed: original.generationSeed, maxError: original.params.toleranceMm });
    if (format === 'OBJ') expect(call[1]).toMatchObject({ params: original.params });
  });
});

describe('export progress', () => {
  it.each(['3MF', 'STL', 'OBJ'] as const)('shows progress only on the selected %s button', (format) => {
    captured.busyFormat = format;
    renderToStaticMarkup(createElement(ExportControls));
    const formats = ['3MF', 'STL', 'OBJ'];
    expect(captured.buttons.slice(0, 3).map((button) => button.children))
      .toEqual(formats.map((entry) => entry === format ? 'Working...' : `Export ${entry}`));
    expect(captured.buttons.every((button) => button.disabled)).toBe(true);
  });
});


describe('export analytics wiring', () => {
  it('counts successful exports and coarse durations without provenance', async () => {
    renderToStaticMarkup(createElement(ExportControls));
    captured.buttons[0].onClick!();
    await vi.runAllTimersAsync();
    expect(trackUsage).toHaveBeenCalledWith('export_completed');
    expect(trackUsage).toHaveBeenCalledWith('operation_latency', expect.any(Number));
    expect(vi.mocked(trackUsage).mock.calls.every((call) => call.length <= 2)).toBe(true);
  });
  it('counts an export failure without sending the error text', async () => {
    vi.mocked(download3MF).mockImplementationOnce(() => { throw new Error('private-filename.3mf'); });
    renderToStaticMarkup(createElement(ExportControls));
    captured.buttons[0].onClick!();
    await vi.runAllTimersAsync();
    expect(trackUsage).toHaveBeenCalledExactlyOnceWith('export_failed');
  });
  it('counts project saves through the same privacy gate', () => {
    renderToStaticMarkup(createElement(ExportControls));
    captured.buttons.at(-1)!.onClick!();
    expect(trackUsage).toHaveBeenCalledWith('export_completed');
  });
});
