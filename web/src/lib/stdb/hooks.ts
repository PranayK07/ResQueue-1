import { useCallback, useContext, useSyncExternalStore } from 'react';
import { useNow } from '@/lib/time/now';
import { connection, INITIAL_SNAPSHOT, type ConnSnapshot } from './connection';
import { SurfaceContext } from './context';
import type { RowOf, SourceName, TableName, TableRows, ViewName, ViewRows } from './rows';
import { store } from './store';

/** Data is stale after 5 s without a live connection (spec section 3). */
const STALE_MS = 5000;
const EMPTY: readonly never[] = Object.freeze([]);

function useSnapshot(): ConnSnapshot {
  return useSyncExternalStore(connection.subscribe, connection.getSnapshot);
}

/** Live rows of any table or view by wire name. Screens use useTable/useView; this is for dev tools. */
export function useSourceRows<N extends SourceName>(name: N): readonly RowOf<N>[] {
  const surface = useContext(SurfaceContext);
  const snap = useSnapshot();
  const subscribe = useCallback((listener: () => void) => store.subscribe(name, listener), [name]);
  const getSnapshot = useCallback(() => store.rows(name), [name]);
  const rows = useSyncExternalStore(subscribe, getSnapshot);
  // Rows held for another surface's identity never leak into this one.
  return (surface !== null && snap.surface === surface ? rows : EMPTY) as readonly RowOf<N>[];
}

/** Live rows of a public table, e.g. useTable('station'). */
export function useTable<N extends TableName>(name: N): readonly TableRows[N][] {
  return useSourceRows(name) as readonly TableRows[N][];
}

/** Live rows of a role-scoped view, e.g. useView('my_requests'). */
export function useView<N extends ViewName>(name: N): readonly ViewRows[N][] {
  return useSourceRows(name) as readonly ViewRows[N][];
}

type SingletonName = 'sim_clock' | 'grid' | 'weather' | 'forecast_meta' | 'world_version';

/** The id = 0 row of a singleton table, or undefined until it arrives. */
export function useSingleton<N extends SingletonName>(name: N): TableRows[N] | undefined {
  const rows = useTable(name);
  return rows.find(r => r.id === 0) ?? rows[0];
}

export type ConnectionInfo = ConnSnapshot & {
  /** Rows are older than 5 s without a live connection: gray them and show "Last update". */
  stale: boolean;
  /** Reducer calls are allowed only while live. */
  canCall: boolean;
};

/** Connection state for the surface this component belongs to. */
export function useConnection(): ConnectionInfo {
  const surface = useContext(SurfaceContext);
  const snap = useSnapshot();
  const mine = surface !== null && snap.surface === surface;
  const now = useNow(mine && snap.state !== 'live' && snap.lastLiveAt !== null ? 1000 : null);
  if (!mine) return { ...INITIAL_SNAPSHOT, surface, stale: false, canCall: false };
  const stale = snap.state !== 'live' && snap.lastLiveAt !== null && now - snap.lastLiveAt > STALE_MS;
  return { ...snap, stale, canCall: snap.state === 'live' };
}
