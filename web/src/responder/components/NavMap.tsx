import type { FeatureCollection } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import circleX from '../../assets/figma/responder/circle-x.svg';
import destinationHalo from '../../assets/figma/responder/destination-halo.svg';
import destinationMarker from '../../assets/figma/responder/destination-marker.svg';
import unitMarker from '../../assets/figma/responder/unit-marker.svg';
import {
  cellsOutline,
  cellsToPolygons,
  centroid,
  clockHM,
  forecastArea,
  nearestCellPoint,
  requestCode,
  routeExposure,
  simToMs,
  type QueueItem,
} from '../../ops/derive';
import type { Route } from '../../ops/routing';
import type { ResponderSnapshot } from '../../ops/types';
import './NavMap.css';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
/** The p10 boundary drawn on the map: where fire could be within this window. */
const FORECAST_WINDOW_S = 40 * 60;
const FOLLOW_ZOOM = 14.5;

type LngLat = [number, number];
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

interface Props {
  snapshot: ResponderSnapshot;
  /** Where the route goes. */
  target: QueueItem | null;
  route: Route | null;
  /** Vehicle position (unit row or this phone's GPS). */
  position: LngLat | null;
  positionLabel: string;
  /** True when the position comes from the phone's GPS. */
  gps: boolean;
  /** This unit's later stops, numbered on the map. */
  laterStops: QueueItem[];
  follow: boolean;
  onUserMove: () => void;
  /** Space covered by the top bars and the bottom sheet. */
  padding: { top: number; bottom: number };
}

function el(className: string, html: string) {
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = html;
  return div;
}

/** Full-screen map behind the bars and the directions sheet. */
export function NavMap({ snapshot, target, route, position, positionLabel, gps, laterStops, follow, onUserMove, padding }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const onUserMoveRef = useRef(onUserMove);
  useEffect(() => {
    onUserMoveRef.current = onUserMove;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: [snapshot.station.lon, snapshot.station.lat],
      zoom: 13,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 70, unit: 'imperial' }), 'top-left');
    map.on('load', () => {
      const tint: [string, 'background-color' | 'fill-color', string][] = [
        ['background', 'background-color', '#182522'],
        ['landcover_wood', 'fill-color', '#1f2f2a'],
        ['landuse_park', 'fill-color', '#1f2f2a'],
        ['water', 'fill-color', '#1b2a33'],
      ];
      for (const [id, prop, value] of tint) if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      for (const id of ['fire', 'fire-edge', 'forecast', 'closures', 'route']) map.addSource(id, { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'fire-fill', type: 'fill', source: 'fire', paint: { 'fill-color': '#7a3a31', 'fill-opacity': 0.55, 'fill-antialias': false } });
      map.addLayer({ id: 'fire-line', type: 'line', source: 'fire-edge', paint: { 'line-color': '#ff958a', 'line-width': 1.5 } });
      map.addLayer({ id: 'forecast-line', type: 'line', source: 'forecast', paint: { 'line-color': '#f0be73', 'line-width': 1.5, 'line-dasharray': [2, 2] } });
      map.addLayer({ id: 'closure-line', type: 'line', source: 'closures', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#ff958a', 'line-width': 3, 'line-dasharray': [0.1, 2] } });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#0b0f12', 'line-width': 9 } });
      map.addLayer({ id: 'route-lower', type: 'line', source: 'route', filter: ['==', ['get', 'exposure'], 'lower'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#a7cee5', 'line-width': 5 } });
      map.addLayer({ id: 'route-elevated', type: 'line', source: 'route', filter: ['==', ['get', 'exposure'], 'elevated'], layout: { 'line-join': 'round' }, paint: { 'line-color': '#f0be73', 'line-width': 5, 'line-dasharray': [2, 1.5] } });
      map.addLayer({ id: 'route-highest', type: 'line', source: 'route', filter: ['==', ['get', 'exposure'], 'highest'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ff958a', 'line-width': 5, 'line-dasharray': [0.1, 1.8] } });
      setReady(true);
    });
    // A drag or pinch means the crew is looking around: stop following.
    map.on('dragstart', () => onUserMoveRef.current());
    map.on('zoomstart', e => {
      if ((e as { originalEvent?: Event }).originalEvent) onUserMoveRef.current();
    });
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

  // ─── Geometry ───
  const { fireCells, forecastCells, grid, closures, clock } = snapshot;
  const fireIds = useMemo(() => new Set(fireCells.map(c => c.cellId)), [fireCells]);
  const forecastIds = useMemo(() => forecastArea(fireCells, forecastCells, clock.simS + FORECAST_WINDOW_S), [fireCells, forecastCells, clock.simS]);
  const runs = useMemo(
    () => (route && target ? routeExposure(route.coords, clock.simS, Math.max(clock.simS + 60, target.etaS), grid, fireCells, forecastCells) : []),
    [route, target, clock.simS, grid, fireCells, forecastCells]
  );

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (id: string, data: Parameters<maplibregl.GeoJSONSource['setData']>[0]) => (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    set('fire', cellsToPolygons(grid, fireIds));
    set('fire-edge', cellsOutline(grid, fireIds));
    set('forecast', cellsOutline(grid, forecastIds));
    set('closures', {
      type: 'FeatureCollection',
      features: closures.filter(c => c.active).map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[c.lon1, c.lat1], [c.lon2, c.lat2]] } })),
    });
    set('route', {
      type: 'FeatureCollection',
      features: runs.map(r => ({ type: 'Feature', properties: { exposure: r.exposure }, geometry: { type: 'LineString', coordinates: r.coords } })),
    });
  }, [ready, grid, fireIds, forecastIds, closures, runs]);

  // ─── Markers ───
  const forecastLabelAt = useMemo(
    () => (target ? nearestCellPoint(grid, forecastIds, [target.request.lon, target.request.lat]) : null),
    [grid, forecastIds, target]
  );
  const fireLabelAt = useMemo(() => centroid(grid, fireIds), [grid, fireIds]);
  const forecastTime = clockHM(simToMs(clock, clock.simS + FORECAST_WINDOW_S));

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    type Spec = { at: LngLat; html: string; className: string; anchor: maplibregl.PositionAnchor; offset?: [number, number] };
    const want: Record<string, Spec> = {};
    if (position) {
      want.me = gps
        ? { at: position, html: '<span class="nav-gps__dot"></span>', className: 'nav-gps', anchor: 'center' }
        : { at: position, html: `<img src="${unitMarker}" width="16" height="16" alt="" /><span class="nav-tag nav-tag--unit">${positionLabel}</span>`, className: 'nav-unit', anchor: 'center' };
    }
    if (target) {
      want.dest = {
        at: [target.request.lon, target.request.lat],
        html: `<img class="nav-dest__halo" src="${destinationHalo}" width="30" height="30" alt="" /><img class="nav-dest__dot" src="${destinationMarker}" width="12" height="12" alt="" /><span class="nav-tag nav-tag--dest">${requestCode(target.request.id)}</span>`,
        className: 'nav-dest',
        anchor: 'center',
      };
    }
    laterStops.forEach((s, i) => {
      want[`stop-${s.request.id}`] = {
        at: [s.request.lon, s.request.lat],
        html: `<span class="nav-stop__n">${i + 2}</span>${requestCode(s.request.id)}`,
        className: 'nav-stop',
        anchor: 'left',
        offset: [-9, 0],
      };
    });
    if (fireLabelAt) want.fire = { at: fireLabelAt, html: 'FIRE', className: 'nav-text nav-text--fire', anchor: 'center' };
    if (forecastLabelAt) want.forecast = { at: forecastLabelAt, html: `p10 · ${forecastTime}`, className: 'nav-tag nav-tag--forecast', anchor: 'bottom', offset: [0, -10] };
    for (const c of closures.filter(x => x.active)) {
      want[`closure-${c.id}`] = {
        at: [(c.lon1 + c.lon2) / 2, (c.lat1 + c.lat2) / 2],
        html: `<img src="${circleX}" width="13" height="13" alt="" />${c.name} closed`,
        className: 'nav-tag nav-tag--closure',
        anchor: 'left',
        offset: [8, 0],
      };
    }
    for (const key of Object.keys(markers)) {
      if (!want[key]) {
        markers[key].remove();
        delete markers[key];
      }
    }
    for (const [key, spec] of Object.entries(want)) {
      let m = markers[key];
      if (!m || !m.getElement().classList.contains(spec.className.split(' ')[0])) {
        m?.remove();
        m = markers[key] = new maplibregl.Marker({ element: el(spec.className, spec.html), anchor: spec.anchor, offset: spec.offset }).setLngLat(spec.at).addTo(map);
      }
      m.setLngLat(spec.at);
      if (m.getElement().innerHTML !== spec.html) m.getElement().innerHTML = spec.html;
    }
  }, [ready, position, positionLabel, gps, target, laterStops, fireLabelAt, forecastLabelAt, forecastTime, closures]);

  // ─── Camera ───
  useEffect(() => {
    mapRef.current?.setPadding({ top: padding.top + 16, bottom: padding.bottom + 16, left: 24, right: 24 });
  }, [padding.top, padding.bottom]);

  // Following: keep the vehicle in view as it moves.
  const posKey = position ? position.map(v => v.toFixed(5)).join(',') : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !follow || !position) return;
    map.easeTo({ center: position, zoom: Math.max(map.getZoom(), FOLLOW_ZOOM), duration: 800 });
    // posKey captures position changes; position itself is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, follow, posKey]);

  // Not following: show the whole trip when it changes.
  const routeKey = route ? `${route.coords.length}:${route.distanceM}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || follow || !route) return;
    const pts = [...route.coords, ...(position ? [position] : [])];
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { maxZoom: 16, duration: 600 });
    // Re-frame only on a new route (or when following stops), not on every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, routeKey, follow]);

  return <div ref={containerRef} className="nav-map" />;
}
