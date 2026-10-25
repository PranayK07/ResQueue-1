export const FORECAST_WINDOW_S = 30 * 60;

export const LAYERS = ['Fire perimeter', 'U-Net exposure', 'Closed roads', 'Requests', 'Stations', 'Selected route'] as const;
export type LayerName = (typeof LAYERS)[number];
