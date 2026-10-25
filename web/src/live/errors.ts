// Errors from reducer calls, and the module's SenderError text (spacetimedb/src/index.ts) mapped to UI copy.

export type CallErrorKind = 'sender' | 'not_live' | 'disconnected' | 'unknown_result' | 'internal';

/** What call() rejects with. For kind 'sender', message is the module's exact text. */
export class CallError extends Error {
  readonly kind: CallErrorKind;
  readonly reducer: string;

  constructor(message: string, kind: CallErrorKind, reducer: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'CallError';
    this.kind = kind;
    this.reducer = reducer;
  }
}

export type MappedError =
  | { kind: 'outside_area'; copy: string }
  /** Not an error to show: load the existing card instead. */
  | { kind: 'already_active'; requestId: bigint; copy: '' }
  | { kind: 'field'; field: 'headcount' | 'note' | 'text' | 'message' | 'media' | 'location' | 'speed' | 'wind' | 'count'; copy: string }
  | { kind: 'bad_passcode'; copy: string }
  | { kind: 'closed'; copy: string }
  /** The request, unit, station, flag or closure no longer exists (usually: the scenario was reloaded). */
  | { kind: 'not_found'; copy: string }
  | { kind: 'no_assignment'; copy: string }
  /** The identity has no operator row (e.g. after the scenario was reloaded): sign in again. */
  | { kind: 'not_operator'; copy: string }
  /** Signed in, but not allowed (another station's request, an agent-only call). */
  | { kind: 'not_allowed'; copy: string }
  | { kind: 'limit'; copy: string }
  /** Nothing was sent: not connected. */
  | { kind: 'not_sent'; copy: string }
  /** The socket dropped mid-call; it may or may not have run. */
  | { kind: 'maybe_sent'; copy: string }
  /** Anything else: show the text as is, and never retry automatically. */
  | { kind: 'toast'; copy: string };

const EXACT: Record<string, MappedError> = {
  'location is outside the active incident area': { kind: 'outside_area', copy: "You're outside the active incident area." },
  'invalid location': { kind: 'field', field: 'location', copy: "That location isn't valid." },
  'lat/lon out of range': { kind: 'field', field: 'location', copy: "That location isn't valid." },
  'headcount must be 1..50': { kind: 'field', field: 'headcount', copy: 'Enter between 1 and 50 people.' },
  'note too long (max 500 chars)': { kind: 'field', field: 'note', copy: 'Keep it under 500 characters.' },
  'text too long (max 4000 chars)': { kind: 'field', field: 'text', copy: 'Keep it under 4,000 characters.' },
  'empty report': { kind: 'field', field: 'text', copy: 'Write something first.' },
  'media must be https URLs': { kind: 'field', field: 'media', copy: 'Attachments must be https links.' },
  'at most 8 video frames': { kind: 'field', field: 'media', copy: 'Attach at most 8 video frames.' },
  'message must be 1..1000 chars': { kind: 'field', field: 'message', copy: 'Messages must be 1 to 1,000 characters.' },
  'speed must be in (0, 600]': { kind: 'field', field: 'speed', copy: 'Speed must be above 0 and at most 600x.' },
  'wind speed out of range': { kind: 'field', field: 'wind', copy: 'Wind speed must be under 80 m/s.' },
  'bad passcode': { kind: 'bad_passcode', copy: 'Wrong passcode.' },
  'not your request': { kind: 'closed', copy: 'This request is already closed.' },
  'request is closed': { kind: 'closed', copy: 'This request is already closed.' },
  'request closed during assessment': { kind: 'closed', copy: 'This request is already closed.' },
  'no mission to decline': { kind: 'no_assignment', copy: 'There is no mission to decline.' },
  'requires commander': { kind: 'not_operator', copy: 'Your sign-in is no longer valid. Sign in again.' },
  'requires an operator or a registered agent': { kind: 'not_operator', copy: 'Sign in as an operator first.' },
  "requires a signed-in responder of the request's station (or the incident commander)": {
    kind: 'not_allowed',
    copy: "Only incident command or the crew of this request's station can do that.",
  },
  'not a registered agent': { kind: 'not_allowed', copy: 'Only the agents can do that.' },
  'too many reports on this request': { kind: 'limit', copy: 'This request already has as many reports as it can hold.' },
  'too many messages on this request': { kind: 'limit', copy: 'This conversation has reached its message limit.' },
};

const NOT_FOUND: Record<string, string> = {
  request: 'This request no longer exists. The scenario may have been reloaded.',
  unit: 'That unit no longer exists. The scenario may have been reloaded.',
  station: 'That station no longer exists. The scenario may have been reloaded.',
  flag: 'That flag no longer exists.',
  closure: 'That road closure no longer exists.',
};

export function mapServerError(raw: string): MappedError {
  const msg = raw.trim();
  const exact = EXACT[msg];
  if (exact) return exact;
  const active = /^you already have an active request \(#(\d+)\)$/.exec(msg);
  if (active) return { kind: 'already_active', requestId: BigInt(active[1]), copy: '' };
  const missing = /^(request|unit|station|flag|closure) \d+ not found$/.exec(msg);
  if (missing) return { kind: 'not_found', copy: NOT_FOUND[missing[1]] };
  if (/ has no pending assignment$/.test(msg)) return { kind: 'no_assignment', copy: 'No assignment to start. The line may have changed.' };
  if (/^send 1\.\.\d+ mock pings at a time$/.test(msg)) return { kind: 'field', field: 'count', copy: 'Send 1 to 25 mock pings at a time.' };
  if (msg.startsWith('requires agent role:')) return { kind: 'not_allowed', copy: 'Only the agents can do that.' };
  return { kind: 'toast', copy: msg };
}

export function mapCallError(e: unknown): MappedError {
  if (e instanceof CallError) {
    switch (e.kind) {
      case 'sender':
        return mapServerError(e.message);
      case 'not_live':
      case 'disconnected':
        return { kind: 'not_sent', copy: 'No connection. Nothing was sent.' };
      case 'unknown_result':
        return { kind: 'maybe_sent', copy: 'The connection dropped while sending. Check before trying again.' };
      case 'internal':
        return { kind: 'toast', copy: e.message };
    }
  }
  return { kind: 'toast', copy: e instanceof Error ? e.message : String(e) };
}

/** One line of UI copy for any rejection. */
export function errorCopy(e: unknown): string {
  const m = mapCallError(e);
  if (m.kind === 'already_active') return `You already have an active request (#${m.requestId}).`;
  return m.copy || 'Something went wrong. Try again.';
}
