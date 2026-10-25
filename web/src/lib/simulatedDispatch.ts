// Stand-in for the SpacetimeDB round trips until client bindings exist.
// Network failure is real: if the browser is (or goes) offline mid-request,
// the call fails, so the offline/retry screens can be exercised with
// DevTools → Network → Offline.
//
// TODO(backend): replace with submit_help_request / close_my_request reducer
// calls and a my_requests subscription for receipt, assignment and ETA.

import type { Dispatch } from './request';

/** The simulated unit departs this long after assignment (demo-speed). */
export const EN_ROUTE_AFTER_MS = 15_000;

export const DEMO_DISPATCH: Dispatch = {
  station: 'S02 Canyon',
  unit: 'E21',
  queueRank: 3,
  busyMin: 4,
  travelMin: 10,
  fire: 'Pine Creek Fire',
};

export class OfflineError extends Error {
  constructor() {
    super('connection lost');
  }
}

/** Resolve after `ms`, or reject as soon as the browser reports it is offline. */
function roundTrip(ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!navigator.onLine) {
      // Still take a moment so "Sending" is visible before it fails.
      setTimeout(() => reject(new OfflineError()), 1200);
      return;
    }
    const fail = () => {
      clearTimeout(timer);
      reject(new OfflineError());
    };
    const timer = setTimeout(() => {
      window.removeEventListener('offline', fail);
      resolve();
    }, ms);
    window.addEventListener('offline', fail, { once: true });
  });
}

// Tokens the "server" has already accepted, so a retry never duplicates.
const accepted = new Set<string>();

/** Submit (or re-submit) a help request. Idempotent on `token`. */
export async function submitHelpRequest(token: string): Promise<{ duplicate: boolean }> {
  await roundTrip(1800);
  const duplicate = accepted.has(token);
  accepted.add(token);
  return { duplicate };
}

export function sendLocationUpdate(): Promise<void> {
  return roundTrip(1200);
}

export function uploadMedia(): Promise<void> {
  return roundTrip(1500);
}
