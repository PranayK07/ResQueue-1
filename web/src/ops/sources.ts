// What the operations screens depend on. Two implementations: the simulated
// world (./sim/world.ts) and SpacetimeDB (./live/*), picked once in hooks.ts
// from VITE_DATA_SOURCE. Screens never know which one they run on; where the
// two differ, they ask `capabilities` (the backend has no reducer for some
// of the simulation's commander tools) or read the optional `snapshot.live`.
//
// The live implementation:
//   1. Bindings: `npm run bindings` (spacetime generate into src/module_bindings).
//   2. One DbConnection per surface (command, responder:<unitId>, caller), each
//      with its own saved identity; operators sign in with claim_operator.
//   3. Subscribes to the surface's tables and views, mirrors the client cache,
//      and rebuilds the snapshot from it (Timestamp → ms, option → null).
//      getSnapshot returns the same object until something changes.

import type { CommandSnapshot, FlagKind, MissionOutcome, PlanPolicy, PositionPin, ResponderSnapshot, Weather } from './types';
import type { PlanPreview } from './sim/world';
import type { Recommendation } from './sim/planner';

interface Store<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

export interface ResponderCapabilities {
  /** The crew sets the order of its own upcoming stops (SIM-ONLY: no reducer). */
  stopOrder: boolean;
  /** Write to the resident (message_resident; live only). */
  messaging: boolean;
}

/**
 * Responder phone. Subscribe to: sim_clock, grid, station, unit, weather,
 * fire_cell, forecast_cell, road_closure, ops_request, ops_queue (+ live extras).
 */
export interface ResponderSource extends Store<ResponderSnapshot> {
  readonly capabilities: ResponderCapabilities;
  /** complete_mission: 'rescued' closes the request; 'aborted' returns it to the queue. */
  completeMission(unitId: number, outcome: MissionOutcome): Promise<void>;
  /** SIM-ONLY: the crew sets the order of its own upcoming stops (no reducer yet). */
  setStopOrder(requestIds: bigint[]): Promise<void>;
  /** SIM-ONLY: hand the crew's stops back to the automatic order. */
  resetStopOrder(): Promise<void>;
  /** message_resident (1..1000 chars). Rejects unless capabilities.messaging. */
  messageResident(requestId: bigint, text: string): Promise<void>;
}

export interface CommandCapabilities {
  /** Commit a request to one unit, reorder or release a unit's stops (SIM-ONLY: live can only pin a station). */
  unitAssignment: boolean;
  /** What-if ranking preview and applying policy parameters / position pins (SIM-ONLY). */
  planPreview: boolean;
  /** set_sim speed (live; the simulation runs at 1x). */
  speed: boolean;
  /** release_weather_lock: hand the wind back to the live feed (live only). */
  releaseWind: boolean;
  /** submit_mock_requests: simulated residents pinging for help (live only). */
  mockPings: boolean;
  /** message_resident (live only). */
  messaging: boolean;
}

/** One simulated resident's help ping (submit_mock_requests). */
export interface MockPing {
  lat: number;
  lon: number;
  /** 1..50 */
  headcount: number;
  /** Comma list from mobility, medical, oxygen, infant, elderly, pets, language. */
  needs: string;
  /** <= 500 chars; kept with the request (not deleted at close), so no names or addresses. */
  note: string;
  /** Optional first text report for the intake agent to read ('' = none). */
  report: string;
}

/**
 * Incident command. Subscribe to everything the responder does plus
 * ops_flag and event_log (commander scope sees all rows).
 */
export interface CommandSource extends Store<CommandSnapshot> {
  readonly capabilities: CommandCapabilities;
  /** set_sim (keeps the current speed) */
  setRunning(running: boolean): Promise<void>;
  /** set_sim (keeps running/paused); speed in (0, 600]. Rejects unless capabilities.speed. */
  setSpeed(speed: number): Promise<void>;
  /** set_weather (locks the wind to manual until release_weather_lock) */
  setWeather(windSpeedMps: number, windFromDeg: number, gustMps: number): Promise<void>;
  /** release_weather_lock. Rejects unless capabilities.releaseWind. */
  releaseWeatherLock(): Promise<void>;
  /** override_assignment (stationId 0 unpins) */
  overrideAssignment(requestId: bigint, stationId: number, note: string): Promise<void>;
  /**
   * SIM-ONLY unit management (the backend can pin a station, not a unit, and
   * has no stop-order field). A live version needs a reducer such as
   * `assign_unit(requestId, unitId)` plus queue_entry position pins.
   */
  assignToUnit(requestId: bigint, unitId: number): Promise<void>;
  setUnitOrder(unitId: number, requestIds: bigint[]): Promise<void>;
  releaseUnit(unitId: number): Promise<void>;
  /** flag_request */
  flagRequest(requestId: bigint, kind: FlagKind, detail: string): Promise<void>;
  /** resolve_flag */
  resolveFlag(flagId: bigint, resolution: string): Promise<void>;
  /** submit_mock_requests, 1..25 at a time. Rejects unless capabilities.mockPings. */
  sendMockPings(pings: MockPing[]): Promise<void>;
  /** message_resident (1..1000 chars). Rejects unless capabilities.messaging. */
  messageResident(requestId: bigint, text: string): Promise<void>;
  /**
   * Transfer suggestions from the delegation agent. No backend table yet:
   * a live implementation would ask the delegation agent over uAgents.
   */
  recommendations(): Recommendation[];
  /**
   * What-if ranking for a draft policy. No backend equivalent: the README's
   * design sends what-if requests to the agents over uAgents, not via the DB.
   */
  previewPlan(policy: PlanPolicy, weather: WeatherInput, pins: PositionPin[]): Promise<PlanPreview>;
  /** Apply a reviewed draft. Weather goes through set_weather; policy + position pins have no reducer yet. */
  applyPlan(policy: PlanPolicy, weather: WeatherInput, pins: PositionPin[], reason: string): Promise<void>;
}

export type WeatherInput = Pick<Weather, 'windSpeedMps' | 'windFromDeg' | 'gustMps'>;
