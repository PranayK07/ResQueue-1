import { Timestamp } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { isEscalated, toLevel } from '@/lib/domain/levels';
import { joinNeeds, parseNeeds } from '@/lib/domain/needs';
import { isActiveStatus, isAgentOnline, isClosedStatus, isLockedStatus, requestStatusLabel } from '@/lib/domain/status';

describe('needs', () => {
  it('mirrors cleanNeeds: trim, lowercase, drop unknowns, dedupe, keep order', () => {
    expect(parseNeeds(' Medical, mobility,unicorn,medical ,PETS')).toEqual(['medical', 'mobility', 'pets']);
    expect(parseNeeds('')).toEqual([]);
    expect(joinNeeds(['oxygen', 'oxygen', 'language', 'nope'])).toBe('oxygen,language');
  });
});

describe('statuses', () => {
  it('splits active, locked and closed like the module', () => {
    expect(['pending', 'queued', 'assigned', 'en_route', 'on_scene'].every(isActiveStatus)).toBe(true);
    expect(['assigned', 'en_route', 'on_scene'].every(isLockedStatus)).toBe(true);
    expect(isLockedStatus('queued')).toBe(false);
    expect(['rescued', 'not_found', 'safe', 'revoked', 'expired'].every(isClosedStatus)).toBe(true);
    expect(isActiveStatus('safe')).toBe(false);
  });

  it('labels known statuses and passes unknown ones through', () => {
    expect(requestStatusLabel('en_route')).toBe('En route');
    expect(requestStatusLabel('something_new')).toBe('something_new');
  });

  it('counts an agent online for 30 s after its last heartbeat', () => {
    const seen = new Timestamp(1_800_000_000_000n * 1000n);
    expect(isAgentOnline(seen, 1_800_000_000_000 + 29_999)).toBe(true);
    expect(isAgentOnline(seen, 1_800_000_000_000 + 30_000)).toBe(false);
  });
});

describe('levels', () => {
  it('reads anything unexpected as unknown', () => {
    expect(toLevel('critical')).toBe('critical');
    expect(toLevel('CRITICAL')).toBe('unknown');
    expect(isEscalated('unreachable')).toBe(true);
    expect(isEscalated('high')).toBe(false);
  });
});
