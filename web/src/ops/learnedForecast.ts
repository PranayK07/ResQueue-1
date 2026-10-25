import proj4 from 'proj4';
import type { FeatureCollection, Polygon } from 'geojson';
import type { FireRiskLayer } from './types';

export const EXPOSURE_THRESHOLD = 0.1;
/** Color encodes learned exposure probability, not an invented arrival time. */
export const EXPOSURE_COLOR = ['interpolate', ['linear'], ['get', 'probability'], 0.1, '#f2e535', 0.35, '#ffbc25', 0.65, '#ff8522', 1, '#ed4520'];

/** Exact UTM -> WGS84 alignment with the model's south-up geographic grid. */
export function learnedConcern(layer: FireRiskLayer | null, horizon: number): FeatureCollection<Polygon> {
  const empty: FeatureCollection<Polygon> = { type: 'FeatureCollection', features: [] };
  if (!layer || layer.source !== 'learned' || !layer.horizonsS.includes(horizon)) return empty;
  const match = /^EPSG:(326|327)(\d{2})$/.exec(layer.crs);
  if (!match) return empty;
  const projection = proj4(`+proj=utm +zone=${Number(match[2])} ${match[1] === '327' ? '+south' : ''} +datum=WGS84 +units=m +no_defs`, 'EPSG:4326');
  const slot = layer.horizonsS.indexOf(horizon);
  return { type: 'FeatureCollection', features: layer.cells.flatMap(cell => {
    const probability = cell.p[slot];
    if (cell.observed || !Number.isFinite(probability) || probability < EXPOSURE_THRESHOLD) return [];
    const row = Math.floor(cell.cellId / layer.cols), col = cell.cellId % layer.cols;
    const x = layer.westM + col * layer.cellSizeM, y = layer.southM + row * layer.cellSizeM, d = layer.cellSizeM;
    return [{ type: 'Feature' as const, properties: { probability, horizon, cellId: cell.cellId },
      geometry: { type: 'Polygon' as const, coordinates: [[[x, y], [x + d, y], [x + d, y + d], [x, y + d], [x, y]].map(point => projection.forward(point))] } }];
  }) };
}
