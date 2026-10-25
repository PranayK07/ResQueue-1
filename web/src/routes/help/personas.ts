// Demo personas for /help (spec 4.1). Invented on purpose and always shown as
// "Demo persona". Each is a label plus a suggested line only. The home is a
// random point in the middle 80% of the live grid, fixed per device.
import { pointAt, type GridGeom, type LatLon } from '@/lib/geo/grid';
import { loadJSON, saveJSON } from '@/lib/storage';

export type Persona = { label: string; line: string };

export const PERSONAS: readonly Persona[] = [
  { label: 'Rosa, 78, uses a walker, no car', line: "I use a walker and I don't have a car" },
  { label: "Mai, 34, two kids under 5, car won't start", line: "me and my two little kids, my car won't start" },
  { label: 'Jim, 66, on home oxygen', line: "I'm on oxygen at home and I can't drive" },
  { label: 'Luis, 41, broken leg, speaks Spanish', line: 'tengo la pierna rota y estoy solo' },
];

type Stored = { index: number; fx: number; fy: number };
const KEY = 'help:persona';
const isStored = (v: unknown): v is Stored => {
  const s = v as Stored;
  return (
    typeof v === 'object' &&
    v !== null &&
    Number.isInteger(s.index) &&
    typeof s.fx === 'number' &&
    typeof s.fy === 'number' &&
    s.fx >= 0.1 &&
    s.fx <= 0.9 &&
    s.fy >= 0.1 &&
    s.fy <= 0.9
  );
};

let cached: Stored | null = null;

/** This device's persona and home (fractions of the grid), picked once and kept. */
export function devicePersona(): { persona: Persona; fx: number; fy: number } {
  if (!cached) {
    const saved = loadJSON(KEY, isStored);
    if (saved && PERSONAS[saved.index]) {
      cached = saved;
    } else {
      // The only Math.random in web/src: a random persona and home, inside the middle 80% of the grid.
      cached = {
        index: Math.floor(Math.random() * PERSONAS.length),
        fx: 0.1 + Math.random() * 0.8,
        fy: 0.1 + Math.random() * 0.8,
      };
      saveJSON(KEY, cached);
    }
  }
  return { persona: PERSONAS[cached.index]!, fx: cached.fx, fy: cached.fy };
}

/** The persona's home on the live grid, so it adapts to whichever scenario is loaded. */
export function personaHome(grid: GridGeom, fx: number, fy: number): LatLon {
  return pointAt(fx, fy, grid);
}
