import { useEffect, useState, useSyncExternalStore } from 'react';
import { coordsPlace, reverseGeocode, type Place } from '../lib/geo';
import { isLive } from '../live/config';
import { createLiveCommandSource } from './live/command';
import { createLiveResponderSource } from './live/responder';
import { getWorld } from './sim/world';
import type { CommandCapabilities, CommandSource, ResponderCapabilities, ResponderSource } from './sources';

// The one place that picks data sources: SpacetimeDB (./live) unless VITE_DATA_SOURCE=sim, and every screen
// follows. Live mode never calls getWorld(): that starts the simulation's clock and seeds its scenario.

/** Simulated reducer round trip, so UI pending states are exercised. */
const roundTrip = <T>(fn: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
  try {
    resolve(fn());
  } catch (e) {
    reject(e);
  }
}, 300));

const notInSim = () => Promise.reject(new Error('Not available in the simulation.'));
const SIM_RESPONDER: ResponderCapabilities = { stopOrder: true, messaging: false };
const SIM_COMMAND: CommandCapabilities = {
  unitAssignment: true,
  planPreview: true,
  speed: false,
  releaseWind: false,
  mockPings: false,
  messaging: false,
};

const crew = (unitId: number) => `crew:${getWorld().commandSnapshot().units.find(u => u.id === unitId)?.callsign ?? unitId}`;

function simResponderSource(unitId: number): ResponderSource {
  const w = getWorld();
  w.claimPhone(unitId);
  return {
    capabilities: SIM_RESPONDER,
    getSnapshot: () => w.responderSnapshot(unitId),
    subscribe: w.subscribe,
    completeMission: (id, outcome) => roundTrip(() => w.completeMission(id, outcome)),
    setStopOrder: ids => roundTrip(() => w.setUnitOrder(unitId, ids, crew(unitId))),
    resetStopOrder: () => roundTrip(() => w.releaseUnit(unitId, crew(unitId))),
    messageResident: notInSim,
  };
}

function simCommandSource(): CommandSource {
  const w = getWorld();
  return {
    capabilities: SIM_COMMAND,
    getSnapshot: w.commandSnapshot,
    subscribe: w.subscribe,
    setRunning: running => roundTrip(() => w.setRunning(running)),
    setSpeed: notInSim,
    setWeather: (s, d, g) => roundTrip(() => w.setWeather(s, d, g)),
    releaseWeatherLock: notInSim,
    sendMockPings: notInSim,
    messageResident: notInSim,
    overrideAssignment: (id, sid, note) => roundTrip(() => w.overrideAssignment(id, sid, note)),
    assignToUnit: (id, unitId) => roundTrip(() => w.assignToUnit(id, unitId)),
    setUnitOrder: (unitId, ids) => roundTrip(() => w.setUnitOrder(unitId, ids)),
    releaseUnit: unitId => roundTrip(() => w.releaseUnit(unitId)),
    flagRequest: (id, kind, detail) => roundTrip(() => w.flagRequest(id, kind, detail)),
    resolveFlag: (id, resolution) => roundTrip(() => w.resolveFlag(id, resolution)),
    recommendations: w.recommendations,
    previewPlan: (p, weather, pins) => roundTrip(() => w.previewPlan(p, weather, pins)),
    applyPlan: (p, weather, pins, reason) => roundTrip(() => w.applyPlan(p, weather, pins, reason)),
  };
}

const responders = new Map<number, ResponderSource>();
/** The phone carried by one unit (live: its own identity and responder login, surface `responder:<unitId>`). */
export function getResponderSource(unitId: number): ResponderSource {
  let src = responders.get(unitId);
  if (!src) {
    src = isLive ? createLiveResponderSource(unitId) : simResponderSource(unitId);
    responders.set(unitId, src);
  }
  return src;
}

let command: CommandSource | null = null;
export function getCommandSource(): CommandSource {
  command ??= isLive ? createLiveCommandSource() : simCommandSource();
  return command;
}

export function useResponderData(unitId: number) {
  const src = getResponderSource(unitId);
  return { snapshot: useSyncExternalStore(src.subscribe, src.getSnapshot), source: src };
}

export function useCommandData() {
  const src = getCommandSource();
  return { snapshot: useSyncExternalStore(src.subscribe, src.getSnapshot), source: src };
}

// Requests carry only coordinates (no address is stored server-side), so
// look one up for display. Cached per request for the session.
const addresses = new Map<string, Promise<Place>>();

export function useAddress(id: bigint, lat: number, lon: number) {
  const key = String(id);
  const [place, setPlace] = useState<{ key: string; place: Place } | null>(null);
  useEffect(() => {
    let p = addresses.get(key);
    if (!p) {
      // On failure show coordinates now, and try the lookup again next time.
      p = reverseGeocode(lat, lon).catch(() => {
        addresses.delete(key);
        return { ...coordsPlace(lat, lon), street: 'Address unavailable' };
      });
      addresses.set(key, p);
    }
    let live = true;
    p.then(found => live && setPlace({ key, place: found }));
    return () => {
      live = false;
    };
  }, [key, lat, lon]);
  return place?.key === key ? place.place : null;
}
