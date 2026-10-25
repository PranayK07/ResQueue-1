// Row types for every table and view the UI reads, inferred from the
// generated per-table schemas. Import row types from here, not from
// module_bindings/types: CLI 2.13.0 generates the view types there
// (MyRequests, OpsRequest, OpsQueue, OpsTravel, OpsFlag) as empty objects.
import type { Infer } from 'spacetimedb';
import type AgentSchema from '@/module_bindings/agent_table';
import type EventLogSchema from '@/module_bindings/event_log_table';
import type FireCellSchema from '@/module_bindings/fire_cell_table';
import type ForecastCellSchema from '@/module_bindings/forecast_cell_table';
import type ForecastMetaSchema from '@/module_bindings/forecast_meta_table';
import type GridSchema from '@/module_bindings/grid_table';
import type MyRequestsSchema from '@/module_bindings/my_requests_table';
import type OpsFlagSchema from '@/module_bindings/ops_flag_table';
import type OpsQueueSchema from '@/module_bindings/ops_queue_table';
import type OpsRequestSchema from '@/module_bindings/ops_request_table';
import type OpsTravelSchema from '@/module_bindings/ops_travel_table';
import type RoadClosureSchema from '@/module_bindings/road_closure_table';
import type SimClockSchema from '@/module_bindings/sim_clock_table';
import type StationSchema from '@/module_bindings/station_table';
import type UnitSchema from '@/module_bindings/unit_table';
import type WeatherSchema from '@/module_bindings/weather_table';
import type WorldVersionSchema from '@/module_bindings/world_version_table';

export type AgentRow = Infer<typeof AgentSchema>;
export type EventLogRow = Infer<typeof EventLogSchema>;
export type FireCellRow = Infer<typeof FireCellSchema>;
export type ForecastCellRow = Infer<typeof ForecastCellSchema>;
export type ForecastMetaRow = Infer<typeof ForecastMetaSchema>;
export type GridRow = Infer<typeof GridSchema>;
export type RoadClosureRow = Infer<typeof RoadClosureSchema>;
export type SimClockRow = Infer<typeof SimClockSchema>;
export type StationRow = Infer<typeof StationSchema>;
export type UnitRow = Infer<typeof UnitSchema>;
export type WeatherRow = Infer<typeof WeatherSchema>;
export type WorldVersionRow = Infer<typeof WorldVersionSchema>;

/** my_requests: the resident's own card(s). */
export type ResidentCard = Infer<typeof MyRequestsSchema>;
/** ops_request: help_request rows the signed-in operator may see. */
export type OpsRequestRow = Infer<typeof OpsRequestSchema>;
/** ops_queue: queue_entry rows (commander: all; responder: own station). */
export type OpsQueueRow = Infer<typeof OpsQueueSchema>;
/** ops_travel: travel_estimate rows (commander only). */
export type OpsTravelRow = Infer<typeof OpsTravelSchema>;
/** ops_flag: flag rows (commander only). */
export type OpsFlagRow = Infer<typeof OpsFlagSchema>;

/** Public tables, by wire name. */
export type TableRows = {
  sim_clock: SimClockRow;
  grid: GridRow;
  weather: WeatherRow;
  station: StationRow;
  unit: UnitRow;
  fire_cell: FireCellRow;
  forecast_cell: ForecastCellRow;
  forecast_meta: ForecastMetaRow;
  world_version: WorldVersionRow;
  road_closure: RoadClosureRow;
  event_log: EventLogRow;
  agent: AgentRow;
};

/** Role-scoped views, by wire name. */
export type ViewRows = {
  my_requests: ResidentCard;
  ops_request: OpsRequestRow;
  ops_queue: OpsQueueRow;
  ops_travel: OpsTravelRow;
  ops_flag: OpsFlagRow;
};

export type TableName = keyof TableRows;
export type ViewName = keyof ViewRows;
export type SourceName = TableName | ViewName;
export type RowOf<N extends SourceName> = N extends TableName ? TableRows[N] : N extends ViewName ? ViewRows[N] : never;
