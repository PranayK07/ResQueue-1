import { cn } from '@/lib/utils';

export type WindDialProps = {
  /** Direction the wind blows from, in degrees clockwise from north. */
  fromDeg: number;
  className?: string;
};

/** Whole degrees in 0..359. */
const normDeg = (v: number): number => ((Math.round(v) % 360) + 360) % 360;

const TICKS = Array.from({ length: 12 }, (_, i) => i * 30);
const CARDINALS = [
  { label: 'N', x: 50, y: 5 },
  { label: 'E', x: 95, y: 50 },
  { label: 'S', x: 50, y: 95 },
  { label: 'W', x: 5, y: 50 },
] as const;

/** Compass with north at the top. The arrow points where the wind blows toward (from + 180). */
export function WindDial({ fromDeg, className }: WindDialProps) {
  const from = normDeg(fromDeg);
  const toward = normDeg(from + 180);

  return (
    <svg
      viewBox="0 0 100 100"
      role="img"
      aria-label={`Wind from ${from}°, blowing toward ${toward}°`}
      className={cn('text-muted-foreground', className)}
    >
      <circle cx="50" cy="50" r="36" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      {TICKS.map(d => (
        <line
          key={d}
          x1="50"
          y1="14"
          x2="50"
          y2={d % 90 === 0 ? 20 : 17}
          stroke="currentColor"
          strokeOpacity={d % 90 === 0 ? 0.8 : 0.35}
          transform={`rotate(${d} 50 50)`}
        />
      ))}
      {CARDINALS.map(c => (
        <text
          key={c.label}
          x={c.x}
          y={c.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize="8"
          fill="currentColor"
        >
          {c.label}
        </text>
      ))}
      <g transform={`rotate(${toward} 50 50)`} className="text-foreground">
        <line x1="50" y1="75" x2="50" y2="31" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
        <path d="M50 21 L56.5 33 L43.5 33 Z" fill="currentColor" />
        <circle cx="50" cy="75" r="3" fill="var(--surface)" stroke="currentColor" strokeWidth="1.5" />
      </g>
    </svg>
  );
}
