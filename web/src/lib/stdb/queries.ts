// Named query sets (spec section 3). Views subscribe like tables. Private
// tables (help_request, queue_entry, travel_estimate, flag, operator, timers)
// are never queried; the client sees them only through the views.
import type { DbConnection } from '@/module_bindings';
import type { SourceName, TableName } from './rows';

/** Each surface keeps its own identity token, so the three screens are three identities. */
export type Surface = 'help' | 'command' | 'crew';

export const WORLD = [
  'sim_clock',
  'grid',
  'weather',
  'station',
  'unit',
  'fire_cell',
  'forecast_cell',
  'forecast_meta',
  'world_version',
  'road_closure',
  'event_log',
  'agent',
] as const satisfies readonly TableName[];

/** The resident UI reads only my_requests, plus the clock and grid. */
export const RESIDENT = ['my_requests', 'sim_clock', 'grid'] as const satisfies readonly SourceName[];

export const COMMAND = [...WORLD, 'ops_request', 'ops_queue', 'ops_travel', 'ops_flag'] as const satisfies readonly SourceName[];

export const CREW = [
  'sim_clock',
  'grid',
  'station',
  'unit',
  'fire_cell',
  'road_closure',
  'agent',
  'ops_request',
  'ops_queue',
] as const satisfies readonly SourceName[];

/** Dev-only /_debug: every table and view. */
export const EVERYTHING = [...WORLD, 'my_requests', 'ops_request', 'ops_queue', 'ops_travel', 'ops_flag'] as const satisfies readonly SourceName[];

export const QUERY_SETS: Record<Surface, readonly SourceName[]> = {
  help: RESIDENT,
  command: COMMAND,
  crew: CREW,
};

/** Wire name to the generated camelCase accessor on conn.db. */
export const ACCESSOR = {
  sim_clock: 'simClock',
  grid: 'grid',
  weather: 'weather',
  station: 'station',
  unit: 'unit',
  fire_cell: 'fireCell',
  forecast_cell: 'forecastCell',
  forecast_meta: 'forecastMeta',
  world_version: 'worldVersion',
  road_closure: 'roadClosure',
  event_log: 'eventLog',
  agent: 'agent',
  my_requests: 'myRequests',
  ops_request: 'opsRequest',
  ops_queue: 'opsQueue',
  ops_travel: 'opsTravel',
  ops_flag: 'opsFlag',
} as const satisfies Record<SourceName, keyof DbConnection['db']>;

export const isView = (name: SourceName) => name === 'my_requests' || name.startsWith('ops_');
