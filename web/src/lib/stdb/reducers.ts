import { useCallback, useRef, useState } from 'react';
import type {
  AddRoadClosureParams,
  ClaimOperatorParams,
  CloseMyRequestParams,
  CompleteMissionParams,
  DeclineMissionParams,
  ExtendConsentParams,
  FlagRequestParams,
  OverrideAssignmentParams,
  ReleaseWeatherLockParams,
  ResolveFlagParams,
  SetRoadClosureActiveParams,
  SetSimParams,
  SetWeatherParams,
  SubmitHelpRequestParams,
  UnitAvailableParams,
  UnitEnRouteParams,
  UnitOnSceneParams,
} from '@/module_bindings/types/reducers';
import { connection } from './connection';
import { CallError, mapCallError, type MappedError } from './errors';
import { useConnection } from './hooks';

/**
 * The reducers the UI may call (spec section 4, shapes). Agent-only and
 * seed-only reducers (register_agent, publish_*, load_scenario, ...) are
 * deliberately missing, so they can't be called from here.
 */
export type ReducerArgs = {
  submit_help_request: SubmitHelpRequestParams;
  close_my_request: CloseMyRequestParams;
  extend_consent: ExtendConsentParams;
  claim_operator: ClaimOperatorParams;
  set_weather: SetWeatherParams;
  release_weather_lock: ReleaseWeatherLockParams;
  set_sim: SetSimParams;
  add_road_closure: AddRoadClosureParams;
  set_road_closure_active: SetRoadClosureActiveParams;
  override_assignment: OverrideAssignmentParams;
  flag_request: FlagRequestParams;
  resolve_flag: ResolveFlagParams;
  unit_en_route: UnitEnRouteParams;
  unit_on_scene: UnitOnSceneParams;
  complete_mission: CompleteMissionParams;
  decline_mission: DeclineMissionParams;
  unit_available: UnitAvailableParams;
};

export type ReducerName = keyof ReducerArgs;

/** A call that hasn't settled by now is treated as "may or may not have run". */
const CALL_TIMEOUT_MS = 15_000;

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function toCallError(e: unknown, reducer: string): CallError {
  const message = e instanceof Error ? e.message : String(e);
  switch (e instanceof Error ? e.name : '') {
    case 'SenderError':
      return new CallError(message, 'sender', reducer);
    case 'DisconnectedError':
      return new CallError('Not connected. Nothing was sent.', 'disconnected', reducer);
    case 'UnknownCallResultError':
      return new CallError('The connection dropped while sending; it may or may not have run.', 'unknown_result', reducer);
    default:
      return new CallError(message, 'internal', reducer);
  }
}

/**
 * Calls a reducer by its snake_case name with the shapes' field names, e.g.
 * call('submit_help_request', { lat, lon, headcount, needs, note, consentMinutes }).
 * Resolves once committed (the rows already show the change); rejects with a
 * CallError whose message is the server's text. Refused unless live.
 */
export async function call<N extends ReducerName>(name: N, args: ReducerArgs[N]): Promise<void> {
  const conn = connection.liveConnection();
  if (!conn) throw new CallError('Not connected. Nothing was sent.', 'not_live', name);
  const reducers = conn.reducers as unknown as Record<string, ((a: object) => Promise<void>) | undefined>;
  const key = camel(name);
  if (typeof reducers[key] !== 'function') throw new CallError(`Unknown reducer ${name}`, 'internal', name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CallError('No answer from the server; it may or may not have gone through.', 'unknown_result', name)),
      CALL_TIMEOUT_MS
    );
  });
  try {
    await Promise.race([reducers[key]!(args), timeout]);
  } catch (e) {
    throw e instanceof CallError ? e : toCallError(e, name);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * call() for components: pending state, mapped error copy, and repeat taps
 * ignored while a call is in flight. run() resolves true on success and never throws.
 */
export function useCall<N extends ReducerName>(name: N) {
  const { canCall } = useConnection();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<MappedError | null>(null);
  const inFlight = useRef<Promise<boolean> | null>(null);

  const run = useCallback(
    (args: ReducerArgs[N]): Promise<boolean> => {
      if (inFlight.current) return inFlight.current;
      setPending(true);
      setError(null);
      const p = call(name, args)
        .then(
          () => true,
          (e: unknown) => {
            setError(mapCallError(e));
            return false;
          }
        )
        .finally(() => {
          inFlight.current = null;
          setPending(false);
        });
      inFlight.current = p;
      return p;
    },
    [name]
  );

  const clearError = useCallback(() => setError(null), []);
  return { run, pending, error, clearError, disabled: pending || !canCall };
}
