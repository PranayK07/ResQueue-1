// maplibre-gl v6 looks for its worker next to its own module file. Vite moves
// that file (pre-bundled in dev, re-chunked in build), so the worker 404s and
// GeoJSON layers never draw. Point it at the real worker file, which Vite
// serves in dev and emits as an asset in build. The worker has no imports.
import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

maplibregl.setWorkerUrl(workerUrl);

/** The configured MapLibre instance; pass it to <Map mapLib={...}>. */
export { maplibregl };
