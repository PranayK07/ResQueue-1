import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type { SimClock } from '../ops/types';
import { connection, INITIAL_SNAPSHOT, type ConnSnapshot } from './connection';
import { store, type SourceStatus } from './store';
import type { RowOf, SourceName, Surface } from './tables';
import { clockFromRow, clockOrigin, simNowAt, tsToMs } from './time';

/** Rows count as stale after 5 s without a live connection. */
const STALE_MS = 5000;
const EMPTY: readonly never[] = Object.freeze([]);

/**
 * The surface a subtree belongs to (LiveGate provides it). Inside one, the hooks below read nothing while the tab's
 * connection is still on another surface, so one identity's rows never flash up in another's screen.
 */
export const SurfaceContext = createContext<Surface | null>(null);

// Each useSyncExternalStore below also passes its getSnapshot as the server snapshot, so the hooks render outside a
// browser too (react-dom/server); the client never uses it.
function useConnSnapshot(): ConnSnapshot {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot, connection.getSnapshot);
}

/** Does the connection serve `want` (an explicit surface, else the enclosing LiveGate's)? No surface: always. */
function useServes(surface: Surface | undefined): boolean {
  const ctx = useContext(SurfaceContext);
  const current = useConnSnapshot().surface;
  const want = surface ?? ctx;
  return want === null || current === want;
}

// One shared interval per period, however many components read the time. null pauses.
type Ticker = { now: number; listeners: Set<() => void>; id?: ReturnType<typeof setInterval> };
const tickers = new Map<number, Ticker>();
const noop = () => {};

function ticker(intervalMs: number): Ticker {
  let t = tickers.get(intervalMs);
  if (!t) {
    t = { now: Date.now(), listeners: new Set() };
    tickers.set(intervalMs, t);
  }
  return t;
}

function useTicker(intervalMs: number | null): number {
  const subscribe = useCallback(
    (onTick: () => void) => {
      if (intervalMs === null) return noop;
      const t = ticker(intervalMs);
      t.listeners.add(onTick);
      if (t.id === undefined) {
        t.now = Date.now();
        t.id = setInterval(() => {
          t.now = Date.now();
          t.listeners.forEach(l => l());
        }, intervalMs);
      }
      return () => {
        t.listeners.delete(onTick);
        if (t.listeners.size === 0 && t.id !== undefined) {
          clearInterval(t.id);
          t.id = undefined;
        }
      };
    },
    [intervalMs]
  );
  const getSnapshot = useCallback(() => (intervalMs === null ? 0 : ticker(intervalMs).now), [intervalMs]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type ConnectionInfo = ConnSnapshot & {
  /** No live connection for over 5 s: grey the data and say when it last updated. */
  stale: boolean;
  /** Reducer calls are allowed only while live. */
  canCall: boolean;
};

/** Connection state (for the enclosing LiveGate's surface, if any). */
export function useConnection(): ConnectionInfo {
  const ctx = useContext(SurfaceContext);
  const snap = useConnSnapshot();
  const mine = ctx === null || snap.surface === ctx;
  const watching = mine && snap.state !== 'live' && snap.lastLiveAt !== null;
  const now = useTicker(watching ? 1000 : null);
  const stale = watching && now - (snap.lastLiveAt ?? now) > STALE_MS;
  return useMemo(
    () => (mine ? { ...snap, stale, canCall: snap.state === 'live' } : { ...INITIAL_SNAPSHOT, surface: ctx, stale: false, canCall: false }),
    [mine, snap, stale, ctx]
  );
}

/**
 * Live rows of a table or view by wire name, e.g. useLiveRows('my_requests'). Frozen and stable until it changes.
 * [] when the source isn't part of the connected surface, or the connection serves another surface than
 * `surface` (default: the enclosing LiveGate's).
 */
export function useLiveRows<N extends SourceName>(name: N, surface?: Surface): readonly RowOf<N>[] {
  const serves = useServes(surface);
  const subscribe = useCallback((listener: () => void) => store.subscribe(name, listener), [name]);
  const getSnapshot = useCallback(() => store.rows(name), [name]);
  const rows = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return serves ? rows : EMPTY;
}

/** Whether a source's subscription has applied ('failed': an older module lacks it, so hide that feature). */
export function useSourceStatus(name: SourceName, surface?: Surface): SourceStatus {
  const serves = useServes(surface);
  const subscribe = useCallback((listener: () => void) => store.subscribe(name, listener), [name]);
  const getSnapshot = useCallback(() => store.status(name), [name]);
  const status = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return serves ? status : 'off';
}

/** Sim seconds now, re-rendering every `intervalMs` while the clock runs. Undefined without a clock. */
export function useSimNow(clock: SimClock | undefined, intervalMs = 1000): number | undefined {
  const now = useTicker(clock?.running ? intervalMs : null);
  // A row newer than the last tick reads as its own simS (elapsed clamps at 0), so the value never runs backwards.
  return clock ? simNowAt(clock, now) : undefined;
}

/**
 * The sim clock of the connected surface as a SimClock (lastTickMs = receipt time; originMs = the replay's real start
 * or the scenario's own T+0, see LiveExtras.timeBasis), for screens that don't use an ops snapshot. Undefined until
 * the sim_clock row arrives.
 */
export function useLiveClock(surface?: Surface): SimClock | undefined {
  const rows = useLiveRows('sim_clock', surface);
  const incidents = useLiveRows('incident', surface);
  const row = rows.find(r => r.id === 0) ?? rows[0];
  const incident = incidents.find(r => r.id === 0) ?? incidents[0];
  return useMemo(() => {
    if (!row) return undefined;
    const clock = clockFromRow(row, store.changedAt('sim_clock'));
    const { originMs } = clockOrigin(row, clock, incident ? tsToMs(incident.startAt) : null);
    return { ...clock, originMs };
  }, [row, incident]);
}
