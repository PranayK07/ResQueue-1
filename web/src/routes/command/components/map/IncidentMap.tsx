import 'maplibre-gl/dist/maplibre-gl.css';
import './incident-map.css';
import { CloudOff, MapIcon, MapPinOff, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapGL, {
  AttributionControl,
  NavigationControl,
  type ErrorEvent as MapErrorEvent,
  type MapLayerMouseEvent,
  type MapRef,
  type StyleSpecification,
} from 'react-map-gl/maplibre';
import { toLevel } from '@/lib/domain/levels';
import { gridBounds, hasScenario, toLngLatBounds, type GridGeom, type Position } from '@/lib/geo/grid';
import { useAnchor } from '@/lib/guide';
import type {
  FireCellRow,
  ForecastCellRow,
  GridRow,
  OpsQueueRow,
  OpsRequestRow,
  RoadClosureRow,
  StationRow,
  UnitRow,
} from '@/lib/stdb';
import { EmptyState } from '@/lib/ui/EmptyState';
import { cn } from '@/lib/utils';
import { ClosureHint } from './ClosureHint';
import { ClosurePointMarker } from './ClosurePointMarker';
import { MapLegend } from './MapLegend';
import { MapNote } from './MapNote';
import { maplibregl } from './maplibre';
import { MAP_HEX } from './mapColors';
import { RequestMarker } from './RequestMarker';
import { ScenarioLayers } from './ScenarioLayers';
import { StationMarker } from './StationMarker';
import { UnitMarker } from './UnitMarker';
import { unitOffsets } from './unitOffsets';

export type IncidentMapProps = {
  /** VITE_MAP_STYLE_URL. Undefined draws a plain dark background and says so. */
  styleUrl: string | undefined;
  grid: GridRow | undefined;
  simNow: number | undefined;
  fireCells: readonly FireCellRow[];
  forecastCells: readonly ForecastCellRow[];
  closures: readonly RoadClosureRow[];
  stations: readonly StationRow[];
  units: readonly UnitRow[];
  requests: readonly OpsRequestRow[];
  queue: readonly OpsQueueRow[];
  /** String(request.id) of the open request, or null. */
  selectedId: string | null;
  onSelectRequest: (id: string) => void;
  closureMode: boolean;
  /** Both points are [lon, lat] (GeoJSON order): lat1 = a[1], lon1 = a[0]. */
  onClosurePoints: (a: [number, number], b: [number, number]) => void;
  /** Esc while drawing a closure. The map always drops its first point; leaving closure mode is up to the caller. */
  onClosureCancel?: () => void;
  /** Connection lost or reconnecting: the map grays out and ignores closure clicks. */
  offline?: boolean;
  /** Wall-clock time of the last live data, already formatted ("17:42:10"). Shown while offline. */
  lastUpdate?: string;
  className?: string;
};

/** Forecast bands only rebuild when sim time crosses a step this long. */
const FORECAST_STEP_S = 30;

const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'bg', type: 'background', paint: { 'background-color': MAP_HEX.bg } }],
};

const MAP_STYLE = { position: 'absolute', inset: 0, isolation: 'isolate' } as const;

/**
 * The /command map: forecast bands, burning cells, incident outline and road
 * closures as GeoJSON layers, then station, unit and request markers on top.
 * Presentational: rows in, clicks out through callbacks.
 */
export function IncidentMap({
  styleUrl,
  grid,
  simNow,
  fireCells,
  forecastCells,
  closures,
  stations,
  units,
  requests,
  queue,
  selectedId,
  onSelectRequest,
  closureMode,
  onClosurePoints,
  onClosureCancel,
  offline = false,
  lastUpdate,
  className,
}: IncidentMapProps) {
  const anchor = useAnchor('cmd.map.fire');
  const [map, setMap] = useState<MapRef | null>(null);
  const [pointA, setPointA] = useState<Position | null>(null);
  const [baseMapFailed, setBaseMapFailed] = useState(false);
  const loadedRef = useRef(false);
  const fittedKey = useRef<string | null>(null);

  // Keyed by value, so a fresh grid row with the same geometry doesn't rebuild every layer.
  const geom = useMemo<GridGeom | undefined>(
    () =>
      hasScenario(grid)
        ? { originLat: grid.originLat, originLon: grid.originLon, cellSizeM: grid.cellSizeM, rows: grid.rows, cols: grid.cols }
        : undefined,
    [grid?.originLat, grid?.originLon, grid?.cellSizeM, grid?.rows, grid?.cols]
  );

  // Rounded up, so a band never shows the fire later than it is.
  const simStep = simNow === undefined ? undefined : Math.ceil(simNow / FORECAST_STEP_S) * FORECAST_STEP_S;

  // Fit once per incident area: when the grid first arrives, or if a new scenario moves it.
  useEffect(() => {
    if (!map || !geom) return;
    const bounds = toLngLatBounds(gridBounds(geom));
    const key = bounds.flat().join(',');
    if (fittedKey.current === key) return;
    fittedKey.current = key;
    map.fitBounds(bounds, { padding: 40, duration: 0 });
  }, [map, geom]);

  useEffect(() => {
    if (!closureMode) {
      setPointA(null);
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setPointA(null);
      onClosureCancel?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [closureMode, onClosureCancel]);

  const handleClick = useCallback(
    (e: MapLayerMouseEvent) => {
      if (!closureMode || offline) return;
      const { lng, lat } = e.lngLat.wrap();
      const p: Position = [lng, lat];
      if (!pointA) {
        setPointA(p);
        return;
      }
      if (p[0] === pointA[0] && p[1] === pointA[1]) return;
      setPointA(null);
      onClosurePoints(pointA, p);
    },
    [closureMode, offline, pointA, onClosurePoints]
  );

  const handleLoad = useCallback(() => {
    loadedRef.current = true;
    setBaseMapFailed(false);
  }, []);

  const handleError = useCallback((e: MapErrorEvent) => {
    // Before the first load this is the style itself failing; later errors are usually single tiles.
    if (!loadedRef.current) setBaseMapFailed(true);
    if (import.meta.env.DEV) console.error('Map error:', e.error?.message);
  }, []);

  const offsets = useMemo(() => unitOffsets(units, stations), [units, stations]);

  const pins = useMemo(() => {
    const rankById = new Map(queue.map(q => [String(q.requestId), q.rank] as const));
    return requests
      .filter(r => !r.locationPurged)
      .map(r => {
        const id = String(r.id);
        return { id, lat: r.lat, lon: r.lon, level: toLevel(r.level), rank: rankById.get(id) };
      });
  }, [requests, queue]);

  const noScenario = grid !== undefined && geom === undefined;

  return (
    <div
      {...anchor}
      className={cn('incident-map relative h-full w-full overflow-hidden rounded-frame border border-border bg-background', className)}
    >
      <div className={cn('absolute inset-0', offline && 'opacity-60 grayscale')} aria-busy={grid === undefined}>
        <MapGL
          ref={setMap}
          mapLib={maplibregl}
          mapStyle={styleUrl ?? FALLBACK_STYLE}
          style={MAP_STYLE}
          attributionControl={false}
          dragRotate={false}
          pitchWithRotate={false}
          touchPitch={false}
          cursor={closureMode ? 'crosshair' : undefined}
          onClick={handleClick}
          onLoad={handleLoad}
          onError={handleError}
        >
          <NavigationControl position="top-right" showCompass={false} />
          <AttributionControl position="bottom-right" compact />
          {geom && (
            <ScenarioLayers
              grid={geom}
              simStep={simStep}
              fireCells={fireCells}
              forecastCells={forecastCells}
              closures={closures}
            />
          )}
          {/* Markers wait for the grid too: loading shows the base style only, and without a fit they'd pile up at zoom 0. */}
          {geom && (
            <>
              {stations.map(s => (
                <StationMarker key={s.id} station={s} />
              ))}
              {units.map(u => (
                <UnitMarker key={u.id} unit={u} offset={offsets.get(u.id)} />
              ))}
              {pins.map(p => (
                <RequestMarker
                  key={p.id}
                  id={p.id}
                  lat={p.lat}
                  lon={p.lon}
                  level={p.level}
                  rank={p.rank}
                  selected={p.id === selectedId}
                  interactive={!closureMode}
                  onSelect={onSelectRequest}
                />
              ))}
            </>
          )}
          {closureMode && pointA && <ClosurePointMarker point={pointA} />}
        </MapGL>
      </div>

      <div className="pointer-events-none absolute top-3 left-3 z-10 flex flex-col gap-1.5">
        {!styleUrl && <MapNote icon={MapIcon}>Map style not set (VITE_MAP_STYLE_URL)</MapNote>}
        {styleUrl && baseMapFailed && <MapNote icon={TriangleAlert}>Base map failed to load</MapNote>}
        {offline && <MapNote icon={CloudOff}>{lastUpdate ? `Last update ${lastUpdate}` : 'Not live'}</MapNote>}
      </div>

      {closureMode && !offline && <ClosureHint hasFirstPoint={pointA !== null} />}

      {noScenario && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center p-6">
          <EmptyState
            icon={MapPinOff}
            title="No scenario loaded."
            body={
              <>
                Run <code className="font-mono text-foreground">scripts/dev.sh reset</code>.
              </>
            }
            className="pointer-events-auto rounded-card border border-border bg-surface/90 backdrop-blur-sm"
          />
        </div>
      )}

      {geom && <MapLegend className="absolute bottom-3 left-3 z-10" />}
    </div>
  );
}
