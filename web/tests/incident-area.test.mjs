import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let server, insideIncidentArea, defaultIncidentLocation;
const area = { originLat: 35.6, originLon: -112.8, rows: 128, cols: 128, cellSizeM: 60 };
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ insideIncidentArea, defaultIncidentLocation } = await server.ssrLoadModule('/src/lib/incidentArea.ts'));
});
after(async () => { await server?.close(); });

test('the starting pin stays in the incident before fire data arrives', () => {
  const point = defaultIncidentLocation(area, []);
  assert(insideIncidentArea(area, point));
  assert.equal(point.entrance, '');
  assert.equal(defaultIncidentLocation(null, []), null);
  assert.equal(defaultIncidentLocation({ ...area, rows: 0 }, []), null);
});

test('perimeter-based placement stays inside, including at grid corners', () => {
  const fire = [0, 127, 128 * 127, 128 * 128 - 1].map(cellId => ({ cellId }));
  for (const seed of [0, 0.25, 0.5, 0.99, 1, NaN]) {
    const point = defaultIncidentLocation(area, fire, seed);
    assert(insideIncidentArea(area, point));
  }
  const small = { ...area, rows: 2, cols: 2 };
  assert(insideIncidentArea(small, defaultIncidentLocation(small, [{ cellId: 3 }])));
});

test('boundary checks match the reducer rectangle and reject points beyond every edge', () => {
  const north = area.originLat + area.rows * area.cellSizeM / 111_320;
  const east = area.originLon + area.cols * area.cellSizeM / (111_320 * Math.cos(area.originLat * Math.PI / 180));
  assert(insideIncidentArea(area, { lat: area.originLat, lon: area.originLon }));
  assert(insideIncidentArea(area, { lat: north, lon: east }));
  for (const point of [
    { lat: north + 1e-6, lon: area.originLon },
    { lat: area.originLat - 1e-6, lon: area.originLon },
    { lat: area.originLat, lon: east + 1e-6 },
    { lat: area.originLat, lon: area.originLon - 1e-6 },
    { lat: NaN, lon: area.originLon },
    { lat: area.originLat, lon: Infinity },
  ]) assert(!insideIncidentArea(area, point));
});

test('a different incident gets a default from its own grid, without Arizona coordinates', () => {
  const nextArea = { ...area, originLat: 44.2, originLon: -120.3 };
  const point = defaultIncidentLocation(nextArea, []);
  assert(insideIncidentArea(nextArea, point));
  assert(!insideIncidentArea(area, point));
});

test('the correction form warns and blocks confirmation only outside the incident', async () => {
  const { CorrectLocationScreen } = await server.ssrLoadModule('/src/screens/CorrectLocationScreen.tsx');
  for (const outside of [false, true]) {
    const initial = outside ? { lat: 47.6, lon: -122.33, street: 'Outside address', area: '', entrance: '' } : defaultIncidentLocation(area, []);
    const html = renderToStaticMarkup(createElement(CorrectLocationScreen, {
      initial, incidentArea: area, position: { status: 'locating', source: 'incident' }, onConfirm() {},
    }));
    assert.equal(html.includes('Pin outside the incident area'), outside);
    assert.equal(/<button[^>]*disabled[^>]*>Confirm location on this device<\/button>/.test(html), outside);
  }
});

test('location updates also identify an out-of-area pin', async () => {
  const { UpdateLocationScreen } = await server.ssrLoadModule('/src/screens/UpdateLocationScreen.tsx');
  const html = renderToStaticMarkup(createElement(UpdateLocationScreen, {
    incidentArea: area, request: { number: 'TEST', location: { lat: 47.6, lon: -122.33, street: 'Outside address', area: '', entrance: '' } },
    async onSend() {}, onKeep() {},
  }));
  assert(html.includes('Pin outside the incident area'));
  assert(html.includes('Return to incident area'));
});
