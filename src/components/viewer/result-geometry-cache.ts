// Shared display-resource cache keyed by generation result.
//
// The Solid, Cross-Section and X-Ray views share one display geometry per
// result so switching views never rebuilds the attribute buffers. An entry is
// kept while a mounted view holds it (reference count) or while its result is
// still "live" (the current result or the pinned run). Everything else is
// disposed and dropped, so a reset, a new model or an unpin releases the typed
// arrays and GPU buffers instead of pinning them in a module-level list.

export interface Disposable {
  dispose(): void;
}

export interface ResultResourceCache<K extends object, V extends Disposable> {
  /** Return the cached resource for `key`, building it on first use. */
  get(key: K): V;
  /**
   * Mark `key` as in use by one consumer. Returns the matching release
   * function. `resource` re-registers an entry evicted between render and
   * effect (e.g. by a StrictMode effect replay).
   */
  acquire(key: K, resource: V): () => void;
  /**
   * Declare which keys are still live. Idle entries for any other key are
   * disposed now; in-use ones are disposed when their last consumer releases.
   */
  setLive(keys: Iterable<K | null | undefined>): void;
  /** Dispose and drop every entry and forget the live set. */
  clear(): void;
  /** Number of cached entries (for tests and diagnostics). */
  readonly size: number;
  has(key: K): boolean;
}

interface Entry<V> {
  resource: V;
  refs: number;
}

export function createResultResourceCache<K extends object, V extends Disposable>(
  build: (key: K) => V,
): ResultResourceCache<K, V> {
  const entries = new Map<K, Entry<V>>();
  let live = new Set<K>();

  const drop = (key: K, entry: Entry<V>) => {
    if (entries.get(key) !== entry) return;
    entries.delete(key);
    entry.resource.dispose();
  };

  return {
    get(key) {
      const hit = entries.get(key);
      if (hit) return hit.resource;
      const resource = build(key);
      entries.set(key, { resource, refs: 0 });
      return resource;
    },
    acquire(key, resource) {
      let entry = entries.get(key);
      if (entry && entry.resource !== resource) {
        // Another consumer already rebuilt this key; the caller's copy is an
        // orphan only it uses, so dispose that copy when the caller lets go.
        let releasedOrphan = false;
        return () => {
          if (releasedOrphan) return;
          releasedOrphan = true;
          resource.dispose();
        };
      }
      if (!entry) {
        entry = { resource, refs: 0 };
        entries.set(key, entry);
      }
      const held = entry;
      held.refs += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        if (held.refs <= 0 && !live.has(key)) drop(key, held);
      };
    },
    setLive(keys) {
      live = new Set<K>();
      for (const key of keys) if (key) live.add(key);
      for (const [key, entry] of [...entries]) {
        if (entry.refs <= 0 && !live.has(key)) drop(key, entry);
      }
    },
    clear() {
      live = new Set<K>();
      const all = [...entries.values()];
      entries.clear();
      for (const entry of all) entry.resource.dispose();
    },
    get size() {
      return entries.size;
    },
    has(key) {
      return entries.has(key);
    },
  };
}
