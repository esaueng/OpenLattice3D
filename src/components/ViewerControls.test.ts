import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCubeMesh } from '../geometry/mesh-analysis';
import { useStore, type ViewMode } from '../store/useStore';
import { ViewerControls } from './ViewerControls';

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

beforeEach(() => {
  useStore.getState().resetProject();
});

describe('viewer mode accessibility', () => {
  it.each<[ViewMode, string]>([
    ['original', 'Original'], ['lattice', 'Solid'], ['cross_section', 'Cross-Section'], ['xray', 'X-Ray'],
  ])('announces %s as the sole pressed view mode', (mode, label) => {
    useStore.getState().setSampleShape('cube');
    useStore.getState().setResultMesh(generateCubeMesh(10));
    useStore.getState().setViewMode(mode);
    const html = renderToStaticMarkup(createElement(ViewerControls));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<button[^>]*aria-pressed="true"[^>]*>${label}</button>`));
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(3);
  });

  it('does not announce unavailable modes as selected in an empty workspace', () => {
    const html = renderToStaticMarkup(createElement(ViewerControls));
    expect(html).not.toContain('aria-pressed="true"');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(4);
  });
});
