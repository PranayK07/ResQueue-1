// Live row store over the SDK's client cache. One listener set per source,
// one notification per batch of row callbacks, and a stable snapshot array
// per source version (what useSyncExternalStore needs).
import type { DbConnection } from '@/module_bindings';
import { ACCESSOR } from './queries';
import type { SourceName } from './rows';

type RowCallback = (...args: unknown[]) => void;
type Handle = {
  iter(): Iterable<unknown>;
  count(): bigint;
  onInsert(cb: RowCallback): void;
  removeOnInsert(cb: RowCallback): void;
  onDelete(cb: RowCallback): void;
  removeOnDelete(cb: RowCallback): void;
  onUpdate?(cb: RowCallback): void;
  removeOnUpdate?(cb: RowCallback): void;
};

const EMPTY: readonly never[] = Object.freeze([]);

class RowStore {
  private conn: DbConnection | null = null;
  private sources = new Set<SourceName>();
  private versions = new Map<SourceName, number>();
  private snapshots = new Map<SourceName, { version: number; rows: readonly unknown[] }>();
  private listeners = new Map<SourceName, Set<() => void>>();
  private changedAt = new Map<SourceName, number>();
  private detachFns: Array<() => void> = [];
  private dirty = new Set<SourceName>();
  private flushQueued = false;

  /** Start mirroring a connection's cache for these sources. */
  attach(conn: DbConnection, sources: readonly SourceName[]) {
    this.detach();
    this.conn = conn;
    this.sources = new Set(sources);
    for (const name of sources) {
      const handle = this.handle(name);
      if (!handle) continue;
      // The SDK doesn't catch callback errors (one would stop message processing), so never throw here.
      const onChange: RowCallback = () => {
        try {
          this.markDirty(name);
        } catch {
          // Marking dirty can't meaningfully fail; ignore to keep the SDK running.
        }
      };
      handle.onInsert(onChange);
      handle.onDelete(onChange);
      handle.onUpdate?.(onChange);
      this.detachFns.push(() => {
        handle.removeOnInsert(onChange);
        handle.removeOnDelete(onChange);
        handle.removeOnUpdate?.(onChange);
      });
    }
    this.touchAll();
  }

  /** Stop mirroring; every source reads empty until the next attach. */
  detach() {
    for (const fn of this.detachFns) fn();
    this.detachFns = [];
    this.conn = null;
    this.sources = new Set();
    this.touchAll();
  }

  /** Bump every source (connection swapped, subscription re-applied). */
  touchAll() {
    for (const name of Object.keys(ACCESSOR) as SourceName[]) this.markDirty(name, false);
  }

  has(name: SourceName): boolean {
    return this.sources.has(name);
  }

  subscribe(name: SourceName, listener: () => void): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  rows(name: SourceName): readonly unknown[] {
    const version = this.versions.get(name) ?? 0;
    const cached = this.snapshots.get(name);
    if (cached && cached.version === version) return cached.rows;
    const handle = this.sources.has(name) ? this.handle(name) : undefined;
    const rows = handle ? Object.freeze(Array.from(handle.iter())) : EMPTY;
    this.snapshots.set(name, { version, rows });
    return rows;
  }

  count(name: SourceName): number {
    return this.rows(name).length;
  }

  /** Wall-clock ms when a source last changed here (drives sim-time extrapolation). */
  lastChangedAt(name: SourceName): number | undefined {
    return this.changedAt.get(name);
  }

  private handle(name: SourceName): Handle | undefined {
    if (!this.conn) return undefined;
    return (this.conn.db as unknown as Record<string, Handle | undefined>)[ACCESSOR[name]];
  }

  /** rowChanged: a real row callback, as opposed to a re-read after attach/detach. */
  private markDirty(name: SourceName, rowChanged = true) {
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    if (rowChanged) this.changedAt.set(name, Date.now());
    this.dirty.add(name);
    if (!this.flushQueued) {
      this.flushQueued = true;
      queueMicrotask(() => this.flush());
    }
  }

  private flush() {
    this.flushQueued = false;
    const names = [...this.dirty];
    this.dirty.clear();
    for (const name of names) this.listeners.get(name)?.forEach(l => l());
  }
}

export const store = new RowStore();
