// Request and unit statuses, copied from spacetimedb/src/index.ts (ACTIVE, LOCKED)
// and the module's close paths. not_found comes from complete_mission.
import type { Timestamp } from 'spacetimedb';

export const ACTIVE_STATUSES = ['pending', 'queued', 'assigned', 'en_route', 'on_scene'] as const;
/** A unit is committed: the policy can't move these and Pin is disabled. */
export const LOCKED_STATUSES = ['assigned', 'en_route', 'on_scene'] as const;
export const CLOSED_STATUSES = ['rescued', 'not_found', 'safe', 'revoked', 'expired'] as const;

export type ActiveStatus = (typeof ACTIVE_STATUSES)[number];
export type ClosedStatus = (typeof CLOSED_STATUSES)[number];
export type RequestStatus = ActiveStatus | ClosedStatus;

const has = (list: readonly string[], s: string) => list.includes(s);
export const isActiveStatus = (s: string): s is ActiveStatus => has(ACTIVE_STATUSES, s);
export const isLockedStatus = (s: string) => has(LOCKED_STATUSES, s);
export const isClosedStatus = (s: string): s is ClosedStatus => has(CLOSED_STATUSES, s);

export const REQUEST_STATUS_LABEL: Record<RequestStatus, string> = {
  pending: 'Received',
  queued: 'Queued',
  assigned: 'Assigned',
  en_route: 'En route',
  on_scene: 'On scene',
  rescued: 'Rescued',
  not_found: 'Not found',
  safe: 'Closed by resident',
  revoked: 'Sharing stopped',
  expired: 'Sharing window ended',
};

export function requestStatusLabel(s: string): string {
  return s in REQUEST_STATUS_LABEL ? REQUEST_STATUS_LABEL[s as RequestStatus] : s;
}

export const UNIT_STATUSES = ['available', 'assigned', 'en_route', 'on_scene', 'returning', 'out_of_service'] as const;
export type UnitStatus = (typeof UNIT_STATUSES)[number];

export const UNIT_STATUS_LABEL: Record<UnitStatus, string> = {
  available: 'Available',
  assigned: 'Assigned',
  en_route: 'En route',
  on_scene: 'On scene',
  returning: 'Returning',
  out_of_service: 'Out of service',
};

export function unitStatusLabel(s: string): string {
  return s in UNIT_STATUS_LABEL ? UNIT_STATUS_LABEL[s as UnitStatus] : s;
}

/** Agents heartbeat every 10 s; one counts as online if seen in the last 30 s. */
export const AGENT_ONLINE_MS = 30_000;

export function isAgentOnline(lastSeen: Timestamp, nowMs: number): boolean {
  return nowMs - Number(lastSeen.microsSinceUnixEpoch / 1000n) < AGENT_ONLINE_MS;
}
