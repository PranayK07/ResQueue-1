// Every table and view the web app reads, by wire name: row types, the camelCase accessor on conn.db, and which
// ones each surface subscribes to. Views subscribe like tables. Private tables (help_request, queue_entry,
// operator, ...) are never queried; the client sees them only through the views.
//
// Row types come from the per-table schemas: CLI 2.13.0 generates the view types in module_bindings/types.ts
// (OpsRequest, MyRequests, ...) as empty objects, which accept anything.

import type { Infer } from 'spacetimedb';
import type { DbConnection } from '../module_bindings';
import type AgentRow from '../module_bindings/agent_table';
import type CrewPresenceRow from '../module_bindings/crew_presence_table';
import type EventLogRow from '../module_bindings/event_log_table';
import type FireCellRow from '../module_bindings/fire_cell_table';
import type FireConcernRow from '../module_bindings/fire_concern_table';
import type FireRiskCellRow from '../module_bindings/fire_risk_cell_table';
import type FireRiskMetaRow from '../module_bindings/fire_risk_meta_table';
import type ForecastCellRow from '../module_bindings/forecast_cell_table';
import type ForecastMetaRow from '../module_bindings/forecast_meta_table';
import type GridRow from '../module_bindings/grid_table';
import type IncidentRow from '../module_bindings/incident_table';
import type MyOperatorRow from '../module_bindings/my_operator_table';
import type MyRequestsRow from '../module_bindings/my_requests_table';
import type MyRiskRow from '../module_bindings/my_risk_table';
import type NewsArticleRow from '../module_bindings/news_article_table';
import type NewsFocusRow from '../module_bindings/news_focus_table';
import type OpsAssessmentRow from '../module_bindings/ops_assessment_table';
import type OpsFlagRow from '../module_bindings/ops_flag_table';
import type OpsMessageRow from '../module_bindings/ops_message_table';
import type OpsQueueRow from '../module_bindings/ops_queue_table';
import type OpsReportRow from '../module_bindings/ops_report_table';
import type OpsRequestRow from '../module_bindings/ops_request_table';
import type OpsRiskRow from '../module_bindings/ops_risk_table';
import type OpsTravelRow from '../module_bindings/ops_travel_table';
import type OpsUnitRouteRow from '../module_bindings/ops_unit_route_table';
import type RiskPipelineRow from '../module_bindings/risk_pipeline_table';
import type ReplayObservationRow from '../module_bindings/replay_observation_table';
import type RoadClosureRow from '../module_bindings/road_closure_table';
import type SimClockRow from '../module_bindings/sim_clock_table';
import type SituationRow from '../module_bindings/situation_table';
import type StationRow from '../module_bindings/station_table';
import type UnitRow from '../module_bindings/unit_table';
import type WeatherRow from '../module_bindings/weather_table';
import type WorldVersionRow from '../module_bindings/world_version_table';

type Schemas = {
  sim_clock: typeof SimClockRow;
  grid: typeof GridRow;
  station: typeof StationRow;
  unit: typeof UnitRow;
  weather: typeof WeatherRow;
  fire_cell: typeof FireCellRow;
  fire_concern: typeof FireConcernRow;
  forecast_cell: typeof ForecastCellRow;
  forecast_meta: typeof ForecastMetaRow;
  world_version: typeof WorldVersionRow;
  road_closure: typeof RoadClosureRow;
  incident: typeof IncidentRow;
  news_focus: typeof NewsFocusRow;
  situation: typeof SituationRow;
  news_article: typeof NewsArticleRow;
  event_log: typeof EventLogRow;
  agent: typeof AgentRow;
  crew_presence: typeof CrewPresenceRow;
  risk_pipeline: typeof RiskPipelineRow;
  replay_observation: typeof ReplayObservationRow;
  fire_risk_meta: typeof FireRiskMetaRow;
  fire_risk_cell: typeof FireRiskCellRow;
  my_operator: typeof MyOperatorRow;
  my_requests: typeof MyRequestsRow;
  my_risk: typeof MyRiskRow;
  ops_request: typeof OpsRequestRow;
  ops_queue: typeof OpsQueueRow;
  ops_travel: typeof OpsTravelRow;
  ops_unit_route: typeof OpsUnitRouteRow;
  ops_flag: typeof OpsFlagRow;
  ops_report: typeof OpsReportRow;
  ops_assessment: typeof OpsAssessmentRow;
  ops_message: typeof OpsMessageRow;
  ops_risk: typeof OpsRiskRow;
};

export type SourceName = keyof Schemas;

/** One row of a table or view, as the client cache holds it (u64 = bigint, option = T | undefined, Timestamp). */
export type RowOf<N extends SourceName> = Infer<Schemas[N]>;

/** Wire name → accessor on conn.db (never the deprecated snake_case aliases). */
export const ACCESSOR = {
  sim_clock: 'simClock',
  grid: 'grid',
  station: 'station',
  unit: 'unit',
  weather: 'weather',
  fire_cell: 'fireCell',
  fire_concern: 'fireConcern',
  forecast_cell: 'forecastCell',
  forecast_meta: 'forecastMeta',
  world_version: 'worldVersion',
  road_closure: 'roadClosure',
  incident: 'incident',
  news_focus: 'newsFocus',
  situation: 'situation',
  news_article: 'newsArticle',
  event_log: 'eventLog',
  agent: 'agent',
  crew_presence: 'crewPresence',
  risk_pipeline: 'riskPipeline',
  replay_observation: 'replayObservation',
  fire_risk_meta: 'fireRiskMeta',
  fire_risk_cell: 'fireRiskCell',
  my_operator: 'myOperator',
  my_requests: 'myRequests',
  my_risk: 'myRisk',
  ops_request: 'opsRequest',
  ops_queue: 'opsQueue',
  ops_travel: 'opsTravel',
  ops_unit_route: 'opsUnitRoute',
  ops_flag: 'opsFlag',
  ops_report: 'opsReport',
  ops_assessment: 'opsAssessment',
  ops_message: 'opsMessage',
  ops_risk: 'opsRisk',
} as const satisfies Record<SourceName, keyof DbConnection['db']>;

export const SOURCE_NAMES = Object.keys(ACCESSOR) as SourceName[];

/** Each surface keeps its own saved identity: one resident, one commander, one login per responder phone (unit). */
export type Surface = 'caller' | 'command' | `responder:${number}`;

/**
 * `core` is one subscription and must apply before a surface is ready. Each `extra` source is its own subscription,
 * so one an older module lacks only turns that feature off.
 */
export interface QueryGroups {
  core: readonly SourceName[];
  extra: readonly SourceName[];
}

export const QUERIES: { caller: QueryGroups; command: QueryGroups; responder: QueryGroups } = {
  caller: {
    core: ['sim_clock', 'grid', 'incident', 'fire_cell', 'my_requests', 'ops_message'],
    extra: ['my_risk', 'ops_assessment'],
  },
  responder: {
    core: [
      'sim_clock', 'grid', 'station', 'unit', 'weather', 'fire_cell', 'forecast_cell', 'road_closure', 'incident', 'agent',
      'ops_request', 'ops_queue', 'ops_unit_route',
    ],
    extra: ['my_operator', 'crew_presence', 'ops_risk', 'ops_assessment', 'ops_report', 'ops_message', 'fire_risk_meta', 'fire_concern', 'risk_pipeline'],
  },
  command: {
    core: [
      'sim_clock', 'grid', 'station', 'unit', 'weather', 'fire_cell', 'forecast_cell', 'forecast_meta', 'world_version',
      'road_closure', 'incident', 'agent', 'event_log', 'ops_request', 'ops_queue', 'ops_travel', 'ops_flag', 'ops_unit_route',
    ],
    // fire_risk_cell stays off the phones: up to 40k cells x 8 horizons.
    extra: [
      'my_operator', 'crew_presence', 'risk_pipeline', 'replay_observation', 'fire_risk_meta', 'fire_risk_cell', 'situation', 'news_article',
      'ops_risk', 'ops_assessment', 'ops_report', 'ops_message',
    ],
  },
};

export const surfaceKind = (surface: Surface): keyof typeof QUERIES =>
  surface === 'caller' || surface === 'command' ? surface : 'responder';

export const groupsFor = (surface: Surface): QueryGroups => QUERIES[surfaceKind(surface)];

/** Unit id of a responder surface, or null. */
export function surfaceUnitId(surface: Surface | null): number | null {
  const m = surface ? /^responder:(\d+)$/.exec(surface) : null;
  return m ? Number(m[1]) : null;
}
