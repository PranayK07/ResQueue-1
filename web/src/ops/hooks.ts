import { useEffect, useState, useSyncExternalStore } from 'react';
import { coordsPlace, reverseGeocode, type Place } from '../lib/geo';
import { getWorld } from './sim/world';
import type { CommandSource, ResponderSource } from './sources';

// The one place that picks data sources. Swap these for SpacetimeDB-backed
// implementations (see sources.ts) and every screen follows.

/** Simulated reducer round trip, so UI pending states are exercised. */
const roundTrip = <T>(fn: () => T) => new Promise<T>((resolve, reject) => setTimeout(() => {
  try {
    resolve(fn());
  } catch (e) {
    reject(e);
  }
}, 300));

const responders = new Map<number, ResponderSource>();
const crew = (unitId: number) => `crew:${getWorld().commandSnapshot().units.find(u => u.id === unitId)?.callsign ?? unitId}`;
/** The phone carried by one unit (in a live build: one operator login per device). */
export function getResponderSource(unitId: number): ResponderSource {
  let src = responders.get(unitId);
  if (!src) {
    const w = getWorld();
    w.claimPhone(unitId);
    src = {
      getSnapshot: () => w.responderSnapshot(unitId),
      subscribe: w.subscribe,
      completeMission: (id, outcome) => roundTrip(() => w.completeMission(id, outcome)),
      setStopOrder: ids => roundTrip(() => w.setUnitOrder(unitId, ids, crew(unitId))),
      resetStopOrder: () => roundTrip(() => w.releaseUnit(unitId, crew(unitId))),
    };
    responders.set(unitId, src);
  }
  return src;
}

let command: CommandSource | null = null;
export function getCommandSource(): CommandSource {
  if (!command) {
    const w = getWorld();
    command = {
      getSnapshot: w.commandSnapshot,
      subscribe: w.subscribe,
      setRunning: running => roundTrip(() => w.setRunning(running)),
      setWeather: (s, d, g) => roundTrip(() => w.setWeather(s, d, g)),
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
