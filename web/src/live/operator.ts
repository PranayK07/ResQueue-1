// Operator sign-in. The my_operator view is the authority on who this identity is signed in as; it empties when a
// scenario reload deletes the responder logins. Locally we keep only the name, to prefill the form. Never the passcode.

import { useMemo } from 'react';
import type { OperatorInfo } from '../ops/types';
import { connection } from './connection';
import { useLiveRows } from './hooks';
import { call } from './reducers';
import { loadJSON, saveJSON } from './storage';
import type { RowOf, Surface } from './tables';

type Remembered = { role: OperatorInfo['role']; stationId: number; name: string };
const nameKey = (surface: Surface) => `wrq.operator:${surface}`;
const isRemembered = (v: unknown): v is Remembered => {
  const m = v as Remembered;
  return typeof v === 'object' && v !== null && (m.role === 'commander' || m.role === 'responder') && Number.isInteger(m.stationId) && typeof m.name === 'string';
};

/** Claims made in this tab, per surface and identity: the fallback when an older module has no my_operator view. */
const claimed = new Set<string>();
const claimKey = (surface: Surface) => `${surface}|${connection.getSnapshot().identity?.toHexString() ?? ''}`;

export function operatorOf(rows: readonly RowOf<'my_operator'>[]): OperatorInfo | null {
  const row = rows[0];
  if (!row || (row.role !== 'commander' && row.role !== 'responder')) return null;
  return { role: row.role, stationId: row.stationId, name: row.name };
}

/** Who this surface's identity is signed in as (my_operator view); null if nobody or the view is missing. */
export function useOperator(): OperatorInfo | null {
  const rows = useLiveRows('my_operator');
  return useMemo(() => operatorOf(rows), [rows]);
}

/**
 * claim_operator for the connected surface (a commander always claims station 0), then resubscribe so the
 * role-scoped views refill. Rejects with the server's reason, e.g. "bad passcode" (see errorCopy).
 */
export async function signIn(role: 'commander' | 'responder', stationId: number, name: string, passcode: string): Promise<void> {
  const surface = connection.getSnapshot().surface;
  const sid = role === 'commander' ? 0 : stationId;
  const who = name.trim().slice(0, 60) || (role === 'commander' ? 'Commander' : 'Responder');
  await call('claim_operator', { passcode, role, stationId: sid, name: who });
  if (surface) {
    saveJSON(nameKey(surface), { role, stationId: sid, name: who } satisfies Remembered);
    claimed.add(claimKey(surface));
  }
  connection.resubscribe();
}

/** The last sign-in on this surface ({role, stationId, name}), for prefilling the form. */
export function rememberedSignIn(surface: Surface): Remembered | null {
  return loadJSON(nameKey(surface), isRemembered);
}

/** True if this tab signed this surface's identity in (used only when the my_operator view is unavailable). */
export function claimedThisSession(surface: Surface): boolean {
  return claimed.has(claimKey(surface));
}
