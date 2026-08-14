export const DEFAULT_VIEWER_BACKGROUND = '#000000';

const VIEWER_BACKGROUND_PATTERN = /^#[0-9a-fA-F]{6}$/;

export function parseViewerBackground(value: unknown): string | undefined {
  return typeof value === 'string' && VIEWER_BACKGROUND_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

export function normalizeViewerBackground(value: unknown): string {
  return parseViewerBackground(value) ?? DEFAULT_VIEWER_BACKGROUND;
}
