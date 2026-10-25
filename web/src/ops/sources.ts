// What the operations screens depend on. Today both are backed by the
// simulated world (./sim/world.ts). Going live means implementing these two
// interfaces over a SpacetimeDB connection; no screen code changes.
//
// Shared setup for a SpacetimeDB implementation:
//   1. Bindings: `spacetime generate --lang typescript --out-dir src/module_bindings --module-path ../spacetimedb`
//   2. `conn = DbConnection.builder().withUri(...).withModuleName('wildfire-rescue').build()`
//   3. `conn.reducers.claimOperator({ passcode, role, stationId, name })`
//      (role 'responder' + stationId, or 'commander') so the ops_* views
//      return the right scope.
//   4. Subscribe; on every insert/update/delete rebuild the snapshot from the
//      client cache (`conn.db.<table>.iter()`), converting Timestamp → ms and
//      option → null, then notify listeners. getSnapshot must return the same
//      object until something changes.

import type { CommandSnapshot, FlagKind, MissionOutcome, PlanPolicy, PositionPin, ResponderSnapshot, Weather } from './types';
import type { PlanPreview } from './sim/world';
import type { Recommendation } from './sim/planner';

interface Store<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
}

/**
 * Responder phone. Subscribe to: sim_clock, grid, station, unit, weather,
 * fire_cell, forecast_cell, road_closure, ops_request, ops_queue.
 */
export interface ResponderSource extends Store<ResponderSnapshot> {
  /** complete_mission: 'rescued' closes the request; 'aborted' returns it to the queue. */
  completeMission(unitId: number, outcome: MissionOutcome): Promise<void>;
}

/**
 * Incident command. Subscribe to everything the responder does plus
 * ops_flag and event_log (commander scope sees all rows).
 */
export interface CommandSource extends Store<CommandSnapshot> {
  /** set_sim */
  setRunning(running: boolean): Promise<void>;
  /** set_weather (locks the wind to manual until release_weather_lock) */
  setWeather(windSpeedMps: number, windFromDeg: number, gustMps: number): Promise<void>;
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
