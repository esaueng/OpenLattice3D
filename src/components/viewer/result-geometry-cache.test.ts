import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createResultResourceCache } from './result-geometry-cache';

interface Key { id: string }

function harness() {
  const disposed: string[] = [];
  let builds = 0;
  const cache = createResultResourceCache<Key, { id: string; dispose: () => void }>((key) => {
    builds += 1;
    return { id: key.id, dispose: () => { disposed.push(key.id); } };
  });
  return { cache, disposed, builds: () => builds };
}

describe('result resource cache', () => {
  it('shares one resource per key across views', () => {
    const { cache, builds } = harness();
    const a = { id: 'a' };
    const first = cache.get(a);
    const releaseSolid = cache.acquire(a, first);
    cache.setLive([a]);
    releaseSolid();
    // Switching Solid -> X-Ray re-reads the same resource without a rebuild.
    expect(cache.get(a)).toBe(first);
    expect(builds()).toBe(1);
  });

  it('disposes and drops the previous result when it is replaced', () => {
    const { cache, disposed } = harness();
    const a = { id: 'a' };
    const b = { id: 'b' };
    const releaseA = cache.acquire(a, cache.get(a));
    cache.setLive([a]);

    // New result: the view swaps to b, then the owner updates the live set.
    releaseA();
    expect(disposed).toEqual([]);
    cache.acquire(b, cache.get(b));
    cache.setLive([b]);

    expect(disposed).toEqual(['a']);
    expect(cache.has(a)).toBe(false);
    expect(cache.has(b)).toBe(true);
  });

  it('keeps the pinned run until it is unpinned', () => {
    const { cache, disposed } = harness();
    const current = { id: 'current' };
    const pinned = { id: 'pinned' };
    cache.get(current);
    cache.get(pinned);
    cache.setLive([current, pinned]);
    expect(disposed).toEqual([]);

    cache.setLive([current, null]);
    expect(disposed).toEqual(['pinned']);
    expect(cache.size).toBe(1);
  });

  it('clears everything on reset once no view holds it', () => {
    const { cache, disposed } = harness();
    const a = { id: 'a' };
    const release = cache.acquire(a, cache.get(a));
    cache.setLive([a]);

    // Reset: the owner drops the result while the view is still mounted...
    cache.setLive([null, undefined]);
    expect(disposed).toEqual([]);
    // ...and the entry goes as soon as that view unmounts.
    release();
    expect(disposed).toEqual(['a']);
    expect(cache.size).toBe(0);
  });

  it('never disposes an entry that a mounted view still holds', () => {
    const { cache, disposed } = harness();
    const tiles = Array.from({ length: 12 }, (_, index) => ({ id: `tile-${index}` }));
    const releases = tiles.map((tile) => cache.acquire(tile, cache.get(tile)));
    cache.setLive([]);
    expect(disposed).toEqual([]);
    expect(cache.size).toBe(12);
    releases.forEach((release) => release());
    expect(disposed).toHaveLength(12);
    expect(cache.size).toBe(0);
  });

  it('ignores a repeated release', () => {
    const { cache, disposed } = harness();
    const a = { id: 'a' };
    const resource = cache.get(a);
    const releaseOne = cache.acquire(a, resource);
    const releaseTwo = cache.acquire(a, resource);
    releaseOne();
    releaseOne();
    expect(disposed).toEqual([]);
    releaseTwo();
    expect(disposed).toEqual(['a']);
  });

  it('re-registers a resource evicted between render and effect', () => {
    const { cache, disposed, builds } = harness();
    const a = { id: 'a' };
    const resource = cache.get(a);
    cache.setLive([]); // e.g. a StrictMode effect replay released it first
    expect(disposed).toEqual(['a']);
    const release = cache.acquire(a, resource);
    expect(cache.get(a)).toBe(resource);
    expect(builds()).toBe(1);
    release();
    expect(disposed).toEqual(['a', 'a']);
  });

  it('disposes a stale duplicate only when its holder releases it', () => {
    const { cache, disposed } = harness();
    const a = { id: 'a' };
    const stale = cache.get(a);
    cache.setLive([]);
    const fresh = cache.get(a);
    expect(fresh).not.toBe(stale);
    const releaseFresh = cache.acquire(a, fresh);
    const releaseStale = cache.acquire(a, stale);
    disposed.length = 0;
    releaseStale();
    expect(disposed).toEqual(['a']);
    expect(cache.get(a)).toBe(fresh);
    releaseFresh();
    expect(disposed).toEqual(['a', 'a']);
  });

  it('clear disposes every entry', () => {
    const { cache, disposed } = harness();
    cache.get({ id: 'a' });
    cache.get({ id: 'b' });
    cache.clear();
    expect(disposed.sort()).toEqual(['a', 'b']);
    expect(cache.size).toBe(0);
  });

  it('fires the three.js dispose event for evicted geometries', () => {
    const cache = createResultResourceCache<Key, THREE.BufferGeometry>(() => new THREE.BufferGeometry());
    const a = { id: 'a' };
    const geometry = cache.get(a);
    let disposeEvents = 0;
    geometry.addEventListener('dispose', () => { disposeEvents += 1; });
    cache.setLive([{ id: 'b' }]);
    expect(disposeEvents).toBe(1);
  });
});
