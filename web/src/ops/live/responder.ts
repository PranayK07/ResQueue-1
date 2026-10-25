// One responder phone on SpacetimeDB. While the screen is open (the source has a subscriber) and this tab is
// connected as this unit's surface, it heartbeats crew_heartbeat so the simulated-crews driver leaves "Mark
// complete" to this crew; it says goodbye when the screen closes or the page hides. Heartbeats never touch the unit
// row, so they don't pause planning. Rejections carry UI copy (the screens print e.message).

import { connection } from '../../live/connection';
import { operatorOf } from '../../live/operator';
import { call, callWithCopy as run } from '../../live/reducers';
import { store } from '../../live/store';
import type { Surface } from '../../live/tables';
import type { ResponderCapabilities, ResponderSource } from '../sources';
import { createResponderBuilder, liveStore } from './snapshot';

const CAPABILITIES: ResponderCapabilities = Object.freeze({ stopOrder: false, messaging: true });
const HEARTBEAT_MS = 20_000;
/** StrictMode and quick remounts unsubscribe and resubscribe at once; don't say goodbye in between. */
const LEAVE_GRACE_MS = 1000;

const notLive = () => Promise.reject(new Error("The stop order isn't available live: the dispatch policy sets it."));

export function createLiveResponderSource(unitId: number): ResponderSource {
  const surface: Surface = `responder:${unitId}`;
  let open = false;
  let announced = false;
  let lastBeatMs = 0;
  let interval: ReturnType<typeof setInterval> | null = null;
  let leaveTimer: ReturnType<typeof setTimeout> | null = null;

  const connected = () => connection.getSnapshot().surface === surface && connection.liveConnection() !== null;
  // Only a responder of the unit's station (or a commander) may heartbeat; without the my_operator view, just try.
  const allowed = () => {
    const status = store.status('my_operator');
    if (status === 'failed') return true;
    if (status !== 'applied') return false;
    const op = operatorOf(store.rows('my_operator'));
    const unit = store.rows('unit').find(u => u.id === unitId);
    return !!op && !!unit && (op.role === 'commander' || (op.role === 'responder' && op.stationId === unit.stationId));
  };
  // Best effort: a missed heartbeat only means the driver may complete the mission on its own.
  const send = (active: boolean) => {
    call('crew_heartbeat', { unitId, active }).catch(() => {});
  };

  const beat = () => {
    if (!open) return;
    if (!connected()) {
      announced = false;
      return;
    }
    if (!allowed() || (announced && Date.now() - lastBeatMs < HEARTBEAT_MS)) return;
    announced = true;
    lastBeatMs = Date.now();
    send(true);
  };
  const leave = () => {
    if (announced && connected()) send(false);
    announced = false;
    lastBeatMs = 0;
  };

  const onActive = (active: boolean) => {
    if (active) {
      if (leaveTimer) {
        clearTimeout(leaveTimer);
        leaveTimer = null;
      }
      if (open) return;
      open = true;
      interval = setInterval(beat, HEARTBEAT_MS);
      if (typeof window !== 'undefined') window.addEventListener('pagehide', leave);
      beat();
      return;
    }
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      open = false;
      if (interval) clearInterval(interval);
      interval = null;
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', leave);
      leave();
    }, LEAVE_GRACE_MS);
  };

  // Every change re-checks (the clock ticks each second), so the first heartbeat goes out as soon as sign-in lands.
  const { getSnapshot, subscribe } = liveStore(createResponderBuilder(unitId), { onActive, onChange: beat });
  return {
    capabilities: CAPABILITIES,
    getSnapshot,
    subscribe,
    completeMission: (id, outcome) => run('complete_mission', { unitId: id, outcome }),
    setStopOrder: notLive,
    resetStopOrder: notLive,
    messageResident: (requestId, text) => run('message_resident', { requestId, text }),
  };
}
