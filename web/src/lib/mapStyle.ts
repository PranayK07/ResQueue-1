import type { StyleSpecification } from 'maplibre-gl';

/** Satellite context for command and field maps; fire observations remain the historical NIROPS layer. */
export const satelliteStyle: StyleSpecification = {
  version: 8,
  sources: { satellite: { type: 'raster', tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19,
    attribution: 'Imagery © Esri, Maxar, Earthstar Geographics, GIS User Community' } },
  layers: [{ id: 'satellite', type: 'raster', source: 'satellite' }],
};
