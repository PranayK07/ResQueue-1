import type { CSSProperties } from 'react';
import { LEVEL_META, type Level } from '@/lib/domain/levels';
import { cn } from '@/lib/utils';
import { LegendRow } from './LegendRow';
import { LEVEL_ICON } from './levelIcons';
import { BAND_STYLE, FIRE_OPACITY, LEVEL_HEX, MAP_HEX, UNIT_HEX, type UnitTone } from './mapColors';

type MapLegendProps = {
  className?: string;
};

/** A cell fill as drawn on the map, with a solid edge so faint bands stay identifiable. */
const fill = (color: string, opacity: number): CSSProperties => ({
  backgroundColor: `color-mix(in srgb, ${color} ${Math.round(opacity * 100)}%, transparent)`,
  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${color} 60%, transparent)`,
});

const FIRE_ROWS: { label: string; style: CSSProperties }[] = [
  { label: 'Burning now', style: fill(MAP_HEX.fire, FIRE_OPACITY.base + FIRE_OPACITY.perIntensity) },
  { label: 'Fire within 30 min', style: fill(BAND_STYLE.lt30.color, BAND_STYLE.lt30.opacity) },
  { label: 'Fire in 30 to 60 min', style: fill(BAND_STYLE['30to60'].color, BAND_STYLE['30to60'].opacity) },
  { label: 'Fire in over 60 min', style: fill(BAND_STYLE.gt60.color, BAND_STYLE.gt60.opacity) },
];

const LEVEL_ROWS: { level: Level; label: string }[] = [
  { level: 'unreachable', label: 'Unreachable by ground' },
  { level: 'critical', label: LEVEL_META.critical.label },
  { level: 'high', label: LEVEL_META.high.label },
  { level: 'moderate', label: LEVEL_META.moderate.label },
  { level: 'unknown', label: LEVEL_META.unknown.label },
];

const UNIT_ROWS: { tone: UnitTone; label: string }[] = [
  { tone: 'available', label: 'Available' },
  { tone: 'committed', label: 'Committed' },
  { tone: 'idle', label: 'Returning or out of service' },
];

/** Map key, bottom-left. Every color on the map has words next to it. */
export function MapLegend({ className }: MapLegendProps) {
  return (
    <section
      aria-label="Map legend"
      className={cn(
        'pointer-events-auto w-[340px] rounded-card border border-border bg-surface/90 p-3 text-[11px] leading-4 text-foreground/85 shadow-lg backdrop-blur-sm',
        className
      )}
    >
      <div className="grid grid-cols-2 gap-x-4">
        <div>
          <h3 className="label-caps mb-1.5">Fire</h3>
          <ul className="flex flex-col gap-1">
            {FIRE_ROWS.map(r => (
              <LegendRow key={r.label} swatch={<span className="block size-3 rounded-[2px]" style={r.style} />}>
                {r.label}
              </LegendRow>
            ))}
            <LegendRow
              swatch={
                <span
                  className="block h-[3px] w-3.5"
                  style={{ backgroundImage: `linear-gradient(to right, ${MAP_HEX.fire} 60%, transparent 60%)`, backgroundSize: '6px 3px' }}
                />
              }
            >
              Road closure
            </LegendRow>
          </ul>
        </div>
        <div>
          <h3 className="label-caps mb-1.5">Requests</h3>
          <ul className="flex flex-col gap-1">
            {LEVEL_ROWS.map(({ level, label }) => {
              const Icon = LEVEL_ICON[level];
              return (
                <LegendRow
                  key={level}
                  swatch={
                    <span
                      className="flex size-3.5 items-center justify-center rounded-full text-[#050607]"
                      style={{ backgroundColor: LEVEL_HEX[level] }}
                    >
                      <Icon className="size-2.5" strokeWidth={2.75} />
                    </span>
                  }
                >
                  {label}
                </LegendRow>
              );
            })}
          </ul>
        </div>
      </div>
      <div className="mt-2.5 border-t border-border pt-2">
        <h3 className="label-caps mb-1.5">Units</h3>
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {UNIT_ROWS.map(r => (
            <LegendRow
              key={r.tone}
              swatch={<span className="block size-2.5 rounded-full ring-2 ring-black/70" style={{ backgroundColor: UNIT_HEX[r.tone] }} />}
            >
              {r.label}
            </LegendRow>
          ))}
        </ul>
      </div>
      <p className="mt-2 text-muted-foreground">Pins show their place in line. An icon means not queued yet.</p>
    </section>
  );
}
