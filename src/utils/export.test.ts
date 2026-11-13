import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarchingCubesResult } from '../geometry/marching-cubes';
import { DOWNLOAD_URL_REVOKE_DELAY_MS, downloadSTL } from './export';

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  attached: boolean;
  clickedWhileAttached: boolean | null;
  click: () => void;
  remove: () => void;
}

const oneTriangle: MarchingCubesResult = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1]),
  triCount: 1,
};

describe('mesh download', () => {
  let anchors: FakeAnchor[];
  let revoked: string[];
  let createdBlobs: Blob[];

  beforeEach(() => {
    vi.useFakeTimers();
    anchors = [];
    revoked = [];
    createdBlobs = [];
    const createElement = vi.fn((tag: string) => {
      expect(tag).toBe('a');
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        attached: false,
        clickedWhileAttached: null,
        click: () => { anchor.clickedWhileAttached = anchor.attached; },
        remove: () => { anchor.attached = false; },
      };
      anchors.push(anchor);
      return anchor;
    });
    vi.stubGlobal('document', {
      createElement,
      body: { appendChild: (anchor: FakeAnchor) => { anchor.attached = true; return anchor; } },
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      createdBlobs.push(blob as Blob);
      return `blob:test/${createdBlobs.length}`;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => { revoked.push(url); });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('clicks an attached anchor, detaches it, and revokes the URL only after a delay', () => {
    downloadSTL(oneTriangle, 'part.stl');

    expect(anchors).toHaveLength(1);
    const [anchor] = anchors;
    expect(anchor.download).toBe('part.stl');
    expect(anchor.href).toBe('blob:test/1');
    expect(anchor.clickedWhileAttached).toBe(true);
    expect(anchor.attached).toBe(false);
    expect(createdBlobs[0].size).toBe(84 + 50);

    // Still valid in the click's tick and shortly after: the browser may not
    // have started reading the blob yet.
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(DOWNLOAD_URL_REVOKE_DELAY_MS - 1);
    expect(revoked).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revoked).toEqual(['blob:test/1']);
  });

  it('still detaches the anchor and schedules the revoke when the click throws', () => {
    vi.mocked(document.createElement).mockImplementationOnce(() => {
      const anchor = {
        href: '', download: '', rel: '', style: { display: '' }, attached: false, clickedWhileAttached: null,
        click: () => { throw new Error('blocked'); },
        remove: () => { anchor.attached = false; },
      } as FakeAnchor;
      anchors.push(anchor);
      return anchor as unknown as HTMLElement;
    });

    expect(() => downloadSTL(oneTriangle, 'part.stl')).toThrow('blocked');
    expect(anchors[0].attached).toBe(false);
    vi.advanceTimersByTime(DOWNLOAD_URL_REVOKE_DELAY_MS);
    expect(revoked).toEqual(['blob:test/1']);
  });
});
