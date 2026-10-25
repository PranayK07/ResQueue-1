// The simulated incident: what seed_scenario.py would load into SpacetimeDB.
// Geography follows agents/scenarios/paradise_demo.json (Paradise, CA);
// residents, stations and units are synthetic.

import type { Grid, PlanPolicy, Station, Unit } from '../types';

export const GRID: Grid = { originLat: 39.7, originLon: -121.68, cellSizeM: 300, rows: 60, cols: 80 };
export const M_PER_DEG_LAT = 111_320;
export const M_PER_DEG_LON = 111_320 * Math.cos((39.78 * Math.PI) / 180);

export const INCIDENT = { id: 'SIM-024', name: 'Pine Creek Fire', area: 'Butte County, CA · Sector 04' };

export const STATIONS: Station[] = [
  { id: 1, name: 'S01 Magalia', lat: 39.811, lon: -121.579 },
  { id: 2, name: 'S02 Canyon', lat: 39.7596, lon: -121.6219 },
  { id: 3, name: 'S03 Pentz', lat: 39.779, lon: -121.577 },
];

/** The responder phone in this demo belongs to E21 at S02. */
export const RESPONDER_ME = { stationId: 2, unitId: 21 };

const unit = (id: number, stationId: number, callsign: string, kind: string, capacity: number): Unit => {
  const s = STATIONS.find(x => x.id === stationId)!;
  return { id, stationId, callsign, kind, capacity, status: 'available', lat: s.lat, lon: s.lon, currentRequest: 0n, freeAtS: 0 };
};

export const UNITS: Unit[] = [
  unit(11, 1, 'E11', 'engine', 4),
  unit(12, 1, 'R11', 'rescue', 6),
  unit(13, 1, 'M11', 'ambulance', 3),
  unit(21, 2, 'E21', 'engine', 4),
  unit(22, 2, 'E22', 'engine', 4),
  unit(23, 2, 'M21', 'ambulance', 3),
  unit(31, 3, 'R31', 'rescue', 6),
  unit(32, 3, 'E31', 'engine', 4),
  unit(33, 3, 'E32', 'engine', 4),
];

// Fire: ignition east of town; default wind from the NE pushes it south-west.
export const IGNITION = { lat: 39.8, lon: -121.47 };
export const FIRE_AGE_AT_START_S = 3.0 * 3600;
export const DEFAULT_WEATHER = { windSpeedMps: 8, windFromDeg: 60, gustMps: 14 };

export const DEFAULT_POLICY: PlanPolicy = {
  marginS: 300, // agents/rescue/core/slack.py MARGIN_S
  distancePreference: { enabled: false, weight: 0 },
  includeGusts: false,
  includeHumidity: false,
  humidityPct: 25,
  keepPinsOnRerank: true,
};

export const CLOSURES = [
  // km east / north of S02 Canyon
  { id: 1n, name: 'Mill Rd', from: [-0.9, 1.4], to: [-0.7, 2.6] },
  { id: 2n, name: 'Ridge Rd', from: [3.4, 1.2], to: [3.9, 2.3] },
] as const;

// ─── Residents ─────────────────────────────────────────────────────────────

export interface ResidentSeed {
  id: bigint;
  lat: number;
  lon: number;
  headcount: number;
  needs: string;
  note: string;
  /** Minutes before scenario start the request was sent. */
  sentMinAgo: number;
}

const NEEDS = ['', '', '', 'mobility', 'medical', 'oxygen', 'infant', 'elderly', 'pets', 'mobility,oxygen', 'infant,pets'];
const NOTES = [
  'Side gate blocked. Use front entrance.',
  'Long gravel driveway, gate code 1142.',
  'No vehicle. Neighbor took the car.',
  'Dog in the house; will bring crate.',
  '',
  '',
  '',
];

/** Deterministic PRNG so every load gets the same incident. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 12 around S02 (tuned so its queue opens with a few critical requests),
// km east / north of the station, headcount, needs.
const NEAR_S02: [number, number, number, string][] = [
  [2.02, -0.9, 1, 'oxygen'],
  [0.92, 0.64, 3, 'mobility'],
  [3.16, 2.14, 2, ''],
  [0.76, 0.23, 1, 'medical'],
  [1.66, 0.7, 1, ''],
  [4.24, -1.0, 2, 'pets'],
  [3.37, 0.83, 1, 'mobility'],
  [3.14, 0.09, 2, 'infant'],
  [0.8, 1.93, 3, ''],
  [2.44, 0.66, 5, 'infant,pets'],
  [1.96, 1.76, 2, ''],
  [1.05, 0.78, 2, 'elderly'],
];
const EXTRA = 20;
const IDS = [18, 7, 29, 3, 11, 14, 21, 25, 31, 33, 36, 40, 4, 12, 24, 26, 1, 2, 5, 6, 8, 9, 10, 13, 15, 16, 17, 19, 20, 22, 23, 27];

export function seedResidents(isBurningAtStart: (lat: number, lon: number) => boolean): ResidentSeed[] {
  const rand = mulberry32(24);
  const s02 = STATIONS[1];
  const out: ResidentSeed[] = [];
  const add = (lat: number, lon: number, headcount: number, needs: string) => {
    const i = out.length;
    out.push({
      id: BigInt(IDS[i]),
      lat,
      lon,
      headcount,
      needs,
      note: NOTES[i % NOTES.length],
      sentMinAgo: 3 + Math.floor(rand() * 40),
    });
  };
  for (const [e, n, hc, needs] of NEAR_S02) {
    add(s02.lat + (n * 1000) / M_PER_DEG_LAT, s02.lon + (e * 1000) / M_PER_DEG_LON, hc, needs);
  }
  // The rest spread over Magalia, Pentz and east Paradise, never inside the fire.
  let guard = 0;
  while (out.length < NEAR_S02.length + EXTRA && guard++ < 1000) {
    const lat = 39.748 + rand() * 0.075;
    const lon = -121.64 + rand() * 0.09;
    if (isBurningAtStart(lat, lon)) continue;
    add(lat, lon, 1 + Math.floor(rand() * 5), NEEDS[Math.floor(rand() * NEEDS.length)]);
  }
  return out;
}
