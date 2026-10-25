import { cellIdAt } from '../ops/derive';
import type { MockPing } from '../ops/sources';
import type { CommandSnapshot } from '../ops/types';

// Simulated residents pinging for help (submit_mock_requests): 300–1500 m from the fire (anywhere in the incident
// area before anything burns), never on a burning cell. Reports use words the intake agent's keyword reader
// understands, so the triage shows trapped / injured / fire-seen claims. ASCII apostrophes only.

const M_PER_DEG_LAT = 111_320;
const REPORTS = [
  "We're trapped, a tree down across the road and we can't drive out. 3 of us here.",
  'Flames about 300 meters from our house, embers landing in the yard.',
  'My dad is hurt, his arm is bleeding. We have no car.',
  'Thick smoke, hard to breathe. My 84-year-old grandmother uses a wheelchair.',
  'I can see the fire from the window. 2 adults and two dogs.',
  "Dad is on an oxygen tank and we can't leave.",
  'We have a newborn baby and the smoke is getting worse.',
];
const NEEDS = ['', '', 'mobility', 'medical', 'elderly', 'pets', 'oxygen', 'infant'];
const pick = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

export function mockPings(s: CommandSnapshot, count: number, withReports: boolean): MockPing[] {
  const g = s.grid;
  if (!g.rows || !g.cols || !g.cellSizeM) return [];
  const mLat = 1 / M_PER_DEG_LAT;
  const mLon = 1 / (M_PER_DEG_LAT * Math.cos((g.originLat * Math.PI) / 180));
  const burning = new Set(s.fireCells.map(c => c.cellId));
  const centre = (id: number) => ({
    lat: g.originLat + (Math.floor(id / g.cols) + 0.5) * g.cellSizeM * mLat,
    lon: g.originLon + ((id % g.cols) + 0.5) * g.cellSizeM * mLon,
  });
  const pings: MockPing[] = [];
  for (let i = 0; i < count; i++) {
    for (let tries = 0; tries < 60; tries++) {
      let lat: number;
      let lon: number;
      if (s.fireCells.length) {
        const c = centre(pick(s.fireCells).cellId);
        const d = 300 + Math.random() * 1200;
        const a = Math.random() * 2 * Math.PI;
        lat = c.lat + d * Math.cos(a) * mLat;
        lon = c.lon + d * Math.sin(a) * mLon;
      } else {
        lat = g.originLat + (0.1 + 0.8 * Math.random()) * g.rows * g.cellSizeM * mLat;
        lon = g.originLon + (0.1 + 0.8 * Math.random()) * g.cols * g.cellSizeM * mLon;
      }
      const id = cellIdAt(g, lat, lon);
      if (id < 0 || burning.has(id)) continue;
      pings.push({
        lat,
        lon,
        headcount: 1 + Math.floor(Math.random() * 4),
        needs: pick(NEEDS),
        note: '',
        report: withReports ? REPORTS[i % REPORTS.length] : '',
      });
      break;
    }
  }
  return pings;
}
