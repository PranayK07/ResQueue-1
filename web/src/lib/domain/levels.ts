// Danger levels, copied from LEVELS in spacetimedb/src/index.ts. They come from
// the danger agent; the UI never recomputes them.

export const LEVELS = ['unknown', 'unreachable', 'critical', 'high', 'moderate'] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_META: Record<Level, { label: string; hint: string; color: string }> = {
  unreachable: { label: 'Unreachable', hint: 'Needs a human decision', color: 'var(--lvl-unreachable)' },
  critical: { label: 'Critical', hint: 'Slack under 10 min', color: 'var(--lvl-critical)' },
  high: { label: 'High', hint: '10 to 30 min of slack', color: 'var(--lvl-high)' },
  moderate: { label: 'Moderate', hint: 'Over 30 min of slack', color: 'var(--lvl-moderate)' },
  unknown: { label: 'Not assessed', hint: 'Not assessed yet', color: 'var(--lvl-unknown)' },
};

/** Anything the module doesn't know reads as unknown. */
export function toLevel(s: string): Level {
  return (LEVELS as readonly string[]).includes(s) ? (s as Level) : 'unknown';
}

/** Most urgent first, for sorting and summaries. */
export const LEVEL_SEVERITY: Record<Level, number> = { unreachable: 0, critical: 1, high: 2, moderate: 3, unknown: 4 };

/** The current mission escalated (drives the /crew alert). */
export const isEscalated = (level: string) => level === 'critical' || level === 'unreachable';
