import { vehiclePositionAt, vehicleStatus } from '../../ops/vehicleMotion';
import { simNow } from '../../ops/derive';
import type { FeatureCollection } from 'geojson';
import { alertMarker, truckMarker, spreadAlerts } from '../../components/mapMarkers';
import { satelliteStyle } from '../../lib/mapStyle';
import { EXPOSURE_COLOR, learnedConcern } from '../../ops/learnedForecast';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import arrowDownRight from '../../assets/figma/command/arrow-down-right.svg';
import warehouse from '../../assets/figma/command/warehouse.svg';
import { cellsOutline, cellsToPolygons, centroid, clockHM, forecastArea, nearestCellPoint, requestCode, simToMs } from '../../ops/derive';
import type { Route } from '../../ops/routing';
import type { CommandSnapshot, Unit } from '../../ops/types';
import { compass, mph, stationShort, type CommandRow } from '../derive';
import { FORECAST_WINDOW_S, type LayerName } from '../mapLayers';
import './CommandMap.css';

maplibregl.setWorkerUrl(workerUrl);

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
type LngLat = [number, number];

const LEVEL_COLOR = ['match', ['get', 'level'], 'unreachable', '#20282d', 'critical', '#b33b32', 'high', '#b86d12', 'moderate', '#79816f', 'low', '#347b58', '#a5b0b5'];

/** A unit's route: from where it is now, through each stop in order. */
export interface Journey {
  unit: Unit;
  stops: { row: CommandRow; current: boolean }[];
  /** Road geometry per leg; null while loading. */
  legs: LngLat[][] | null;
}

interface Props {
  horizon: number;
  snapshot: CommandSnapshot;
  rows: CommandRow[];
  selected: CommandRow | null;
  /** Requests to label on the map (the visible table page). */
  labeled: Set<bigint>;
  route: Route | null;
  visible: Set<LayerName>;
  /** Bump to re-frame the whole incident. */
  fitSignal: number;
  /** When set, the map shows this unit's journey instead of the selected request's route. */
  journey: Journey | null;
  onSelect: (id: bigint) => void;
}

function el(className: string, html: string) {
  const div = document.createElement('div');
  div.className = className;
  div.innerHTML = html;
  return div;
}

export function CommandMap({ snapshot, rows, selected, labeled, route, visible, fitSignal, journey, onSelect, horizon }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: satelliteStyle,
      center: [-121.59, 39.78],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.on('moveend', () => spreadAlerts(map, markersRef.current));
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    map.on('load', () => {
      for (const [id, prop, value] of [
        ['background', 'background-color', '#e9ebdd'],
        ['landcover_wood', 'fill-color', '#dfe5d1'],
        ['landuse_park', 'fill-color', '#dfe5d1'],
      ] as [string, 'background-color' | 'fill-color', string][]) {
        if (map.getLayer(id)) map.setPaintProperty(id, prop, value);
      }
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      for (const id of ['forecast', 'forecast-edge', 'fire', 'fire-edge', 'closures', 'route', 'journey', 'requests']) map.addSource(id, { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'forecast-fill', type: 'fill', source: 'forecast', paint: { 'fill-color': EXPOSURE_COLOR as unknown as string, 'fill-opacity': 0.72, 'fill-antialias': false } });
      map.addLayer({ id: 'forecast-line', type: 'line', source: 'forecast-edge', paint: { 'line-color': '#b86d12', 'line-width': 1.2, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'fire-fill', type: 'fill', source: 'fire', paint: { 'fill-color': '#ec2917', 'fill-opacity': 0.85, 'fill-antialias': false } });
      map.addLayer({ id: 'fire-line', type: 'line', source: 'fire-edge', paint: { 'line-color': '#a9160b', 'line-width': 1.6 } });
      map.addLayer({ id: 'closure-casing', type: 'line', source: 'closures', paint: { 'line-color': '#fff', 'line-width': 6 } });
      map.addLayer({ id: 'closure-line', type: 'line', source: 'closures', paint: { 'line-color': '#c61e2e', 'line-width': 6, 'line-dasharray': [1.5, 1.5] } });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#2d5b73', 'line-width': 4 } });
      map.addLayer({ id: 'journey-casing', type: 'line', source: 'journey', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7 } });
      map.addLayer({
        id: 'journey-current',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'current'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#2d5b73', 'line-width': 4 },
      });
      map.addLayer({
        id: 'journey-planned',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'current'], false],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#3b6c84', 'line-width': 3, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({
        id: 'request-dots',
        type: 'circle',
        source: 'requests',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 7, 5],
          'circle-color': LEVEL_COLOR as unknown as string,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-opacity': 0,
          'circle-stroke-opacity': 0,
        },
      });
      map.on('click', 'request-dots', e => {
        const id = e.features?.[0]?.properties?.id;
        if (id !== undefined) onSelectRef.current(BigInt(id));
      });
      map.on('mouseenter', 'request-dots', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'request-dots', () => (map.getCanvas().style.cursor = ''));
      setReady(true);
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
  }, []);

  const { grid, fireCells, forecastCells, closures, clock } = snapshot;
  const fireIds = useMemo(() => new Set(fireCells.map(c => c.cellId)), [fireCells]);
  const forecastIds = useMemo(() => forecastArea(fireCells, forecastCells, clock.simS + FORECAST_WINDOW_S), [fireCells, forecastCells, clock.simS]);
  const modelLayer = snapshot.live?.riskPipeline?.status === 'ready' ? snapshot.live.fireRisk : null;
  const concern = useMemo(() => learnedConcern(modelLayer, horizon), [modelLayer, horizon]);

  // ─── Data ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (id: string, data: FeatureCollection | GeoJSON.Feature) => (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    set('fire', cellsToPolygons(grid, fireIds));
    set('fire-edge', cellsOutline(grid, fireIds));
    set('forecast', concern);
    set('forecast-edge', EMPTY);
    set('closures', {
      type: 'FeatureCollection',
      features: closures.filter(c => c.active).map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[c.lon1, c.lat1], [c.lon2, c.lat2]] } })),
    });
    set('requests', {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature',
        properties: { id: String(r.request.id), level: r.escalated ? 'unreachable' : r.request.level, selected: r === selected },
        geometry: { type: 'Point', coordinates: [r.request.lon, r.request.lat] },
      })),
    });
    set('route', route && !journey ? { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.coords } } : EMPTY);
    set('journey', {
      type: 'FeatureCollection',
      features: (journey?.legs ?? []).map((coords, i) => ({
        type: 'Feature',
        properties: { current: i === 0 && !!journey?.stops[0]?.current },
        geometry: { type: 'LineString', coordinates: coords },
      })),
    });
  }, [ready, grid, fireIds, concern, closures, rows, selected, route, journey]);

  // ─── Layer toggles ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const groups: Record<LayerName, string[]> = {
      'Fire perimeter': ['fire-fill', 'fire-line'],
      'U-Net exposure': ['forecast-fill', 'forecast-line'],
      'Closed roads': ['closure-line', 'closure-casing'],
      Requests: ['request-dots'],
      Stations: [],
      'Selected route': ['route-casing', 'route-line'],
    };
    for (const [name, ids] of Object.entries(groups)) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', visible.has(name as LayerName) ? 'visible' : 'none');
    }
  }, [ready, visible]);

  // ─── HTML labels ───
  const fireAt = useMemo(() => centroid(grid, fireIds), [grid, fireIds]);
  const selLon = selected?.request.lon;
  const selLat = selected?.request.lat;
  const forecastAt = useMemo(
    () => (selLon === undefined || selLat === undefined ? null : nearestCellPoint(grid, forecastIds, [selLon, selLat])),
    [grid, forecastIds, selLon, selLat]
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const markers = markersRef.current;
    type Spec = { at: LngLat; html: string; className: string; anchor: maplibregl.PositionAnchor; offset?: [number, number] };
    const want: Record<string, Spec> = {};

    if (visible.has('Stations')) {
      for (const s of snapshot.stations) {
        want[`station-${s.id}`] = {
          at: [s.lon, s.lat],
          html: `<span class="cmap-station__icon"><img src="${warehouse}" width="15" height="15" alt="" /></span>${stationShort(s.name)}`,
          className: 'cmap-station',
          anchor: 'left',
          offset: [-13, 0],
        };
      }
    }
    if (visible.has('Requests')) {
      for (const r of rows) {

        want[`req-${r.request.id}`] = { at: [r.request.lon, r.request.lat], html: `<button type="button" aria-label="Select ${requestCode(r.request.id)}">${alertMarker(r.request, requestCode(r.request.id))}</button>`, className: 'pixel-map-marker', anchor: 'center' };
      }
    }
    for (const u of snapshot.units) want[`truck-${u.id}`] = { at: [u.lon, u.lat], html: truckMarker(u.callsign) + `<small class="truck-motion-status">${vehicleStatus(u, snapshot.clock.simS)}</small>`, className: 'pixel-map-marker', anchor: 'center' };
    if (journey) {
      journey.stops.forEach(({ row, current }, i) => {
        const eta = clockHM(simToMs(snapshot.clock, row.entry.etaS));
        want[`stop-${i}`] = {
          at: [row.request.lon, row.request.lat],
          html: `<span class="cmap-stop__n">${current ? '▶' : i + (journey.stops[0]?.current ? 0 : 1)}</span>${requestCode(row.request.id)} · ${eta}`,
          className: `cmap-stop${current ? ' cmap-stop--current' : ''}`,
          anchor: 'left',
          offset: [-9, 0],
        };
      });
    } else if (selected) {

    }
    if (fireAt && visible.has('Fire perimeter')) want.fire = { at: fireAt, html: 'ACTIVE FIRE', className: 'cmap-text cmap-text--fire', anchor: 'center' };

    for (const key of Object.keys(markers)) {
      if (!want[key]) {
        markers[key].remove();
        delete markers[key];
      }
    }
    for (const [key, spec] of Object.entries(want)) {
      let m = markers[key];
      if (!m) {
        const node = el(spec.className, spec.html);
        if (key.startsWith('req-')) node.addEventListener('click', () => onSelectRef.current(BigInt(key.slice(4))));
        m = markers[key] = new maplibregl.Marker({ element: node, anchor: spec.anchor, offset: spec.offset }).setLngLat(spec.at).addTo(map);
      }
      m.setLngLat(spec.at);
      const node = m.getElement();
      if (node.dataset.markerHtml !== spec.html) { node.innerHTML = spec.html; node.dataset.markerHtml = spec.html; }
      if (node.className.split(' maplibregl')[0] !== spec.className) node.className = `${spec.className} ${node.className.split(' ').filter(c => c.startsWith('maplibregl')).join(' ')}`;
    }
    spreadAlerts(map, markers);
  }, [ready, snapshot.stations, snapshot.units, snapshot.clock, rows, labeled, selected, route, closures, fireAt, forecastAt, visible, journey]);

  const motionRef = useRef(snapshot);
  useEffect(() => { motionRef.current = snapshot; }, [snapshot]);
  useEffect(() => {
    if (!ready) return;
    let frame: number;
    const animate = () => {
      const state = motionRef.current;
      const now = simNow(state.clock);
      for (const unit of state.units) {
        const marker = markersRef.current[`truck-${unit.id}`];
        if (!marker) continue;
        const point = vehiclePositionAt(unit, now);
        marker.setLngLat(point);
        const node = marker.getElement();
        node.dataset.unitId = String(unit.id);
        node.dataset.longitude = point[0].toFixed(6);
        node.dataset.latitude = point[1].toFixed(6);
        const label = node.querySelector('small');
        const status = vehicleStatus(unit, now);
        if (label && label.textContent !== status) label.textContent = status;
        node.title = `${unit.callsign}: ${status}`;
      }
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  // ─── Framing ───
  function fitIncident() {
    const map = mapRef.current;
    if (!map) return;
    const pts: LngLat[] = [
      ...rows.map(r => [r.request.lon, r.request.lat] as LngLat),
      ...snapshot.stations.map(s => [s.lon, s.lat] as LngLat),
      ...snapshot.units.map(u => [u.lon, u.lat] as LngLat),
      ...fireCells.map(c => { const row = Math.floor(c.cellId / grid.cols), col = c.cellId % grid.cols; return [grid.originLon + col * grid.cellSizeM / (111320 * Math.cos(grid.originLat * Math.PI / 180)), grid.originLat + row * grid.cellSizeM / 111320] as LngLat; }),
    ];
    if (!pts.length) return;
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: { top: 50, bottom: 55, left: 70, right: 70 }, duration: 500 });
  }
  const fitRef = useRef(fitIncident);
  useEffect(() => {
    fitRef.current = fitIncident;
  });
  // Live data can arrive after the map loads, or a reseed can move the incident: refit when the stations change.
  const stationsKey = snapshot.stations.map(s => `${s.id}:${s.lat}:${s.lon}`).join('|');
  useEffect(() => {
    if (ready) fitRef.current();
  }, [ready, fitSignal, stationsKey]);

  // Frame a unit's whole journey when it's selected (and once its roads load).
  const journeyKey = journey ? `${journey.unit.id}:${journey.legs ? 'roads' : 'stops'}` : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !journey) return;
    const pts: LngLat[] = [[journey.unit.lon, journey.unit.lat], ...journey.stops.map(({ row }) => [row.request.lon, row.request.lat] as LngLat), ...(journey.legs ?? []).flat()];
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: { top: 120, bottom: 50, left: 230, right: 120 }, maxZoom: 15, duration: 500 });
    // Only when the unit (or its road geometry) changes, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, journeyKey]);

  const selectedId = selected ? String(selected.request.id) : '';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || selLon === undefined || selLat === undefined) return;
    const b = map.getBounds();
    if (!b.contains([selLon, selLat])) map.easeTo({ center: [selLon, selLat], duration: 500 });
    // Only when the selection changes, not on every data refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, selectedId]);

  const w = snapshot.weather;
  const toward = (w.windFromDeg + 180) % 360;

  return (
    <div className="cmap">
      <div ref={containerRef} className="cmap__canvas" />
      {!snapshot.live && <div className="cmap__wind">
        <p className="cmap__wind-speed">
          <img src={arrowDownRight} width={22} height={22} alt="" style={{ transform: `rotate(${toward - 135}deg)` }} />
          {mph(w.windSpeedMps)} mph
        </p>
        <p className="cmap__wind-dir">
          From {compass(w.windFromDeg)} · {Math.round(w.windFromDeg)}° → {compass(toward)}
        </p>
        <p className="cmap__wind-note">Simplified spread · +30 min{w.locked ? ' · manual' : ''}</p>
      </div>
      }
      <div className="cmap__zoom">
        <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
          +
        </button>
        <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
          −
        </button>
        <button type="button" aria-label="Reset north" onClick={() => mapRef.current?.resetNorth()}>
          N ↑
        </button>
      </div>
      <p className="cmap__disclaimer">NIROPS recorded perimeter · U-Net exposure ≥10% by {horizon / 3600}h</p>
    </div>
  );
}
