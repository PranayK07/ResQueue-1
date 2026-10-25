import 'maplibre-gl/dist/maplibre-gl.css';
import type { FeatureCollection, Polygon } from 'geojson';
import type { StyleSpecification } from 'maplibre-gl';
import { useEffect, useMemo, useRef } from 'react';
import { Layer, Map as MapView, Marker, Source, type MapRef } from 'react-map-gl/maplibre';
import { LEVEL_META, toLevel } from '@/lib/domain/levels';
import { hasScenario } from '@/lib/geo/grid';
import { closuresLayer, fireLayer } from '@/lib/geo/layers';
import type { FireCellRow, GridRow, OpsRequestRow, RoadClosureRow, UnitRow } from '@/lib/stdb';
import { cn } from '@/lib/utils';

// MapLibre paint can't read CSS variables, so the map layers use the token hex values.
const FIRE_HEX = '#FF5533';
const CLOSURE_HEX = '#FF5533';

/** Used when VITE_MAP_STYLE_URL isn't set: just the page background. */
const BLANK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#050607' } }],
};

const FIT = { padding: 36, maxZoom: 14 };

/** Keeps the fire source mounted before a scenario loads, so its layer stays under the closures. */
const NO_FIRE: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] };

type LngLat = [number, number];

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export type MiniMapProps = {
  /** VITE_MAP_STYLE_URL, or undefined for a blank dark map. */
  styleUrl: string | undefined;
  grid: GridRow | undefined;
  fireCells: readonly FireCellRow[];
  /** All closures; only active ones are drawn. */
  closures: readonly RoadClosureRow[];
  unit: Pick<UnitRow, 'lat' | 'lon' | 'callsign'>;
  /** The request pin is skipped when its location was purged. */
  request: Pick<OpsRequestRow, 'lat' | 'lon' | 'level' | 'locationPurged'>;
  className?: string;
};

/** Small, non-interactive map: this unit, the request, burning cells and active closures. */
export function MiniMap({ styleUrl, grid, fireCells, closures, unit, request, className }: MiniMapProps) {
  const mapRef = useRef<MapRef>(null);
  const showRequest = !request.locationPurged;

  const fire = useMemo(() => (hasScenario(grid) ? fireLayer(fireCells, grid) : NO_FIRE), [fireCells, grid]);
  const closureData = useMemo(() => closuresLayer(closures), [closures]);

  // Fit both points; with the location purged, center on the unit alone.
  const { lat: uLat, lon: uLon } = unit;
  const rLat = showRequest ? request.lat : uLat;
  const rLon = showRequest ? request.lon : uLon;
  const bounds = useMemo<[LngLat, LngLat]>(
    () => [
      [Math.min(uLon, rLon), Math.min(uLat, rLat)],
      [Math.max(uLon, rLon), Math.max(uLat, rLat)],
    ],
    [uLat, uLon, rLat, rLon]
  );

  // The first fit comes from initialViewState; refit whenever a point moves.
  useEffect(() => {
    mapRef.current?.fitBounds(bounds, { ...FIT, duration: prefersReducedMotion() ? 0 : 200 });
  }, [bounds]);

  return (
    <figure className={cn('relative h-44 overflow-hidden rounded-card border border-border bg-background', className)}>
      <figcaption className="sr-only">
        Map of {unit.callsign}, the request location, burning cells and road closures.
      </figcaption>
      <MapView
        ref={mapRef}
        initialViewState={{ bounds, fitBoundsOptions: FIT }}
        mapStyle={styleUrl ?? BLANK_STYLE}
        interactive={false}
        attributionControl={{ compact: true }}
        style={{ width: '100%', height: '100%' }}
      >
        <Source id="crew-fire" type="geojson" data={fire}>
          <Layer id="crew-fire-fill" type="fill" paint={{ 'fill-color': FIRE_HEX, 'fill-opacity': 0.45 }} />
        </Source>
        <Source id="crew-closures" type="geojson" data={closureData}>
          <Layer
            id="crew-closures-line"
            type="line"
            paint={{ 'line-color': CLOSURE_HEX, 'line-width': 2, 'line-dasharray': [2, 1.5] }}
          />
        </Source>
        <Marker longitude={unit.lon} latitude={unit.lat}>
          <span
            title={unit.callsign}
            className="block size-3 rounded-full bg-foreground ring-2 ring-background"
            aria-hidden
          />
        </Marker>
        {showRequest && (
          <Marker longitude={request.lon} latitude={request.lat}>
            <span
              className="block size-3.5 rounded-full ring-2 ring-background"
              style={{ backgroundColor: LEVEL_META[toLevel(request.level)].color }}
              aria-hidden
            />
          </Marker>
        )}
      </MapView>
    </figure>
  );
}
