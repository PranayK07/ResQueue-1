// Needs, copied from KNOWN_NEEDS in spacetimedb/src/index.ts.

export const KNOWN_NEEDS = ['mobility', 'medical', 'oxygen', 'infant', 'elderly', 'pets', 'language'] as const;
export type Need = (typeof KNOWN_NEEDS)[number];

export const NEED_LABEL: Record<Need, string> = {
  mobility: 'Mobility',
  medical: 'Medical',
  oxygen: 'Oxygen',
  infant: 'Infant',
  elderly: 'Elderly',
  pets: 'Pets',
  language: 'Language',
};

const isNeed = (s: string): s is Need => (KNOWN_NEEDS as readonly string[]).includes(s);

/** Mirrors cleanNeeds() in the module: trim, lowercase, drop unknowns, dedupe, keep order. */
export function parseNeeds(csv: string): Need[] {
  const out: Need[] = [];
  for (const raw of csv.split(',')) {
    const s = raw.trim().toLowerCase();
    if (isNeed(s) && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The comma list the reducers take. */
export function joinNeeds(needs: readonly string[]): string {
  return parseNeeds(needs.join(',')).join(',');
}
