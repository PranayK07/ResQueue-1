// One SpacetimeDB connection per tab, for one surface at a time. The SDK's
// automatic reconnect handles drops mid-session (same cache, subscriptions
// replayed); our own backoff covers what it never retries, such as a failed
// first connection.
import { setGlobalLogLevel, type Identity } from 'spacetimedb';
import { DbConnection, type SubscriptionHandle } from '@/module_bindings';
import { ENV, missingStdbEnv } from '@/lib/env';
import { loadJSON, remove, saveJSON } from '@/lib/storage';
import { QUERY_SETS, type Surface } from './queries';
import type { SourceName } from './rows';
import { store } from './store';

// Row data and reducer args only show up in the SDK's trace logs; staying at
// warn keeps locations and notes out of the console.
setGlobalLogLevel('warn');

export type ConnState = 'connecting' | 'live' | 'reconnecting' | 'offline' | 'error';

export type ConnSnapshot = {
  surface: Surface | null;
  state: ConnState;
  /** Wall-clock ms when the connection was last known live; null before the first connect. */
  lastLiveAt: number | null;
  /** The surface's subscription has applied, so rows are present (maybe stale). */
  ready: boolean;
  identity: Identity | null;
  /** The server rejected this tab's saved identity, so it has a new one (a resident loses their card). */
  tokenReset: boolean;
  /** Last connection or subscription error, for diagnostics. */
  error: string | null;
};

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
/** Our retries for failures the SDK won't retry: 1, 2, 4, 8, then every 10 s. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];
const RETRY_EVERY_MS = 10_000;
/** Failed first-connection attempts before the state reads as error. Retries continue. */
const ATTEMPTS_BEFORE_ERROR = 4;

// Saved with the server it belongs to: a token from the local sandbox would be
// rejected by the hosted demo database, and the reverse.
type SavedToken = { uri: string; db: string; token: string };
const tokenKey = (surface: Surface) => `stdb_token:${surface}`;
const isSavedToken = (v: unknown): v is SavedToken =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as SavedToken).token === 'string' &&
  typeof (v as SavedToken).uri === 'string' &&
  typeof (v as SavedToken).db === 'string';

function readToken(surface: Surface): string | undefined {
  const saved = loadJSON(tokenKey(surface), isSavedToken);
  return saved && saved.uri === ENV.stdbUri && saved.db === ENV.stdbDb ? saved.token : undefined;
}

function writeToken(surface: Surface, token: string) {
  saveJSON(tokenKey(surface), { uri: ENV.stdbUri, db: ENV.stdbDb, token });
}

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tokenRejected = (e: Error) => /\b40[13]\b/.test(e.message);

class ConnectionManager {
  private snap: ConnSnapshot = INITIAL_SNAPSHOT;
  private listeners = new Set<() => void>();
  private conn: DbConnection | null = null;
  private sub: SubscriptionHandle | null = null;
  private sources: readonly SourceName[] = [];
  private configKey = '';
  private generation = 0;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private windowHooked = false;

  getSnapshot = (): ConnSnapshot => this.snap;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Connect this tab as `surface`. Idempotent; switching surfaces drops the old connection. */
  use(surface: Surface, sources: readonly SourceName[] = QUERY_SETS[surface]) {
    const key = `${surface}|${sources.join(',')}`;
    if (key === this.configKey) return;
    this.hookWindow();
    this.stop();
    this.configKey = key;
    this.sources = sources;
    this.attempt = 0;
    this.set({ ...INITIAL_SNAPSHOT, surface, state: isOnline() ? 'connecting' : 'offline' });
    this.build();
  }

  /** The connection, but only while live: reducer calls are refused otherwise. */
  liveConnection(): DbConnection | null {
    return this.snap.state === 'live' && this.conn?.isActive ? this.conn : null;
  }

  /** Subscribe again (gap G3). The old subscription ends only after the new one applies, so rows don't flicker. */
  resubscribe() {
    if (this.conn && this.snap.state === 'live') this.subscribeAll(this.conn);
  }

  private set(patch: Partial<ConnSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    this.listeners.forEach(l => l());
  }

  private build() {
    const surface = this.snap.surface;
    if (!surface) return;
    const missing = missingStdbEnv();
    if (missing.length > 0) {
      this.set({ state: 'error', error: `Missing ${missing.join(' and ')} in web/.env.local` });
      return;
    }
    const gen = ++this.generation;
    const saved = readToken(surface);
    let conn: DbConnection;
    try {
      // A fresh builder every time: a builder's callbacks are shared by every connection it builds.
      conn = DbConnection.builder()
        .withUri(ENV.stdbUri!)
        .withDatabaseName(ENV.stdbDb!)
        .withToken(saved)
        .withAutomaticReconnect(SDK_RECONNECT)
        .onConnect((c, identity, token) => {
          if (gen === this.generation) this.onLive(c, identity, token, true);
        })
        .onAutomaticReconnect((c, identity, token) => {
          if (gen === this.generation) this.onLive(c, identity, token, false);
        })
        .onDisconnect((_ctx, err, nextAttempt) => {
          if (gen === this.generation) this.onDrop(err, nextAttempt);
        })
        .onConnectError((_ctx, err, nextAttempt) => {
          if (gen === this.generation) this.onFail(err, nextAttempt, saved !== undefined);
        })
        .build();
    } catch (e) {
      this.set({ state: 'error', error: messageOf(e) });
      return;
    }
    this.conn = conn;
    store.attach(conn, this.sources);
  }

  private onLive(c: DbConnection, identity: Identity, token: string, first: boolean) {
    writeToken(this.snap.surface!, token);
    this.attempt = 0;
    this.set({ state: 'live', lastLiveAt: Date.now(), identity, error: null });
    // After an automatic reconnect the SDK replays subscriptions itself.
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

  private onFail(err: Error, nextAttempt: number | undefined, hadToken: boolean) {
    if (nextAttempt !== undefined) {
      this.set({ state: isOnline() ? 'reconnecting' : 'offline', error: messageOf(err) });
      return;
    }
    if (hadToken && tokenRejected(err)) {
      // The saved identity is gone for good; continue as a new one right away.
      remove(tokenKey(this.snap.surface!));
      this.set({ tokenReset: true });
      this.teardown();
      this.build();
      return;
    }
    this.scheduleRebuild(err);
  }

  private subscribeAll(c: DbConnection) {
    const previous = this.sub;
    const handle: SubscriptionHandle = c
      .subscriptionBuilder()
      .onApplied(() => {
        if (c !== this.conn) return;
        if (previous && previous !== handle && !previous.isEnded()) {
          try {
            previous.unsubscribe();
          } catch {
            // Already ending.
          }
        }
        this.set({ ready: true });
      })
      .onError(ctx => {
        if (c === this.conn) this.set({ error: messageOf((ctx as { event?: unknown }).event) });
      })
      .subscribe(this.sources.map(name => `SELECT * FROM ${name}`));
    this.sub = handle;
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
    this.generation += 1; // ignore anything the old connection still emits
    const c = this.conn;
    this.conn = null;
    this.sub = null;
    store.detach();
    if (this.snap.ready) this.set({ ready: false });
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
    this.configKey = '';
  }

  private hookWindow() {
    if (this.windowHooked || typeof window === 'undefined') return;
    this.windowHooked = true;
    window.addEventListener('offline', () => {
      if (!this.snap.surface) return;
      this.set({ state: 'offline', lastLiveAt: this.snap.state === 'live' ? Date.now() : this.snap.lastLiveAt });
    });
    window.addEventListener('online', () => {
      if (!this.snap.surface) return;
      if (this.conn?.isActive) {
        this.set({ state: 'live', lastLiveAt: Date.now() });
        return;
      }
      this.set({ state: this.snap.lastLiveAt === null ? 'connecting' : 'reconnecting' });
      if (this.retryTimer) {
        // Waiting on our own backoff: try now. Otherwise the SDK's own online listener retries.
        clearTimeout(this.retryTimer);
        this.retryTimer = null;
        this.attempt = 0;
        this.build();
      }
    });
  }
}

export const connection = new ConnectionManager();
