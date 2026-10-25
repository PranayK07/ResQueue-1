import { Timestamp } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import type { OpsQueueRow, OpsRequestRow, RoadClosureRow } from '@/lib/stdb/rows';
import { closuresLayer, forecastBand, forecastLayer, requestsLayer } from '@/lib/geo/layers';

const g = { originLat: 39.7, originLon: -121.68, cellSizeM: 300, rows: 60, cols: 80 };
const now = new Timestamp(1_800_000_000_000n * 1000n);

function request(over: Partial<OpsRequestRow>): OpsRequestRow {
  return {
    id: 1n,
    resident: undefined as never,
    channel: 'app',
    externalRef: '',
    lat: 39.75,
    lon: -121.6,
    locationPurged: false,
    headcount: 1,
    needs: '',
    note: '',
    status: 'pending',
    createdAt: now,
    createdSimS: 0,
    consentExpiresAt: now,
    level: 'unknown',
    slackS: undefined,
    fireEtaS: undefined,
    extractS: 0,
    dangerVersion: 0n,
    pinnedStationId: 0,
    hopCount: 0,
    updatedAt: now,
    ...over,
  };
}

describe('layers', () => {
  it('forecastBand splits at 30 and 60 minutes', () => {
    expect(forecastBand(-3)).toBe('lt30');
    expect(forecastBand(29.9)).toBe('lt30');
    expect(forecastBand(30)).toBe('30to60');
    expect(forecastBand(60)).toBe('30to60');
    expect(forecastBand(60.1)).toBe('gt60');
  });

  it('forecastLayer measures from sim now', () => {
    const fc = forecastLayer([{ cellId: 5, arrivalEarlyS: 4600, arrivalMedianS: 5000 }], g, 1000);
    expect(fc.features[0]!.properties).toEqual({ cellId: 5, minutes: 60, band: '30to60' });
  });

  it('requestsLayer skips purged locations and keeps u64 ids as strings', () => {
    const queue = [{ requestId: 2n, stationId: 3, rank: 4 } as OpsQueueRow];
    const fc = requestsLayer(
      [request({ id: 1n, locationPurged: true, lat: 0, lon: 0 }), request({ id: 2n, pinnedStationId: 3 })],
      queue
    );
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.properties).toMatchObject({ id: '2', rank: 4, stationId: 3, pinned: true });
    expect(fc.features[0]!.geometry.coordinates).toEqual([-121.6, 39.75]);
  });

  it('closuresLayer keeps active closures only, as [lon, lat] segments', () => {
    const base = { name: 'x', source: 'manual', updatedAt: now, lat1: 1, lon1: 2, lat2: 3, lon2: 4 };
    const fc = closuresLayer([
      { ...base, id: 1n, active: true } as RoadClosureRow,
      { ...base, id: 2n, active: false } as RoadClosureRow,
    ]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.geometry.coordinates).toEqual([
      [2, 1],
      [4, 3],
    ]);
    expect(fc.features[0]!.properties.id).toBe('1');
  });
});
