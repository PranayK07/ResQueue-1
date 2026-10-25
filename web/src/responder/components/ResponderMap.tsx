import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import type { FeatureCollection } from 'geojson';
import { useEffect, useMemo, useRef, useState } from 'react';
import circleX from '../../assets/figma/responder/circle-x.svg';
import destinationHalo from '../../assets/figma/responder/destination-halo.svg';
import destinationMarker from '../../assets/figma/responder/destination-marker.svg';
import dottedSample from '../../assets/figma/responder/dotted-route-sample.svg';
import maximize from '../../assets/figma/responder/maximize.svg';
import minimize from '../../assets/figma/responder/minimize.svg';
import unitMarker from '../../assets/figma/responder/unit-marker.svg';
import {
  cellsOutline,
  cellsToPolygons,
  centroid,
  clockHM,
  etaMinutes,
  forecastArea,
  requestCode,
  routeExposure,
  simToMs,
  nearestCellPoint,
  type QueueItem,
} from '../../ops/derive';
import type { Route } from '../../ops/routing';
import type { ResponderSnapshot, Unit } from '../../ops/types';
import './ResponderMap.css';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
/** The p10 boundary drawn on the map: where fire could be within this window. */
const FORECAST_WINDOW_S = 40 * 60;

type LngLat = [number, number];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

interface Props {
  snapshot: ResponderSnapshot;
  nowS: number;
  /** Request whose route is shown (selected, else the active mission). */
  focus: QueueItem | null;
  /** Unit the route starts from. */
  unit: Unit | null;
  route: Route | null;
  expanded: boolean;
  onToggleExpanded: () => void;
}

function labelEl(className: string, html: string) {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = html;
  return el;
}

export function ResponderMap({ snapshot, nowS, focus, unit, route, expanded, onToggleExpanded }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const [ready, setReady] = useState(false);

  // ─── Map lifecycle ───
  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: [snapshot.station.lon, snapshot.station.lat],
      zoom: 13,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 60, unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      // Tint the stock dark style toward the design's forest-at-night palette.
      const tint: [string, 'background-color' | 'fill-color', string][] = [
        ['background', 'background-color', '#182522'],
        ['landcover_wood', 'fill-color', '#1f2f2a'],
        ['landuse_park', 'fill-color', '#1f2f2a'],
        ['water', 'fill-color', '#1b2a33'],
      ];
      for (const [id, prop, value] of tint) if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');

      for (const id of ['fire', 'fire-edge', 'forecast', 'closures', 'route']) map.addSource(id, { type: 'geojson', data: EMPTY });
      // No antialiasing: adjacent cells would otherwise show hairline seams.
      map.addLayer({
        id: 'fire-fill',
        type: 'fill',
        source: 'fire',
        paint: { 'fill-color': '#7a3a31', 'fill-opacity': 0.55, 'fill-antialias': false },
      });
      map.addLayer({ id: 'fire-line', type: 'line', source: 'fire-edge', paint: { 'line-color': '#ff958a', 'line-width': 1.5 } });
      map.addLayer({
        id: 'forecast-line',
        type: 'line',
        source: 'forecast',
        paint: { 'line-color': '#f0be73', 'line-width': 1.5, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'closure-line',
        type: 'line',
        source: 'closures',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': '#ff958a', 'line-width': 3, 'line-dasharray': [0.1, 2] },
      });
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#0b0f12', 'line-width': 8 },
      });
      map.addLayer({
        id: 'route-lower',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'exposure'], 'lower'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#a7cee5', 'line-width': 4 },
      });
      map.addLayer({
        id: 'route-elevated',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'exposure'], 'elevated'],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#f0be73', 'line-width': 4, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'route-highest',
        type: 'line',
        source: 'route',
        filter: ['==', ['get', 'exposure'], 'highest'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#ff958a', 'line-width': 4, 'line-dasharray': [0.1, 1.8] },
      });
      setReady(true);
    });

    // The pane changes width when expanded; keep the canvas in sync.
    const ro = new ResizeObserver(() => map.resize());
    ro.observe(containerRef.current!);

    mapRef.current = map;
    const markers = markersRef.current;
    return () => {
      ro.disconnect();
      Object.values(markers).forEach(m => m.remove());
      map.remove();
      mapRef.current = null;
    };
    // The station only sets the initial view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── Derived geometry ───
  const { fireCells, forecastCells, grid, closures, clock } = snapshot;
  const fireIds = useMemo(() => new Set(fireCells.map(c => c.cellId)), [fireCells]);
  const forecastIds = useMemo(
    () => forecastArea(fireCells, forecastCells, clock.simS + FORECAST_WINDOW_S),
    [fireCells, forecastCells, clock.simS]
  );
  const runs = useMemo(
    () =>
      route && focus && unit
        ? routeExposure(route.coords, clock.simS, focus.etaS, grid, fireCells, forecastCells)
        : [],
    [route, focus, unit, clock.simS, grid, fireCells, forecastCells]
  );

  // ─── Push data into sources ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    (map.getSource('fire') as maplibregl.GeoJSONSource).setData(cellsToPolygons(grid, fireIds));
    (map.getSource('fire-edge') as maplibregl.GeoJSONSource).setData(cellsOutline(grid, fireIds));
    (map.getSource('forecast') as maplibregl.GeoJSONSource).setData(cellsOutline(grid, forecastIds));
    (map.getSource('closures') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: closures
        .filter(c => c.active)
        .map(c => ({
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: [[c.lon1, c.lat1], [c.lon2, c.lat2]] },
        })),
    });
    (map.getSource('route') as maplibregl.GeoJSONSource).setData({
      type: 'FeatureCollection',
      features: runs.map(r => ({
        type: 'Feature',
        properties: { exposure: r.exposure },
        geometry: { type: 'LineString', coordinates: r.coords },
      })),
    });
  }, [ready, grid, fireIds, forecastIds, closures, runs]);

  // ─── HTML labels (markers) ───
  // Label the forecast edge where it matters: nearest the destination.
  const focusLon = focus?.request.lon;
  const focusLat = focus?.request.lat;
  const forecastLabelAt = useMemo(
    () => (focusLon === undefined || focusLat === undefined ? null : nearestCellPoint(grid, forecastIds, [focusLon, focusLat])),
    [grid, forecastIds, focusLon, focusLat]
  );
  const fireLabelAt = useMemo(() => centroid(grid, fireIds), [grid, fireIds]);
  const forecastTime = clockHM(simToMs(clock, clock.simS + FORECAST_WINDOW_S));
  // On short routes the road name would sit on the destination; the footer already names it.
  const viaAt = route?.via && route.distanceM > 3500 ? route.coords[Math.floor(route.coords.length / 2)] : null;

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    const want: Record<string, { at: LngLat; make: () => maplibregl.Marker; html?: string } | null> = {
      unit: unit && {
        at: [unit.lon, unit.lat],
        html: `<img src="${unitMarker}" width="14" height="14" alt="" /><span class="map-tag map-tag--unit">${unit.callsign} · ${snapshot.station.name}</span>`,
        make: () => new maplibregl.Marker({ element: labelEl('unit-pin', ''), anchor: 'center' }),
      },
      destination: focus && {
        at: [focus.request.lon, focus.request.lat],
        html: `<img class="dest-pin__halo" src="${destinationHalo}" width="30" height="30" alt="" /><img class="dest-pin__dot" src="${destinationMarker}" width="12" height="12" alt="" /><span class="map-tag map-tag--dest">${requestCode(focus.request.id)}</span>`,
        make: () => new maplibregl.Marker({ element: labelEl('dest-pin', ''), anchor: 'center' }),
      },
      fire: fireLabelAt && {
        at: fireLabelAt,
        html: 'FIRE',
        make: () => new maplibregl.Marker({ element: labelEl('map-text map-text--fire', ''), anchor: 'center' }),
      },
      forecast: forecastLabelAt && {
        at: forecastLabelAt,
        html: `p10 · ${forecastTime}`,
        make: () => new maplibregl.Marker({ element: labelEl('map-tag map-tag--forecast', ''), anchor: 'bottom', offset: [0, -10] }),
      },
      via: viaAt && {
        at: viaAt,
        html: route!.via,
        make: () => new maplibregl.Marker({ element: labelEl('map-text', ''), anchor: 'left', offset: [10, 0] }),
      },
    };
    closures
      .filter(c => c.active)
      .forEach(c => {
        want[`closure-${c.id}`] = {
          at: [(c.lon1 + c.lon2) / 2, (c.lat1 + c.lat2) / 2],
          html: `<img src="${circleX}" width="13" height="13" alt="" />${c.name} closed`,
          make: () => new maplibregl.Marker({ element: labelEl('map-tag map-tag--closure', ''), anchor: 'left', offset: [8, 0] }),
        };
      });

    for (const key of Object.keys(markers)) {
      if (!want[key]) {
        markers[key].remove();
        delete markers[key];
      }
    }
    for (const [key, spec] of Object.entries(want)) {
      if (!spec) continue;
      const m = (markers[key] ??= spec.make().setLngLat(spec.at).addTo(map));
      m.setLngLat(spec.at);
      if (spec.html !== undefined && m.getElement().innerHTML !== spec.html) m.getElement().innerHTML = spec.html;
    }
  }, [ready, unit, focus, fireLabelAt, forecastLabelAt, forecastTime, viaAt, route, closures, snapshot.station.name]);

  // ─── Frame unit + destination when the focus changes ───
  const focusId = focus ? String(focus.request.id) : '';
  const routeKey = route ? route.coords.length : 0;
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !focus) return;
    const pts: LngLat[] = [[focus.request.lon, focus.request.lat], ...(unit ? [[unit.lon, unit.lat] as LngLat] : []), ...(route?.coords ?? [])];
    const bounds = pts.reduce((b, p) => b.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(bounds, { padding: { top: 140, bottom: 120, left: 40, right: 40 }, maxZoom: 15, duration: 600 });
    // Re-frame on focus/route/layout change only, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focusId, routeKey, expanded]);

  const eta = focus ? etaMinutes(focus.etaS, nowS) : null;

  return (
    <div className={expanded ? 'rmap rmap--expanded' : 'rmap'}>
      <div ref={containerRef} className="rmap__canvas" />

      <button type="button" className="rmap__size" onClick={onToggleExpanded}>
        <img src={expanded ? minimize : maximize} width={16} height={16} alt="" />
        {expanded ? 'Back to split view' : 'Expand map'}
      </button>

      {focus && (
        <div className="rmap__estimate">
          <p className="rmap__estimate-title">
            {requestCode(focus.request.id)} · ETA {eta} min
          </p>
          <p className="rmap__estimate-sub">Arrival {clockHM(simToMs(clock, focus.etaS))} · advisory</p>
        </div>
      )}

      <div className="rmap__footer">
        {expanded ? (
          <div className="rmap__key">
            <span className="rmap__key-item rmap__key-item--lower">
              <i className="rmap__swatch rmap__swatch--solid" /> Lower
            </span>
            <span className="rmap__key-item rmap__key-item--elevated">
              <i className="rmap__swatch rmap__swatch--dashed">
                <i />
                <i />
              </i>
              Elevated
            </span>
            <span className="rmap__key-item rmap__key-item--highest">
              <img src={dottedSample} width={15} height={3} alt="" /> Highest
            </span>
          </div>
        ) : (
          <p className="rmap__footer-title">{route?.via ? `Via ${route.via} · verify access` : 'Verify access'}</p>
        )}
        <p className="rmap__footer-note">
          {expanded ? (
            <>
              Simulated route exposure · decision support only.
              <br />
              Verify access. Not for navigation or real dispatch.
            </>
          ) : (
            <>
              Simulated · advisory only
              <br />
              Not for navigation
            </>
          )}
        </p>
      </div>
    </div>
  );
}
