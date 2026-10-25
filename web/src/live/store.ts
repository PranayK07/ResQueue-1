// Live rows over the SDK's client cache. One listener set per source, one notification per batch of row callbacks
// (flushed in a microtask), and a frozen array per source version, which useSyncExternalStore needs. Arrays are
// always rebuilt from the cache, never patched: views without a primary key (ops_risk, my_risk) deliver a change
// as insert-then-delete.

import type { DbConnection } from '../module_bindings';
import { ACCESSOR, SOURCE_NAMES, type RowOf, type SourceName } from './tables';

type RowCallback = (...args: unknown[]) => void;
type Handle = {
  iter(): Iterable<unknown>;
  onInsert(cb: RowCallback): void;
  removeOnInsert(cb: RowCallback): void;
  onDelete(cb: RowCallback): void;
  removeOnDelete(cb: RowCallback): void;
  onUpdate?(cb: RowCallback): void;
  removeOnUpdate?(cb: RowCallback): void;
};

/** off: not part of this surface · pending: subscribed, not applied yet · applied · failed (e.g. an older module). */
export type SourceStatus = 'off' | 'pending' | 'applied' | 'failed';

const EMPTY: readonly never[] = Object.freeze([]);

class RowStore {
  private conn: DbConnection | null = null;
  private sources = new Set<SourceName>();
  private applied = new Set<SourceName>();
  private failed = new Set<SourceName>();
  private versions = new Map<SourceName, number>();
  private snapshots = new Map<SourceName, { version: number; rows: readonly unknown[] }>();
  private listeners = new Map<SourceName, Set<() => void>>();
  private anyListeners = new Set<() => void>();
  private changed = new Map<SourceName, number>();
  private detachFns: Array<() => void> = [];
  private dirty = new Set<SourceName>();
  private flushQueued = false;
  private epochN = 0;

  /** Rows of a source on the current surface, frozen; the same array until the source changes. */
  rows<N extends SourceName>(name: N): readonly RowOf<N>[] {
    const version = this.versions.get(name) ?? 0;
    const cached = this.snapshots.get(name);
    if (cached && cached.version === version) return cached.rows as readonly RowOf<N>[];
    const handle = this.sources.has(name) ? this.handle(name) : undefined;
    let rows: readonly unknown[] = EMPTY;
    if (handle) {
      try {
        const next = Array.from(handle.iter());
        // Same row objects as before (a status change, a re-read): keep the old array so memos hold.
        const prev = cached?.rows;
        rows = !next.length ? EMPTY : prev && prev.length === next.length && next.every((r, i) => r === prev[i]) ? prev : Object.freeze(next);
      } catch {
        rows = EMPTY;
      }
    }
    this.snapshots.set(name, { version, rows });
    return rows as readonly RowOf<N>[];
  }

  version(name: SourceName): number {
    return this.versions.get(name) ?? 0;
  }

  /** Local time (ms) this browser received the last real row change of `name`; undefined before any. */
  changedAt(name: SourceName): number | undefined {
    return this.changed.get(name);
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

  /** Called once per batch in which any source changed. */
  subscribeAny(listener: () => void): () => void {
    this.anyListeners.add(listener);
    return () => {
      this.anyListeners.delete(listener);
    };
  }

  /** Subscribed on the current surface and applied, so its rows are real (maybe empty). */
  has(name: SourceName): boolean {
    return this.sources.has(name) && this.applied.has(name);
  }

  status(name: SourceName): SourceStatus {
    if (!this.sources.has(name)) return 'off';
    if (this.applied.has(name)) return 'applied';
    return this.failed.has(name) ? 'failed' : 'pending';
  }

  /** Bumped on every change to any source: a cheap "did anything change" stamp. */
  epoch(): number {
    return this.epochN;
  }

  // ─── Driven by connection.ts ───

  /** Mirror a connection's cache for these sources. */
  attach(conn: DbConnection, sources: readonly SourceName[]) {
    this.detach();
    this.conn = conn;
    this.sources = new Set(sources);
    for (const name of sources) {
      const handle = this.handle(name);
      if (!handle) continue;
      // The SDK doesn't catch callback errors (one would stop its message processing), so this never throws.
      const onChange: RowCallback = () => {
        try {
          this.markDirty(name, true);
        } catch {
          // Nothing useful to do; keep the SDK running.
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
    this.applied.clear();
    this.failed.clear();
    this.changed.clear();
    this.touchAll();
  }

  markApplied(names: readonly SourceName[]) {
    for (const name of names) {
      this.applied.add(name);
      this.failed.delete(name);
      this.markDirty(name, false);
    }
  }

  markFailed(names: readonly SourceName[]) {
    for (const name of names) {
      this.failed.add(name);
      this.applied.delete(name);
      this.markDirty(name, false);
    }
  }

  private touchAll() {
    for (const name of SOURCE_NAMES) this.markDirty(name, false);
  }

  private handle(name: SourceName): Handle | undefined {
    if (!this.conn) return undefined;
    return (this.conn.db as unknown as Record<string, Handle | undefined>)[ACCESSOR[name]];
  }

  /** rowChanged: a real row callback, as opposed to an attach, detach or subscription state change. */
  private markDirty(name: SourceName, rowChanged: boolean) {
    this.versions.set(name, (this.versions.get(name) ?? 0) + 1);
    this.epochN += 1;
    if (rowChanged) this.changed.set(name, Date.now());
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
    const notify = (l: () => void) => {
      try {
        l();
      } catch (e) {
        console.error('[live] store listener failed', e);
      }
    };
    for (const name of names) this.listeners.get(name)?.forEach(notify);
    if (names.length) this.anyListeners.forEach(notify);
  }
}

export const store = new RowStore();
