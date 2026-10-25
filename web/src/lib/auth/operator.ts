// Operator sign-in. The operator table is private and no view says who you
// are (gap G3), so after a successful claim the shell remembers the role,
// station, name and unit locally. Never the passcode.
import { useCallback, useSyncExternalStore } from 'react';
import { connection } from '@/lib/stdb/connection';
import { call } from '@/lib/stdb/reducers';
import { store } from '@/lib/stdb/store';
import { loadJSON, remove, saveJSON } from '@/lib/storage';

export type OperatorRole = 'commander' | 'responder';

export type OperatorMemory = {
  role: OperatorRole;
  /** 0 for the commander. */
  stationId: number;
  name: string;
  /** /crew only: the unit this person holds (0 = not picked). The backend doesn't track it. */
  unitId: number;
};

const SURFACE_FOR = { commander: 'command', responder: 'crew' } as const;
const RESUBSCRIBE_AFTER_MS = 2000;
const key = (role: OperatorRole) => `operator:${role}`;

const isMemory = (v: unknown): v is OperatorMemory => {
  const m = v as OperatorMemory;
  return (
    typeof v === 'object' &&
    v !== null &&
    (m.role === 'commander' || m.role === 'responder') &&
    Number.isInteger(m.stationId) &&
    typeof m.name === 'string' &&
    Number.isInteger(m.unitId)
  );
};

const cache = new Map<OperatorRole, OperatorMemory | null>();
const listeners = new Set<() => void>();

function read(role: OperatorRole): OperatorMemory | null {
  if (!cache.has(role)) cache.set(role, loadJSON(key(role), isMemory));
  return cache.get(role) ?? null;
}

function write(role: OperatorRole, value: OperatorMemory | null) {
  if (value) saveJSON(key(role), value);
  else remove(key(role));
  cache.set(role, value);
  listeners.forEach(l => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOperator(role: OperatorRole): OperatorMemory | null {
  return read(role);
}

/** The remembered sign-in for a role, or null. */
export function useOperator(role: OperatorRole): OperatorMemory | null {
  const getSnapshot = useCallback(() => read(role), [role]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * Wraps claim_operator. The commander always uses stationId 0. Rejects with
 * the server's message (for example "bad passcode"). Call it from the
 * matching screen: commander on /command, responder on /crew.
 */
export async function login(passcode: string, role: OperatorRole, stationId: number, name: string): Promise<void> {
  const surface = SURFACE_FOR[role];
  if (connection.getSnapshot().surface !== surface) throw new Error(`Sign in as ${role} from /${surface}.`);
  const sid = role === 'commander' ? 0 : stationId;
  await call('claim_operator', { passcode, role, stationId: sid, name });
  const prev = read(role);
  write(role, { role, stationId: sid, name, unitId: prev && prev.stationId === sid ? prev.unitId : 0 });
  // The views should refill once the operator row exists. If they're still empty after 2 s, resubscribe once.
  setTimeout(() => {
    if (
      connection.getSnapshot().surface === surface &&
      store.count('ops_request') === 0 &&
      store.count('ops_queue') === 0
    ) {
      connection.resubscribe();
    }
  }, RESUBSCRIBE_AFTER_MS);
}

/** /crew: remember which of the station's units this person holds. */
export function setOperatorUnit(unitId: number) {
  const m = read('responder');
  if (m) write('responder', { ...m, unitId });
}

/** Forget the local sign-in. The operator row stays with the identity on the server. */
export function forgetOperator(role: OperatorRole) {
  write(role, null);
}
