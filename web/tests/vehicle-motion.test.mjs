import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { createServer } from 'vite';
let server, vehiclePositionAt, vehicleStatus;
before(async () => {
  server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ({ vehiclePositionAt, vehicleStatus } = await server.ssrLoadModule('/src/ops/vehicleMotion.ts'));
});
after(async () => { await server?.close(); });
const unit = { lat: 35, lon: -112, status: 'en_route', trip: {
  fromLat: 35, fromLon: -112, toLat: 35.01, toLon: -111.99, departS: 100, arriveS: 700,
  route: { coords: [[-112,35],[-112,35.01],[-111.99,35.01]] },
} };
test('truck and attached status advance along the route, including its turns', () => {
  assert.deepEqual(vehiclePositionAt(unit, 0), [-112,35]);
  const mid = vehiclePositionAt(unit, 250);
  assert.equal(mid[0], -112);
  assert(mid[1] > 35 && mid[1] < 35.01);
  assert.deepEqual(vehiclePositionAt(unit, 1000), [-111.99,35.01]);
  assert.equal(vehicleStatus(unit, 250), 'Approaching · 8 min');
});
test('a paused replay samples the same position and on-scene units remain at the scene', () => {
  assert.deepEqual(vehiclePositionAt(unit, 250), vehiclePositionAt(unit, 250));
  const scene = { ...unit, lat:35.01, lon:-111.99, status:'on_scene' };
  assert.deepEqual(vehiclePositionAt(scene, 1000), [-111.99,35.01]);
  assert.equal(vehicleStatus(scene, 1000), 'On scene · extraction');
});
test('return trips move toward home and assigned trucks wait for departure', () => {
  const returning = { ...unit, status:'returning' };
  assert.notDeepEqual(vehiclePositionAt(returning, 200), vehiclePositionAt(returning, 400));
  assert.equal(vehicleStatus(returning, 400), 'Returning · 5 min');
  assert.deepEqual(vehiclePositionAt({ ...unit, status:'assigned' }, 400), [-112,35]);
});
