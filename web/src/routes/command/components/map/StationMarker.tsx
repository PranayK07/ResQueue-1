import { memo } from 'react';
import { Marker } from 'react-map-gl/maplibre';
import type { StationRow } from '@/lib/stdb';

type StationMarkerProps = {
  station: StationRow;
};

const LABEL_SHADOW = '[text-shadow:0_1px_2px_rgb(0_0_0/0.9)]';

/** A station: small gray square with its name beside it. Not interactive. */
export const StationMarker = memo(function StationMarker({ station }: StationMarkerProps) {
  return (
    <Marker longitude={station.lon} latitude={station.lat} anchor="center" style={{ zIndex: 1 }}>
      <div role="img" aria-label={`Station ${station.name}`} className="relative size-3 rounded-[3px] border border-black/50 bg-[#8A93A3]">
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 left-full ml-1.5 -translate-y-1/2 text-[11px] leading-4 font-medium whitespace-nowrap text-foreground/80 ${LABEL_SHADOW}`}
        >
          {station.name}
        </span>
      </div>
    </Marker>
  );
});
