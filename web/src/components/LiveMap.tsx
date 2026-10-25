import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import { useEffect, useImperativeHandle, useRef, type ReactNode, type Ref } from 'react';
import entrancePin from '../assets/figma/entrance-pin.svg';
import entranceVicinity from '../assets/figma/entrance-vicinity.svg';
import pinCenter from '../assets/figma/pin-center.svg';
import { INCIDENT_AREA } from '../lib/geo';
import './LiveMap.css';

// MapLibre locates its worker relative to its own module, which breaks once
// Vite pre-bundles it; point it at the file Vite serves/emits instead.
maplibregl.setWorkerUrl(workerUrl);

// OpenFreeMap vector tiles (OpenStreetMap data, no API key).
const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
const STREET_ZOOM = 17;
// Shown before we know where the user is.
const FALLBACK_CENTER: [number, number] = [INCIDENT_AREA.lon, INCIDENT_AREA.lat];
const FALLBACK_ZOOM = 11;

export interface LiveMapApi {
  /** Current centre of the visible map. */
  center(): { lat: number; lon: number };
  show(point: { lat: number; lon: number }): void;
}

interface Props {
  fallbackCenter?: { lat: number; lon: number };
  point: { lat: number; lon: number } | null;
  /** 160 on the request screen, 150 elsewhere (Figma "Simulated map"). */
  height: number;
  /** Pan/zoom, drag the pin, and tap the map to move it. */
  editable?: boolean;
  onPick?: (lat: number, lon: number) => void;
  apiRef?: Ref<LiveMapApi>;
  /** Overlay shown on top of the map (e.g. "Finding your location…"). */
  children?: ReactNode;
}

function createPinElement() {
  const el = document.createElement('div');
  el.className = 'pin';
  el.innerHTML = `
    <img class="pin__vicinity" src="${entranceVicinity}" width="58" height="58" alt="" />
    <img class="pin__body" src="${entrancePin}" width="30" height="39" alt="" />
    <img class="pin__center" src="${pinCenter}" width="10" height="10" alt="" />`;
  return el;
}

export function LiveMap({ point, height, editable = false, onPick, apiRef, children, fallbackCenter }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const initialPoint = useRef(point);
  const fallback = useRef< [number, number] >(fallbackCenter ? [fallbackCenter.lon, fallbackCenter.lat] : FALLBACK_CENTER);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    onPickRef.current = onPick;
  });
  useImperativeHandle(apiRef, () => ({
    show: point => { mapRef.current?.jumpTo({ center: [point.lon, point.lat], zoom: FALLBACK_ZOOM }); },
    center: () => {
      const c = mapRef.current?.getCenter();
      return c ? { lat: c.lat, lon: c.lng } : { lat: fallback.current[1], lon: fallback.current[0] };
    },
  }));

  // Create the map once per mount (`point` only sets the initial view;
  // later moves are handled below). `editable` is fixed for a given screen.
  useEffect(() => {
    const point = initialPoint.current;
    const map = new maplibregl.Map({
      container: containerRef.current!,
      style: STYLE_URL,
      center: point ? [point.lon, point.lat] : fallback.current,
      zoom: point ? STREET_ZOOM : FALLBACK_ZOOM,
      interactive: editable,
      attributionControl: { compact: true },
    });
    // Compact attribution starts expanded; collapse it to the ⓘ button so it
    // doesn't cover a third of this small map.
    map.once('load', () =>
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show')
    );
    if (editable) {
      map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
      map.on('click', e => onPickRef.current?.(e.lngLat.lat, e.lngLat.lng));
    }

    // The pin's tip (bottom-centre of the pin body) marks the exact spot.
    const marker = new maplibregl.Marker({
      element: createPinElement(),
      anchor: 'top-left',
      offset: [-29, -42],
      draggable: editable,
      subpixelPositioning: true,
    });
    marker.on('dragend', () => {
      const { lat, lng } = marker.getLngLat();
      onPickRef.current?.(lat, lng);
    });

    mapRef.current = map;
    markerRef.current = marker;
    // The desktop columns and mobile stack can resize this container independently.
    const resize = new ResizeObserver(() => map.resize());
    resize.observe(containerRef.current!);
    return () => {
      resize.disconnect();
      marker.remove();
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
    };
  }, [editable]);

  const lat = point?.lat;
  const lon = point?.lon;
  useEffect(() => {
    const map = mapRef.current;
    const marker = markerRef.current;
    if (!map || !marker) return;
    if (lat === undefined || lon === undefined) {
      marker.remove();
      return;
    }
    marker.setLngLat([lon, lat]).addTo(map);
    // Keep the pin in view, zooming in the first time we learn a location.
    const zoom = Math.max(map.getZoom(), STREET_ZOOM - 1);
    if (!map.getBounds().contains([lon, lat]) || map.getZoom() < STREET_ZOOM - 1) {
      map.easeTo({ center: [lon, lat], zoom, duration: 600 });
    } else if (!editable) {
      map.jumpTo({ center: [lon, lat] });
    }
  }, [lat, lon, editable]);

  return (
    <div className="live-map" style={{ height }}>
      <div ref={containerRef} className="live-map__canvas" />
      <p className="live-map__context">LOCAL PREVIEW</p>
      <p className="live-map__disclaimer">Simulated · Not for navigation</p>
      {children && <div className="live-map__overlay">{children}</div>}
    </div>
  );
}
