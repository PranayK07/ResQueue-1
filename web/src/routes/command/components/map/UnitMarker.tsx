import { memo } from 'react';
import { Marker } from 'react-map-gl/maplibre';
import { unitStatusLabel } from '@/lib/domain/status';
import type { UnitRow } from '@/lib/stdb';
import { UNIT_HEX, unitTone } from './mapColors';

type UnitMarkerProps = {
  unit: UnitRow;
  /** Pixel nudge so units parked on the same spot (their station) don't hide each other. */
  offset?: [number, number];
};

const LABEL_SHADOW = '[text-shadow:0_1px_2px_rgb(0_0_0/0.9)]';

/** A unit dot colored by status, with its callsign underneath. Not interactive. */
export const UnitMarker = memo(function UnitMarker({ unit, offset }: UnitMarkerProps) {
  const label = `${unit.callsign}, ${unitStatusLabel(unit.status)}`;
  return (
    <Marker longitude={unit.lon} latitude={unit.lat} anchor="center" offset={offset ?? [0, 0]} style={{ zIndex: 2 }}>
      <div
        role="img"
        aria-label={label}
        title={label}
        className="relative size-2.5 rounded-full ring-2 ring-black/70"
        style={{ backgroundColor: UNIT_HEX[unitTone(unit.status)] }}
      >
        <span
          aria-hidden
          className={`pointer-events-none absolute top-full left-1/2 mt-0.5 -translate-x-1/2 font-mono text-[10px] leading-3 whitespace-nowrap text-foreground/75 tabular-nums ${LABEL_SHADOW}`}
        >
          {unit.callsign}
        </span>
      </div>
    </Marker>
  );
});
