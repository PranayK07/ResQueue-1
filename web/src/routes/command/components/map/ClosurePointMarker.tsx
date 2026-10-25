import { Marker } from 'react-map-gl/maplibre';
import type { Position } from '@/lib/geo/grid';

type ClosurePointMarkerProps = {
  /** [lon, lat] of the first closure click. */
  point: Position;
};

/** The first point of a closure being drawn. Clicks pass through to the map. */
export function ClosurePointMarker({ point }: ClosurePointMarkerProps) {
  return (
    <Marker longitude={point[0]} latitude={point[1]} anchor="center" style={{ zIndex: 11, pointerEvents: 'none' }}>
      <span
        role="img"
        aria-label="Closure start point"
        className="block size-3 rounded-full border-2 border-[#FF5533] bg-[#F2F4F7] shadow-[0_0_0_3px_rgb(0_0_0/0.5)]"
      />
    </Marker>
  );
}
