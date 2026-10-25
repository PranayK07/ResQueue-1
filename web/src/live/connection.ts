// One SpacetimeDB connection per tab, for one surface at a time. Each surface keeps its own saved identity, since
// claim_operator binds one operator row to an identity. The SDK's automatic reconnect handles drops mid-session
// (same cache, subscriptions replayed); our own backoff covers what it never retries, such as a failed first
// connection.

import { setGlobalLogLevel, type Identity } from 'spacetimedb';
import { DbConnection, type SubscriptionHandle } from '../module_bindings';
import type { ConnState } from '../ops/types';
import { CONFIG_ERROR, STDB_DB, STDB_URI } from './config';
import { loadJSON, remove, saveJSON } from './storage';
import { store } from './store';
import { groupsFor, type SourceName, type Surface } from './tables';

export type { ConnState };

// Row data and reducer arguments only appear in the SDK's trace logs; warn keeps locations and notes off the console.
setGlobalLogLevel('warn');

export interface ConnSnapshot {
  surface: Surface | null;
  state: ConnState;
  /** Wall-clock ms the connection was last known live; null before the first connect. */
  lastLiveAt: number | null;
  /** The surface's core subscription has applied, so its rows are present (maybe stale). */
  ready: boolean;
  identity: Identity | null;
  /** The server rejected this surface's saved identity, so it has a new one (a resident loses their card). */
  tokenReset: boolean;
  /** Last connection or subscription error, for display. */
  error: string | null;
}

export const INITIAL_SNAPSHOT: ConnSnapshot = {
  surface: null,
  state: 'connecting',
  lastLiveAt: null,
  ready: false,
  identity: null,
  tokenReset: false,
  error: null,
};

const SDK_RECONNECT = { minDelayMs: 1000, maxDelayMs: 10_000 };
/** Our retries for what the SDK won't retry: 1, 2, 4, 8 s, then every 10 s. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const RETRY_EVERY_MS = 10_000;
/** Failed first-connection attempts before the state reads 'error'. Retries continue. */
const ATTEMPTS_BEFORE_ERROR = 4;

// Saved with the server it belongs to: a local sandbox token would be rejected by maincloud, and the reverse.
type SavedToken = { uri: string; db: string; token: string };
const tokenKey = (surface: Surface) => `wrq.stdb.token:${surface}`;
const isSavedToken = (v: unknown): v is SavedToken => {
  const t = v as SavedToken;
  return typeof v === 'object' && v !== null && typeof t.token === 'string' && typeof t.uri === 'string' && typeof t.db === 'string';
};

function readToken(surface: Surface): string | undefined {
  const saved = loadJSON(tokenKey(surface), isSavedToken);
  return saved && saved.uri === STDB_URI && saved.db === STDB_DB && saved.token ? saved.token : undefined;
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : e === undefined ? 'unknown error' : String(e));
// The SDK's WebSocketTokenError ("Failed to verify token: 401 ...") isn't exported; match its status or text.
const tokenRejected = (e: Error) => {
  const status = (e as { status?: unknown }).status;
  return status === 401 || status === 403 || /\b40[13]\b/.test(e.message);
};

class ConnectionManager {
  private snap: ConnSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private conn: DbConnection | null = null;
  private core: SubscriptionHandle | null = null;
  private extras = new Map<SourceName, SubscriptionHandle>();
  private generation = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private windowHooked = false;
  private warned = new Set<SourceName>();

  getSnapshot = (): ConnSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Connect this tab as `surface`. Idempotent (safe from StrictMode effects); a new surface drops the old one. */
  use(surface: Surface) {
    if (this.snap.surface === surface) return;
    this.hookWindow();
    this.stop();
    this.attempt = 0;
    this.set({ ...INITIAL_SNAPSHOT, surface, state: isOnline() ? 'connecting' : 'offline' });
    this.build();
  }

  /** Subscribe every group again. Each old subscription ends only after its replacement applies, so rows don't flicker. */
  resubscribe() {
    if (this.conn && this.snap.state === 'live') this.subscribeAll(this.conn);
  }

  /** Skip the wait of our own backoff (the "Try again" button); resubscribes if live but not loaded. */
  retryNow() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      this.build();
    } else if (!this.snap.ready) {
      this.resubscribe();
    }
  }

  /** The connection, but only while live: reducer calls are refused otherwise. */
  liveConnection(): DbConnection | null {
    return this.snap.state === 'live' && this.conn?.isActive ? this.conn : null;
  }

  private set(patch: Partial<ConnSnapshot>) {
    const keys = Object.keys(patch) as (keyof ConnSnapshot)[];
    if (keys.every(k => Object.is(this.snap[k], patch[k]))) return;
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach(l => {
      try {
        l();
      } catch (e) {
        console.error('[live] connection listener failed', e);
      }
    });
  }

  /** SDK callbacks: ignore stale connections, and never let an exception escape into the SDK. */
  private guard(gen: number, fn: () => void) {
    if (gen !== this.generation) return;
    try {
      fn();
    } catch (e) {
      console.error('[live] connection callback failed', e);
    }
  }

  private build() {
    const surface = this.snap.surface;
    if (!surface) return;
    if (CONFIG_ERROR) {
      this.set({ state: 'error', error: CONFIG_ERROR });
      return;
    }
    const gen = ++this.generation;
    const saved = readToken(surface);
    let connected = false;
    let conn: DbConnection;
    try {
      // A fresh builder every time: a builder's callbacks are shared by every connection it builds.
      conn = DbConnection.builder()
        .withUri(STDB_URI)
        .withDatabaseName(STDB_DB)
        .withToken(saved)
        .withAutomaticReconnect(SDK_RECONNECT)
        .onConnect((c, identity, token) =>
          this.guard(gen, () => {
            connected = true;
            this.onLive(c, identity, token, true);
          })
        )
        .onAutomaticReconnect((c, identity, token) => this.guard(gen, () => this.onLive(c, identity, token, false)))
        .onDisconnect((_ctx, err, nextAttempt) => this.guard(gen, () => this.onDrop(err, nextAttempt)))
        .onConnectError((_ctx, err, nextAttempt) => this.guard(gen, () => this.onFail(err, nextAttempt, saved !== undefined || connected)))
        .build();
    } catch (e) {
      this.set({ state: 'error', error: messageOf(e) });
      return;
    }
    this.conn = conn;
    const { core, extra } = groupsFor(surface);
    store.attach(conn, [...core, ...extra]);
  }

  private onLive(c: DbConnection, identity: Identity, token: string, first: boolean) {
    const surface = this.snap.surface;
    if (surface && token) saveJSON(tokenKey(surface), { uri: STDB_URI, db: STDB_DB, token } satisfies SavedToken);
    this.attempt = 0;
    this.set({ state: 'live', lastLiveAt: Date.now(), identity, error: null });
    // After an automatic reconnect the SDK replays the subscriptions itself.
    if (first) this.subscribeAll(c);
  }

  private onDrop(err: Error | undefined, nextAttempt: number | undefined) {
    const lastLiveAt = this.snap.state === 'live' ? Date.now() : this.snap.lastLiveAt;
    if (nextAttempt !== undefined) {
      this.set({ state: isOnline() ? 'reconnecting' : 'offline', lastLiveAt, error: err ? messageOf(err) : null });
      return;
    }
    this.set({ lastLiveAt });
    this.scheduleRebuild(err);
  }

  private onFail(err: Error, nextAttempt: number | undefined, usedToken: boolean) {
    if (nextAttempt !== undefined) {
      this.set({ state: isOnline() ? 'reconnecting' : 'offline', error: messageOf(err) });
      return;
    }
    const surface = this.snap.surface;
    if (surface && usedToken && tokenRejected(err)) {
      // The saved identity is gone for good (e.g. the server was reset): continue as a new one right away.
      remove(tokenKey(surface));
      this.set({ tokenReset: true });
      this.teardown();
      this.build();
      return;
    }
    this.scheduleRebuild(err);
  }

  private subscribeAll(c: DbConnection) {
    const surface = this.snap.surface;
    if (!surface) return;
    const { core, extra } = groupsFor(surface);
    let previous = this.core;
    const handle: SubscriptionHandle = c
      .subscriptionBuilder()
      .onApplied(() =>
        this.guardConn(c, () => {
          endQuietly(previous, handle);
          previous = null;
          store.markApplied(core);
          this.set({ ready: true, error: null });
        })
      )
      .onError(ctx =>
        this.guardConn(c, () => {
          if (previous?.isActive()) {
            // A resubscribe failed, but the old subscription still holds the rows.
            this.core = previous;
          } else {
            if (this.core === handle) this.core = null;
            store.markFailed(core);
          }
          this.set({ error: `Couldn't load the incident data: ${messageOf((ctx as { event?: unknown }).event)}` });
        })
      )
      .subscribe(core.map(name => `SELECT * FROM ${name}`));
    this.core = handle;
    for (const name of extra) this.subscribeExtra(c, name);
  }

  /** Its own subscription, so a view or table an older module lacks only turns that feature off. */
  private subscribeExtra(c: DbConnection, name: SourceName) {
    let previous = this.extras.get(name) ?? null;
    const handle: SubscriptionHandle = c
      .subscriptionBuilder()
      .onApplied(() =>
        this.guardConn(c, () => {
          endQuietly(previous, handle);
          previous = null;
          store.markApplied([name]);
        })
      )
      .onError(ctx =>
        this.guardConn(c, () => {
          if (previous?.isActive()) {
            this.extras.set(name, previous);
            return;
          }
          if (this.extras.get(name) === handle) this.extras.delete(name);
          store.markFailed([name]);
          if (!this.warned.has(name)) {
            this.warned.add(name);
            console.warn(`[live] ${name} is unavailable (${messageOf((ctx as { event?: unknown }).event)}); the screens that use it fall back.`);
          }
        })
      )
      .subscribe(`SELECT * FROM ${name}`);
    this.extras.set(name, handle);
  }

  private guardConn(c: DbConnection, fn: () => void) {
    if (c !== this.conn) return;
    try {
      fn();
    } catch (e) {
      console.error('[live] subscription callback failed', e);
    }
  }

  private scheduleRebuild(err?: Error) {
    this.teardown();
    const delay = RETRY_DELAYS_MS[this.attempt] ?? RETRY_EVERY_MS;
    this.attempt += 1;
    let state: ConnState = 'reconnecting';
    if (!isOnline()) state = 'offline';
    else if (this.snap.lastLiveAt === null) state = this.attempt >= ATTEMPTS_BEFORE_ERROR ? 'error' : 'connecting';
    this.set({ state, error: err ? messageOf(err) : this.snap.error });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.build();
    }, delay);
  }

  private teardown() {
    this.generation += 1; // ignore anything the old connection still emits, including the disconnect below
    const c = this.conn;
    this.conn = null;
    this.core = null;
    this.extras.clear();
    store.detach();
    this.set({ ready: false });
    if (c) {
      try {
        c.disconnect();
      } catch {
        // Already closed.
      }
    }
  }

  private stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.teardown();
  }

  private hookWindow() {
    if (this.windowHooked || typeof window === 'undefined') return;
    this.windowHooked = true;
    window.addEventListener('offline', () => {
      if (!this.snap.surface || CONFIG_ERROR) return;
      this.set({ state: 'offline', lastLiveAt: this.snap.state === 'live' ? Date.now() : this.snap.lastLiveAt });
    });
    window.addEventListener('online', () => {
      if (!this.snap.surface || CONFIG_ERROR) return;
      if (this.conn?.isActive) {
        this.set({ state: 'live', lastLiveAt: Date.now() });
        return;
      }
      this.set({ state: this.snap.lastLiveAt === null ? 'connecting' : 'reconnecting' });
      if (this.retryTimer) {
        // Waiting on our own backoff: try now. Otherwise the SDK's own online listener reconnects.
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.attempt = 0;
        this.build();
      }
    });
  }
}

/** End the subscription a new one replaces, once (unsubscribe throws if called twice). */
function endQuietly(previous: SubscriptionHandle | null, replacement: SubscriptionHandle) {
  if (!previous || previous === replacement || previous.isEnded()) return;
  try {
    previous.unsubscribe();
  } catch {
    // Already ending.
  }
}

export const connection = new ConnectionManager();
