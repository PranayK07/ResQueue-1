import { Timestamp } from 'spacetimedb';
import { describe, expect, it } from 'vitest';
import { formatClock, formatT, minsFromNow, simNowAt, tsToDate, tsToMs } from '@/lib/time/sim';

const ts = (ms: number) => new Timestamp(BigInt(ms) * 1000n);
const T0 = 1_800_000_000_000;
const clock = (over: Partial<{ simS: number; speed: number; running: boolean; lastTickMs: number }> = {}) => ({
  simS: over.simS ?? 1000,
  speed: over.speed ?? 30,
  running: over.running ?? true,
  lastTick: ts(over.lastTickMs ?? T0),
});

describe('simNowAt', () => {
  it('holds still while paused', () => {
    expect(simNowAt(clock({ running: false }), T0 + 3000)).toBe(1000);
  });

  it('follows the spec formula while running', () => {
    expect(simNowAt(clock(), T0)).toBe(1000);
    expect(simNowAt(clock(), T0 + 2000)).toBe(1000 + 2 * 30);
  });

  it('extrapolates at most 5 s of real time, and never backwards', () => {
    expect(simNowAt(clock(), T0 + 60_000)).toBe(1000 + 5 * 30);
    expect(simNowAt(clock(), T0 - 4000)).toBe(1000);
  });

  it('measures from arrival when the device clock is ahead of the server', () => {
    // Device clock 30 s ahead: lastTick looks 30 s old the moment it arrives.
    const arrived = T0 + 30_000;
    expect(simNowAt(clock(), arrived, arrived)).toBe(1000 + 1 * 30);
    expect(simNowAt(clock(), arrived + 500, arrived)).toBe(1000 + 1.5 * 30);
  });

  it('measures from arrival when the device clock is behind the server', () => {
    const arrived = T0 - 30_000;
    expect(simNowAt(clock(), arrived, arrived)).toBe(1000);
    expect(simNowAt(clock(), arrived + 2000, arrived)).toBe(1000 + 2 * 30);
  });

  it('credits normal transit time like the spec formula', () => {
    const arrived = T0 + 120;
    expect(simNowAt(clock(), arrived + 880, arrived)).toBeCloseTo(simNowAt(clock(), T0 + 1000), 9);
  });
});

describe('time helpers', () => {
  it('minsFromNow is (s - simS) / 60', () => {
    expect(minsFromNow(1600, 1000)).toBe(10);
    expect(minsFromNow(700, 1000)).toBe(-5);
  });

  it('formatT shows mm:ss, and hours past the first hour', () => {
    expect(formatT(0)).toBe('T+00:00');
    expect(formatT(65.9)).toBe('T+01:05');
    expect(formatT(3599)).toBe('T+59:59');
    expect(formatT(3600)).toBe('T+1:00:00');
    expect(formatT(19_906.4)).toBe('T+5:31:46');
    expect(formatT(-5)).toBe('T+00:00');
  });

  it('converts Timestamps without Number() on the raw micros', () => {
    expect(tsToMs(ts(T0))).toBe(T0);
    expect(tsToDate(ts(T0)).getTime()).toBe(T0);
  });

  it('formatClock pads hours and minutes', () => {
    const d = new Date(2026, 9, 24, 7, 5, 9).getTime();
    expect(formatClock(d)).toBe('07:05');
    expect(formatClock(d, true)).toBe('07:05:09');
  });
});
