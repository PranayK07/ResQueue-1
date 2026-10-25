import type { FeatureCollection } from 'geojson';
import { memo, useMemo } from 'react';
import { Layer, Source, type LayerProps } from 'react-map-gl/maplibre';
import type { GridGeom } from '@/lib/geo/grid';
import { closuresLayer, fireLayer, forecastLayer, gridOutlineLayer } from '@/lib/geo/layers';
import type { FireCellRow, ForecastCellRow, RoadClosureRow } from '@/lib/stdb';
import { BAND_STYLE, FIRE_OPACITY, MAP_HEX } from './mapColors';

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

// Adjacent cells are axis-aligned, so antialiasing only adds faint seams between them.
const forecastFill: LayerProps = {
  id: 'cmd-forecast-fill',
  type: 'fill',
  paint: {
    'fill-color': [
      'match',
      ['get', 'band'],
      'lt30',
      BAND_STYLE.lt30.color,
      '30to60',
      BAND_STYLE['30to60'].color,
      BAND_STYLE.gt60.color,
    ],
    'fill-opacity': [
      'match',
      ['get', 'band'],
      'lt30',
      BAND_STYLE.lt30.opacity,
      '30to60',
      BAND_STYLE['30to60'].opacity,
      BAND_STYLE.gt60.opacity,
    ],
    'fill-antialias': false,
  },
};

const fireFill: LayerProps = {
  id: 'cmd-fire-fill',
  type: 'fill',
  paint: {
    'fill-color': MAP_HEX.fire,
    'fill-opacity': [
      '+',
      FIRE_OPACITY.base,
      ['*', FIRE_OPACITY.perIntensity, ['max', 0, ['min', 1, ['to-number', ['get', 'intensity'], 0]]]],
    ],
    'fill-antialias': false,
  },
};

const gridLine: LayerProps = {
  id: 'cmd-grid-outline',
  type: 'line',
  paint: { 'line-color': MAP_HEX.muted, 'line-opacity': 0.5, 'line-width': 1, 'line-dasharray': [3, 3] },
};

const closureLine: LayerProps = {
  id: 'cmd-closures-line',
  type: 'line',
  layout: { 'line-cap': 'butt', 'line-join': 'round' },
  paint: { 'line-color': MAP_HEX.fire, 'line-width': 3, 'line-dasharray': [2, 1.5] },
};

type ScenarioLayersProps = {
  grid: GridGeom;
  /** Sim seconds already snapped to a coarse step by the caller; undefined hides the bands. */
  simStep: number | undefined;
  fireCells: readonly FireCellRow[];
  forecastCells: readonly ForecastCellRow[];
  closures: readonly RoadClosureRow[];
};

/**
 * GeoJSON layers, bottom to top: forecast bands, burning cells, incident-area
 * outline, active road closures. Every source always mounts (empty when there's
 * no data) so MapLibre keeps this order when data arrives late.
 */
export const ScenarioLayers = memo(function ScenarioLayers({
  grid,
  simStep,
  fireCells,
  forecastCells,
  closures,
}: ScenarioLayersProps) {
  const forecast = useMemo(
    () => (simStep === undefined ? EMPTY : forecastLayer(forecastCells, grid, simStep)),
    [forecastCells, grid, simStep]
  );
  const fire = useMemo(() => fireLayer(fireCells, grid), [fireCells, grid]);
  const outline = useMemo(() => gridOutlineLayer(grid), [grid]);
  const closureLines = useMemo(() => closuresLayer(closures), [closures]);

  return (
    <>
      <Source id="cmd-forecast" type="geojson" data={forecast}>
        <Layer {...forecastFill} />
      </Source>
      <Source id="cmd-fire" type="geojson" data={fire}>
        <Layer {...fireFill} />
      </Source>
      <Source id="cmd-grid" type="geojson" data={outline}>
        <Layer {...gridLine} />
      </Source>
      <Source id="cmd-closures" type="geojson" data={closureLines}>
        <Layer {...closureLine} />
      </Source>
    </>
  );
});
