// Pure helpers for the station lines: joins, grouping, sorting and number formatting.
// No React and no data of its own.
import { isActiveStatus } from '@/lib/domain/status';
import type { OpsQueueRow, OpsRequestRow, StationRow, UnitRow } from '@/lib/stdb';
import { minsFromNow } from '@/lib/time/sim';

/** A queue entry joined to its request (undefined until the ops_request row arrives). */
export type QueueLine = { entry: OpsQueueRow; request: OpsRequestRow | undefined };

export type StationLine = {
  station: StationRow;
  /** The station's unit callsigns, by unit id. */
  callsigns: string[];
  /** The station's queue entries, by rank ascending. */
  rows: QueueLine[];
};

export type QueueModel = {
  /** One line per station, by station id. */
  lines: StationLine[];
  /** Active requests with no queue entry yet, newest first. */
  assessing: OpsRequestRow[];
  /** Requests with an active status. */
  activeCount: number;
  callsignByUnit: ReadonlyMap<number, string>;
  stationNameById: ReadonlyMap<number, string>;
  /** Index in `lines` of the first station with anyone in line, or -1. */
  firstBusyLine: number;
};

const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

function groupBy<T>(rows: readonly T[], key: (row: T) => number): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = out.get(k);
    if (list) list.push(row);
    else out.set(k, [row]);
  }
  return out;
}

export function buildQueueModel(
  stations: readonly StationRow[],
  units: readonly UnitRow[],
  queue: readonly OpsQueueRow[],
  requests: readonly OpsRequestRow[]
): QueueModel {
  const requestById = new Map(requests.map(r => [String(r.id), r] as const));
  const queuedIds = new Set(queue.map(e => String(e.requestId)));
  const queueByStation = groupBy(queue, e => e.stationId);
  const unitsByStation = groupBy(units, u => u.stationId);

  // groupBy returns fresh arrays, so sorting them in place is safe.
  const lines = [...stations]
    .sort((a, b) => a.id - b.id)
    .map(station => ({
      station,
      callsigns: (unitsByStation.get(station.id) ?? []).sort((a, b) => a.id - b.id).map(u => u.callsign),
      rows: (queueByStation.get(station.id) ?? [])
        .sort((a, b) => a.rank - b.rank || cmpBig(a.requestId, b.requestId))
        .map(entry => ({ entry, request: requestById.get(String(entry.requestId)) })),
    }));

  const active = requests.filter(r => isActiveStatus(r.status));
  const assessing = active
    .filter(r => !queuedIds.has(String(r.id)))
    .sort((a, b) => cmpBig(b.createdAt.microsSinceUnixEpoch, a.createdAt.microsSinceUnixEpoch) || cmpBig(b.id, a.id));

  return {
    lines,
    assessing,
    activeCount: active.length,
    callsignByUnit: new Map(units.map(u => [u.id, u.callsign] as const)),
    stationNameById: new Map(stations.map(s => [s.id, s.name] as const)),
    firstBusyLine: lines.findIndex(l => l.rows.length > 0),
  };
}

/** Whole minutes until the crew arrives (etaS is an absolute sim second), never below 0. */
export function etaMinutes(etaS: number, simNow: number): number {
  return Math.max(0, Math.round(minsFromNow(etaS, simNow)));
}

/** Slack in whole minutes. Below 0 means the crew can't beat the fire. */
export function slackMinutes(slackS: number): number {
  return Math.round(slackS / 60);
}

export function headcountLabel(n: number): string {
  return n === 1 ? '1 person' : `${n} people`;
}
