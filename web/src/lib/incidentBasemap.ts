import type { Map } from 'maplibre-gl';

export type BasemapMode = 'satellite' | 'streets';
export const IMAGERY_SOURCE = 'usgs-orthoimagery';
type PaintProperty = Parameters<Map['getPaintProperty']>[1];
type PaintValue = Parameters<Map['setPaintProperty']>[2];

/** Keep photographic context independent of operational fire, route and request layers. */
export function addIncidentBasemap(map: Map) {
  const base = map.getStyle().layers;
  const visibility = new globalThis.Map(base.map(layer => [layer.id, layer.layout?.visibility ?? 'visible']));
  const changes: { id: string; property: PaintProperty; original: PaintValue; satellite: PaintValue }[] = [];
  const remember = (id: string, property: PaintProperty, satellite: PaintValue) => {
    changes.push({ id, property, original: map.getPaintProperty(id, property), satellite });
  };
  for (const layer of base) {
    if (layer.type === 'symbol' && layer.layout?.['text-field']) {
      remember(layer.id, 'text-color', '#f4f6ed');
      remember(layer.id, 'text-halo-color', '#18271e');
      remember(layer.id, 'text-halo-width', 1.5);
    } else if (layer.type === 'line' && /road|highway|transportation/.test(layer.id)) {
      remember(layer.id, 'line-color', /casing|outline/.test(layer.id) ? '#20342c' : '#d9e1d1');
      remember(layer.id, 'line-opacity', 0.75);
    }
  }
  map.addSource(IMAGERY_SOURCE, {
    type: 'raster', tileSize: 256, maxzoom: 16,
    tiles: ['https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}'],
    attribution: '<a href="https://www.usgs.gov/the-national-map-data-delivery" target="_blank" rel="noopener">USDA / USGS The National Map imagery</a>',
  });
  map.addLayer({ id: IMAGERY_SOURCE, type: 'raster', source: IMAGERY_SOURCE, paint: {
    'raster-opacity': 1, 'raster-saturation': -0.05, 'raster-brightness-max': 0.95, 'raster-fade-duration': 200,
  } }, base.find(layer => layer.type !== 'background')?.id);

  return {
    setMode(mode: BasemapMode) {
      const satellite = mode === 'satellite';
      map.setLayoutProperty(IMAGERY_SOURCE, 'visibility', satellite ? 'visible' : 'none');
      for (const layer of base) {
        if (['fill', 'fill-extrusion', 'raster', 'hillshade'].includes(layer.type)) {
          map.setLayoutProperty(layer.id, 'visibility', satellite ? 'none' : visibility.get(layer.id));
        }
      }
      for (const change of changes) map.setPaintProperty(change.id, change.property, satellite ? change.satellite : change.original);
    },
  };
}
