// The reducers the web app may call, by their snake_case module names. Agent-only and seed-only reducers
// (register_agent, publish_*, load_scenario, unit_en_route, ...) are deliberately missing: a commander identity
// could otherwise call them from here.

import type {
  AssignToUnitParams,
  ClaimOperatorParams,
  CloseMyRequestParams,
  CompleteMissionParams,
  CrewHeartbeatParams,
  DeclineMissionParams,
  ExtendConsentParams,
  FlagRequestParams,
  MessageResidentParams,
  OverrideAssignmentParams,
  PingNewsParams,
  ReleaseWeatherLockParams,
  ReplyToResponderParams,
  ResolveFlagParams,
  SetSimParams,
  SetWeatherParams,
  SubmitHelpRequestParams,
  SubmitMockRequestsParams,
  SubmitReportParams,
  UpdateMyLocationParams,
  UpdateMyRequestParams,
} from '../module_bindings/types/reducers';
import { connection } from './connection';
import { CallError, errorCopy } from './errors';

/** Arguments are the generated camelCase params; u64 ids are bigint. Zero-argument reducers take {}. */
export type ReducerArgs = {
  assign_to_unit: AssignToUnitParams;
  update_my_request: UpdateMyRequestParams;
  claim_operator: ClaimOperatorParams;
  submit_help_request: SubmitHelpRequestParams;
  close_my_request: CloseMyRequestParams;
  extend_consent: ExtendConsentParams;
  submit_report: SubmitReportParams;
  reply_to_responder: ReplyToResponderParams;
  update_my_location: UpdateMyLocationParams;
  message_resident: MessageResidentParams;
  set_sim: SetSimParams;
  set_weather: SetWeatherParams;
  release_weather_lock: ReleaseWeatherLockParams;
  override_assignment: OverrideAssignmentParams;
  flag_request: FlagRequestParams;
  resolve_flag: ResolveFlagParams;
  submit_mock_requests: SubmitMockRequestsParams;
  crew_heartbeat: CrewHeartbeatParams;
  complete_mission: CompleteMissionParams;
  decline_mission: DeclineMissionParams;
  ping_news: PingNewsParams;
};

export type ReducerName = keyof ReducerArgs;

/** A call that hasn't settled by now is treated as "may or may not have run". */
const CALL_TIMEOUT_MS = 15_000;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toCallError(e: unknown, reducer: string): CallError {
  const message = e instanceof Error ? e.message : String(e);
  switch (e instanceof Error ? e.name : '') {
    case 'SenderError':
      return new CallError(message, 'sender', reducer, e);
    case 'DisconnectedError':
      return new CallError('Not connected. Nothing was sent.', 'disconnected', reducer, e);
    case 'UnknownCallResultError':
      return new CallError('The connection dropped while sending; it may or may not have run.', 'unknown_result', reducer, e);
    default:
      return new CallError(message, 'internal', reducer, e);
  }
}

/**
 * Call a reducer, e.g. call('submit_help_request', { lat, lon, headcount, needs, note, consentMinutes: 60 }).
 * Resolves once the server committed it, and the rows already show the change. Rejects with a CallError: kind
 * 'sender' carries the module's exact text. Refused (kind 'not_live') unless the connection is live; a call with
 * no answer within 15 s rejects as 'unknown_result'.
 */
export async function call<N extends ReducerName>(name: N, args: ReducerArgs[N]): Promise<void> {
  const conn = connection.liveConnection();
  if (!conn) throw new CallError('Not connected. Nothing was sent.', 'not_live', name);
  const reducers = conn.reducers as unknown as Record<string, ((a: object) => Promise<void>) | undefined>;
  const fn = reducers[camel(name)];
  if (typeof fn !== 'function') throw new CallError(`Unknown reducer ${name}`, 'internal', name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CallError('No answer from the server; it may or may not have gone through.', 'unknown_result', name)),
      CALL_TIMEOUT_MS
    );
  });
  try {
    // Bad arguments throw synchronously inside the SDK; inside this try they become a rejection like any other.
    await Promise.race([fn(args), timeout]);
  } catch (e) {
    throw e instanceof CallError ? e : toCallError(e, name);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * call(), but the rejection's message is UI copy (errorCopy), for screens that print e.message. The kind and reducer
 * stay on the CallError, and the original error is its cause.
 */
export async function callWithCopy<N extends ReducerName>(name: N, args: ReducerArgs[N]): Promise<void> {
  try {
    await call(name, args);
  } catch (e) {
    throw new CallError(errorCopy(e), e instanceof CallError ? e.kind : 'internal', name, e);
  }
}
