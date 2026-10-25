import type { FeatureCollection } from 'geojson';
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useMemo, useRef, useState } from 'react';
import { addIncidentBasemap, IMAGERY_SOURCE, type BasemapMode } from '../../lib/incidentBasemap';
import arrowDownRight from '../../assets/figma/command/arrow-down-right.svg';
import ban from '../../assets/figma/command/ban.svg';
import warehouse from '../../assets/figma/command/warehouse.svg';
import { cellsOutline, cellsToPolygons, centroid, clockHM, forecastArea, nearestCellPoint, requestCode, simToMs } from '../../ops/derive';
import type { Route } from '../../ops/routing';
import type { CommandSnapshot, Unit } from '../../ops/types';
import { compass, mph, slackMin, stationShort, type CommandRow } from '../derive';
import { FORECAST_WINDOW_S, type LayerName } from '../mapLayers';
import './CommandMap.css';

maplibregl.setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };
type LngLat = [number, number];

const LEVEL_COLOR = ['match', ['get', 'level'], 'unreachable', '#20282d', 'critical', '#ff6857', 'high', '#f3b451', 'moderate', '#9bb98a', '#a5b0b5'];

/** A unit's route: from where it is now, through each stop in order. */
export interface Journey {
  unit: Unit;
  stops: { row: CommandRow; current: boolean }[];
  /** Road geometry per leg; null while loading. */
  legs: LngLat[][] | null;
}

interface Props {
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

export function CommandMap({ snapshot, rows, selected, labeled, route, visible, fitSignal, journey, onSelect }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markersRef = useRef<Record<string, maplibregl.Marker>>({});
  const basemapRef = useRef<ReturnType<typeof addIncidentBasemap> | null>(null);
  const [basemap, setBasemap] = useState<BasemapMode>('satellite');
  const [imageryError, setImageryError] = useState(false);
  const firstSelection = useRef(true);
  const initialGrid = useRef(snapshot.grid);
  const onSelectRef = useRef(onSelect);
  useEffect(() => {
    onSelectRef.current = onSelect;
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const grid = initialGrid.current;
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: [grid.originLon + grid.cols * grid.cellSizeM / (111_320 * Math.cos(grid.originLat * Math.PI / 180)) / 2,
        grid.originLat + grid.rows * grid.cellSizeM / 111_320 / 2],
      zoom: 12,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    map.on('error', event => {
      if ((event as typeof event & { sourceId?: string }).sourceId === IMAGERY_SOURCE) { setImageryError(true); setBasemap('streets'); }
    });
    map.on('load', () => {
      basemapRef.current = addIncidentBasemap(map);
      basemapRef.current.setMode('satellite');
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show');
      for (const id of ['forecast', 'forecast-edge', 'fire', 'fire-edge', 'closures', 'route', 'journey', 'requests', 'incident-labels']) map.addSource(id, { type: 'geojson', data: EMPTY });
      map.addLayer({ id: 'forecast-fill', type: 'fill', source: 'forecast', paint: { 'fill-color': '#f3b451', 'fill-opacity': 0.12, 'fill-antialias': false } });
      map.addLayer({ id: 'forecast-casing', type: 'line', source: 'forecast-edge', paint: { 'line-color': '#302414', 'line-width': 4.5 } });
      map.addLayer({ id: 'forecast-line', type: 'line', source: 'forecast-edge', paint: { 'line-color': '#f3b451', 'line-width': 2.5, 'line-dasharray': [3, 2] } });
      map.addLayer({ id: 'fire-fill', type: 'fill', source: 'fire', paint: { 'fill-color': '#e5664f', 'fill-opacity': 0.26, 'fill-antialias': false } });
      map.addLayer({ id: 'fire-casing', type: 'line', source: 'fire-edge', paint: { 'line-color': '#3b1d18', 'line-width': 5 } });
      map.addLayer({ id: 'fire-line', type: 'line', source: 'fire-edge', paint: { 'line-color': '#ff765f', 'line-width': 2.8 } });
      map.addLayer({ id: 'closure-casing', type: 'line', source: 'closures', paint: { 'line-color': '#fff5ec', 'line-width': 7 } });
      map.addLayer({ id: 'closure-line', type: 'line', source: 'closures', paint: { 'line-color': '#b33b32', 'line-width': 4, 'line-dasharray': [1, 0.8] } });
      map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#142c38', 'line-width': 8 } });
      map.addLayer({ id: 'route-line', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#69caff', 'line-width': 4 } });
      map.addLayer({ id: 'journey-casing', type: 'line', source: 'journey', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#142c38', 'line-width': 8 } });
      map.addLayer({
        id: 'journey-current',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'current'], true],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': '#69caff', 'line-width': 4 },
      });
      map.addLayer({
        id: 'journey-planned',
        type: 'line',
        source: 'journey',
        filter: ['==', ['get', 'current'], false],
        layout: { 'line-join': 'round' },
        paint: { 'line-color': '#99d8ff', 'line-width': 3, 'line-dasharray': [2, 1.5] },
      });
      map.addLayer({ id: 'request-halos', type: 'circle', source: 'requests', paint: {
        'circle-radius': ['case', ['get', 'selected'], 10, 8], 'circle-color': '#14231c', 'circle-opacity': 0.85,
      } });
      map.addLayer({
        id: 'request-dots',
        type: 'circle',
        source: 'requests',
        paint: {
          'circle-radius': ['case', ['get', 'selected'], 7, 5],
          'circle-color': LEVEL_COLOR as unknown as string,
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 2,
        },
      });
      // Keep each label on a fixed side of its coordinate. Variable anchors switch sides
      // when zooming settles, which makes labels appear to jump between callers.
      const labelLayout: maplibregl.SymbolLayerSpecification['layout'] = {
        'text-field': ['get', 'label'], 'text-font': ['Noto Sans Regular'],
        'text-size': ['case', ['get', 'selected'], 13, 11],
        'symbol-sort-key': ['get', 'priority'],
        'text-anchor': 'left', 'text-offset': [1.5, 0], 'text-max-width': 30,
      };
      const labelPaint: maplibregl.SymbolLayerSpecification['paint'] = {
        'text-color': ['match', ['get', 'kind'], 'fire', '#ff958a', 'forecast', '#ffcf79', 'route', '#99d8ff', '#ffffff'],
        'text-halo-color': '#17271e', 'text-halo-width': 2,
      };
      map.addLayer({
        id: 'incident-labels', type: 'symbol', source: 'incident-labels',
        filter: ['==', ['get', 'selected'], false], layout: labelLayout, paint: labelPaint,
      });
      // Topmost symbols are placed first, reserving room for the selected callout.
      map.addLayer({
        id: 'selected-label', type: 'symbol', source: 'incident-labels',
        filter: ['==', ['get', 'selected'], true],
        layout: { ...labelLayout, 'text-allow-overlap': true }, paint: labelPaint,
      });
      map.on('click', 'request-dots', e => {
        const id = e.features?.[0]?.properties?.id;
        if (id !== undefined) onSelectRef.current(BigInt(id));
      });
      map.on('mouseenter', 'request-dots', () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', 'request-dots', () => (map.getCanvas().style.cursor = ''));
      const selectLabel = (e: maplibregl.MapLayerMouseEvent) => {
        const id = e.features?.[0]?.properties?.id;
        if (id !== undefined) onSelectRef.current(BigInt(id));
      };
      map.on('click', 'incident-labels', selectLabel);
      map.on('click', 'selected-label', selectLabel);
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
      basemapRef.current = null;
    };
  }, []);

  useEffect(() => { if (ready) basemapRef.current?.setMode(basemap); }, [ready, basemap]);

  const { grid, fireCells, forecastCells, closures, clock } = snapshot;
  const fireIds = useMemo(() => new Set(fireCells.map(c => c.cellId)), [fireCells]);
  const forecastIds = useMemo(() => forecastArea(fireCells, forecastCells, clock.simS + FORECAST_WINDOW_S), [fireCells, forecastCells, clock.simS]);

  // ─── Data ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const set = (id: string, data: FeatureCollection | GeoJSON.Feature) => (map.getSource(id) as maplibregl.GeoJSONSource).setData(data);
    set('fire', cellsToPolygons(grid, fireIds));
    set('fire-edge', cellsOutline(grid, fireIds));
    set('forecast', cellsToPolygons(grid, forecastIds));
    set('forecast-edge', cellsOutline(grid, forecastIds));
    set('closures', {
      type: 'FeatureCollection',
      features: closures.filter(c => c.active).map(c => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[c.lon1, c.lat1], [c.lon2, c.lat2]] } })),
    });
    set('requests', {
      type: 'FeatureCollection',
      features: rows.map(r => ({
        type: 'Feature', id: String(r.request.id),
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
  }, [ready, grid, fireIds, forecastIds, closures, rows, selected, route, journey]);

  // ─── Layer toggles ───
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const groups: Record<LayerName, string[]> = {
      'Fire perimeter': ['fire-fill', 'fire-line', 'fire-casing'],
      'Forecast +30m': ['forecast-fill', 'forecast-line', 'forecast-casing'],
      'Closed roads': ['closure-line', 'closure-casing'],
      Requests: ['request-dots', 'request-halos'],
      Stations: [],
      'Selected route': ['route-casing', 'route-line'],
    };
    for (const [name, ids] of Object.entries(groups)) {
      for (const id of ids) map.setLayoutProperty(id, 'visibility', visible.has(name as LayerName) ? 'visible' : 'none');
    }
  }, [ready, visible]);

  // ─── Labels ───
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
    const labels: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const add = (id: string, at: LngLat, properties: Record<string, string | number | boolean>) => labels.features.push({
      type: 'Feature', id, properties, geometry: { type: 'Point', coordinates: at },
    });
    if (visible.has('Requests') && !journey) {
      for (const row of rows) {
        const active = row === selected;
        if (!active && !labeled.has(row.request.id)) continue;
        const minutes = slackMin(row.request.slackS);
        const detail = minutes === null ? (row.escalated ? 'No ground route' : 'Assessing') : `Slack ${minutes > 0 ? '+' : ''}${minutes} min`;
        add(`request-${row.request.id}`, [row.request.lon, row.request.lat], {
          id: String(row.request.id), kind: 'request', selected: active, priority: active ? 0 : 3,
          label: `${requestCode(row.request.id)}${active ? ` · ${detail}` : ''}`,
        });
      }
    }
    if (fireAt && visible.has('Fire perimeter')) add('fire', fireAt, { kind: 'fire', selected: false, priority: 1, label: 'ACTIVE FIRE' });
    if (forecastAt && visible.has('Forecast +30m')) add('forecast', forecastAt, { kind: 'forecast', selected: false, priority: 2, label: 'FORECAST · +30 MIN' });
    if (!journey && route && route.coords.length > 1 && selected?.unit && visible.has('Selected route')) {
      add('travel', route.coords[Math.floor(route.coords.length / 2)], { kind: 'route', selected: false, priority: 1,
        label: `${selected.unit.callsign} · ${Math.round(selected.entry.travelS / 60)} min travel` });
    }
    (map.getSource('incident-labels') as maplibregl.GeoJSONSource).setData(labels);
  }, [ready, rows, labeled, selected, journey, route, fireAt, forecastAt, visible]);

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
    if (journey) {
      const u = journey.unit;
      want.unit = { at: [u.lon, u.lat], html: u.callsign, className: 'cmap-unit', anchor: 'center' };
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
      if (visible.has('Requests')) want.selected = {
        at: [selected.request.lon, selected.request.lat],
        html: '<span class="cmap-halo"></span>',
        className: 'cmap-selected',
        anchor: 'center',
      };
    }
    if (visible.has('Closed roads')) {
      for (const c of closures.filter(x => x.active)) {
        want[`closure-${c.id}`] = { at: [(c.lon1 + c.lon2) / 2, (c.lat1 + c.lat2) / 2], html: `<img src="${ban}" width="12" height="12" alt="" />${c.name} closed`, className: 'cmap-tag cmap-tag--closure', anchor: 'right', offset: [-8, 0] };
      }
    }
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
        m = markers[key] = new maplibregl.Marker({ element: node, anchor: spec.anchor, offset: spec.offset, subpixelPositioning: true }).setLngLat(spec.at).addTo(map);
      }
      m.setLngLat(spec.at);
      const node = m.getElement();
      if (node.innerHTML !== spec.html) node.innerHTML = spec.html;
      if (node.className.split(' maplibregl')[0] !== spec.className) node.className = `${spec.className} ${node.className.split(' ').filter(c => c.startsWith('maplibregl')).join(' ')}`;
    }
  }, [ready, snapshot.stations, snapshot.clock, selected, closures, visible, journey]);

  // ─── Framing ───
  function fitIncident() {
    const map = mapRef.current;
    if (!map) return;
    const pts: LngLat[] = [
      ...rows.map(r => [r.request.lon, r.request.lat] as LngLat),
      ...snapshot.stations.map(s => [s.lon, s.lat] as LngLat),
      ...(fireAt ? [fireAt] : []),
    ];
    if (!pts.length) return;
    const b = pts.reduce((acc, p) => acc.extend(p), new maplibregl.LngLatBounds(pts[0], pts[0]));
    map.fitBounds(b, { padding: { top: 110, bottom: 64, left: 190, right: 80 }, duration: 500 });
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
    if (firstSelection.current) { firstSelection.current = false; return; }
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
      <div className="cmap__basemap" role="group" aria-label="Map background">
        <button type="button" aria-pressed={basemap === 'satellite'} onClick={() => { setImageryError(false); setBasemap('satellite'); }}>Satellite</button>
        <button type="button" aria-pressed={basemap === 'streets'} onClick={() => setBasemap('streets')}>Streets</button>
      </div>
      <div className="cmap__wind">
        <p className="cmap__wind-speed">
          <img src={arrowDownRight} width={22} height={22} alt="" style={{ transform: `rotate(${toward - 135}deg)` }} />
          {mph(w.windSpeedMps)} mph
        </p>
        <p className="cmap__wind-dir">
          From {compass(w.windFromDeg)} · {Math.round(w.windFromDeg)}° → {compass(toward)}
        </p>
        <p className="cmap__wind-note">Simplified spread · +30 min{w.locked ? ' · manual' : ''}</p>
      </div>
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
      <p className="cmap__disclaimer">{imageryError ? 'Imagery unavailable · street map shown' : basemap === 'satellite' ? 'USGS aerial imagery · simulated fire overlays' : 'Street map · simulated fire overlays'}</p>
    </div>
  );
}
