// Incident command on SpacetimeDB: humans can dispatch an available unit directly;
// the agent continues planning all uncommitted requests.

import { callWithCopy as run } from '../../live/reducers';
import { store } from '../../live/store';
import type { Recommendation } from '../sim/planner';
import type { CommandCapabilities, CommandSource } from '../sources';
import { createCommandBuilder, liveStore } from './snapshot';

const CAPABILITIES: CommandCapabilities = Object.freeze({
  unitAssignment: true,
  planPreview: false,
  speed: true,
  releaseWind: true,
  mockPings: true,
  messaging: true,
});
const NO_RECOMMENDATIONS = Object.freeze([]) as unknown as Recommendation[];

const notLive = (what: string) => Promise.reject(new Error(`${what} isn't available live: the dispatch policy sets the queue.`));

function clockRow() {
  const rows = store.rows('sim_clock');
  return rows.find(r => r.id === 0) ?? rows[0];
}

/** set_sim needs both fields; keep the one not being changed. */
function currentSpeed() {
  const speed = clockRow()?.speed ?? 0;
  return speed > 0 && speed <= 600 ? speed : 30;
}

export function createLiveCommandSource(): CommandSource {
  const { getSnapshot, subscribe } = liveStore(createCommandBuilder());
  return {
    capabilities: CAPABILITIES,
    getSnapshot,
    subscribe,
    setRunning: running => run('set_sim', { running, speed: currentSpeed() }),
    setSpeed: speed => run('set_sim', { running: clockRow()?.running ?? false, speed }),
    setWeather: (windSpeedMps, windFromDeg, gustMps) => run('set_weather', { windSpeedMps, windFromDeg, gustMps, source: 'manual' }),
    releaseWeatherLock: () => run('release_weather_lock', {}),
    overrideAssignment: (requestId, stationId, note) => run('override_assignment', { requestId, stationId, note }),
    assignToUnit: (requestId, unitId) => run('assign_to_unit', { requestId, unitId }),
    setUnitOrder: () => notLive('Reordering a unit'),
    releaseUnit: () => notLive('Releasing a unit'),
    flagRequest: (requestId, kind, detail) => run('flag_request', { requestId, kind, detail }),
    resolveFlag: (flagId, resolution) => run('resolve_flag', { flagId, resolution }),
    sendMockPings: pings =>
      run('submit_mock_requests', {
        pings: pings.map(p => ({ lat: p.lat, lon: p.lon, headcount: p.headcount, needs: p.needs, note: p.note, report: p.report })),
      }),
    messageResident: (requestId, text) => run('message_resident', { requestId, text }),
    recommendations: () => NO_RECOMMENDATIONS,
    previewPlan: () => notLive('A ranking preview'),
    applyPlan: () => notLive('Applying a draft plan'),
  };
}
