import { memo } from 'react';
import { Marker } from 'react-map-gl/maplibre';
import { LEVEL_META, LEVEL_SEVERITY, type Level } from '@/lib/domain/levels';
import { cn } from '@/lib/utils';
import { LEVEL_ICON } from './levelIcons';
import { LEVEL_HEX } from './mapColors';

type RequestMarkerProps = {
  /** String(request.id); u64 ids never go through Number(). */
  id: string;
  lat: number;
  lon: number;
  level: Level;
  /** Place in its station's line, undefined while not queued. */
  rank: number | undefined;
  selected: boolean;
  /** False in closure mode, so clicks fall through to the map. */
  interactive: boolean;
  onSelect: (id: string) => void;
};

/**
 * A request pin: a circle in the level color holding its rank, or the level
 * icon while it isn't queued. The accessible name carries the level label.
 */
export const RequestMarker = memo(function RequestMarker({
  id,
  lat,
  lon,
  level,
  rank,
  selected,
  interactive,
  onSelect,
}: RequestMarkerProps) {
  const meta = LEVEL_META[level];
  const Icon = LEVEL_ICON[level];
  const label = `Request #${id}, ${meta.label}, ${rank === undefined ? 'not queued' : `number ${rank} in line`}`;
  return (
    <Marker
      longitude={lon}
      latitude={lat}
      anchor="center"
      // Above stations (1) and units (2); more urgent pins stack on top, the selected one above all.
      style={{ zIndex: selected ? 10 : 7 - LEVEL_SEVERITY[level], pointerEvents: interactive ? 'auto' : 'none' }}
      onClick={e => {
        // Native listener on the marker element: stopping here keeps the map's own click handler out of it.
        e.originalEvent.stopPropagation();
        if (interactive) onSelect(id);
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-pressed={selected}
        title={label}
        tabIndex={interactive ? 0 : -1}
        data-level={level}
        className={cn(
          'flex size-[22px] cursor-pointer items-center justify-center rounded-full font-mono text-[11px] leading-none font-semibold text-[#050607] tabular-nums',
          'shadow-[0_1px_3px_rgb(0_0_0/0.6)] ring-1 ring-black/50',
          'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-guide',
          selected && 'ring-2 ring-white'
        )}
        style={{ backgroundColor: LEVEL_HEX[level] }}
      >
        {rank === undefined ? <Icon className="size-3" strokeWidth={2.5} aria-hidden /> : rank}
      </button>
    </Marker>
  );
});
