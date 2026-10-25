import { describe, expect, it } from 'vitest';
import { CallError, mapCallError, mapServerError } from '@/lib/stdb/errors';

// The exact SenderError strings thrown by spacetimedb/src/index.ts.
describe('mapServerError', () => {
  it('maps the spec section 3 errors to UI copy', () => {
    expect(mapServerError('location is outside the active incident area')).toEqual({
      kind: 'outside_area',
      copy: "You're outside the active incident area.",
    });
    expect(mapServerError('bad passcode').copy).toBe('Wrong passcode.');
    expect(mapServerError('not your request')).toMatchObject({ kind: 'closed', copy: 'This request is already closed.' });
    expect(mapServerError('request is closed')).toMatchObject({ kind: 'closed' });
    expect(mapServerError('E81 has no pending assignment')).toMatchObject({
      kind: 'no_assignment',
      copy: 'No assignment to start. The line may have changed.',
    });
  });

  it('turns "already have an active request" into the request id with no error copy', () => {
    expect(mapServerError('you already have an active request (#42)')).toEqual({ kind: 'already_active', requestId: 42n, copy: '' });
  });

  it('marks field errors for inline display', () => {
    expect(mapServerError('headcount must be 1..50')).toMatchObject({ kind: 'field', field: 'headcount' });
    expect(mapServerError('note too long (max 500 chars)')).toMatchObject({ kind: 'field', field: 'note' });
  });

  it('passes anything else through raw for a toast', () => {
    expect(mapServerError('station 9 not found')).toEqual({ kind: 'toast', copy: 'station 9 not found' });
  });
});

describe('mapCallError', () => {
  it('distinguishes not sent, maybe sent and server errors', () => {
    expect(mapCallError(new CallError('x', 'not_live', 'set_sim')).kind).toBe('not_sent');
    expect(mapCallError(new CallError('x', 'disconnected', 'set_sim')).kind).toBe('not_sent');
    expect(mapCallError(new CallError('x', 'unknown_result', 'set_sim')).kind).toBe('maybe_sent');
    expect(mapCallError(new CallError('bad passcode', 'sender', 'claim_operator')).copy).toBe('Wrong passcode.');
    expect(mapCallError(new Error('boom'))).toEqual({ kind: 'toast', copy: 'boom' });
  });
});
