// Errors from reducer calls, and the module's SenderError text mapped to UI copy (spec section 3).

export type CallErrorKind = 'sender' | 'not_live' | 'disconnected' | 'unknown_result' | 'internal';

/** What call() rejects with. For kind "sender", message is the module's exact text. */
export class CallError extends Error {
  constructor(
    message: string,
    readonly kind: CallErrorKind,
    readonly reducer: string
  ) {
    super(message);
    this.name = 'CallError';
  }
}

export type MappedError =
  | { kind: 'outside_area'; copy: string }
  /** No error to show: load the existing card. */
  | { kind: 'already_active'; requestId: bigint; copy: '' }
  | { kind: 'field'; field: 'headcount' | 'note'; copy: string }
  | { kind: 'bad_passcode'; copy: string }
  | { kind: 'closed'; copy: string }
  | { kind: 'no_assignment'; copy: string }
  /** The identity has no operator row (for example after the scenario was reloaded). */
  | { kind: 'not_operator'; copy: string }
  /** Nothing was sent: not connected. */
  | { kind: 'not_sent'; copy: string }
  /** The socket dropped mid-call; it may or may not have run. */
  | { kind: 'maybe_sent'; copy: string }
  /** Anything else: show the raw text in a toast, and never retry automatically. */
  | { kind: 'toast'; copy: string };

export function mapServerError(raw: string): MappedError {
  const msg = raw.trim();
  if (msg === 'location is outside the active incident area') {
    return { kind: 'outside_area', copy: "You're outside the active incident area." };
  }
  const active = /^you already have an active request \(#(\d+)\)$/.exec(msg);
  if (active) return { kind: 'already_active', requestId: BigInt(active[1]!), copy: '' };
  if (msg === 'headcount must be 1..50') return { kind: 'field', field: 'headcount', copy: 'Enter between 1 and 50 people.' };
  if (msg === 'note too long (max 500 chars)') return { kind: 'field', field: 'note', copy: 'Keep it under 500 characters.' };
  if (msg === 'bad passcode') return { kind: 'bad_passcode', copy: 'Wrong passcode.' };
  if (msg === 'not your request' || msg === 'request is closed') {
    return { kind: 'closed', copy: 'This request is already closed.' };
  }
  if (/ has no pending assignment$/.test(msg)) {
    return { kind: 'no_assignment', copy: 'No assignment to start. The line may have changed.' };
  }
  if (msg === 'requires commander') return { kind: 'not_operator', copy: 'Your sign-in is no longer valid. Sign in again.' };
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
