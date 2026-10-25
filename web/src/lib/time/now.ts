import { useCallback, useSyncExternalStore } from 'react';

// One shared interval per period, however many components read the time.
type Ticker = { now: number; listeners: Set<() => void>; id?: ReturnType<typeof setInterval> };
const tickers = new Map<number, Ticker>();
const noop = () => {};

function ticker(intervalMs: number): Ticker {
  let t = tickers.get(intervalMs);
  if (!t) {
    t = { now: Date.now(), listeners: new Set() };
    tickers.set(intervalMs, t);
  }
  return t;
}

function subscribeTicker(intervalMs: number, onTick: () => void): () => void {
  const t = ticker(intervalMs);
  t.listeners.add(onTick);
  if (t.id === undefined) {
    t.now = Date.now();
    t.id = setInterval(() => {
      t.now = Date.now();
      t.listeners.forEach(l => l());
    }, intervalMs);
  }
  return () => {
    t.listeners.delete(onTick);
    if (t.listeners.size === 0 && t.id !== undefined) {
      clearInterval(t.id);
      t.id = undefined;
    }
  };
}

/** Wall-clock ms, re-rendering every intervalMs. Pass null to pause (returns 0). */
export function useNow(intervalMs: number | null = 1000): number {
  const subscribe = useCallback(
    (onTick: () => void) => (intervalMs === null ? noop : subscribeTicker(intervalMs, onTick)),
    [intervalMs]
  );
  const getSnapshot = useCallback(() => (intervalMs === null ? 0 : ticker(intervalMs).now), [intervalMs]);
  return useSyncExternalStore(subscribe, getSnapshot);
}
