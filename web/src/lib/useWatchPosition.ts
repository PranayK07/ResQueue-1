import { useEffect, useState } from 'react';

export type WatchState =
  | { status: 'off' }
  | { status: 'locating' }
  | { status: 'tracking'; lon: number; lat: number; accuracyM: number; atMs: number }
  | { status: 'error'; message: string };

/** Continuous high-accuracy GPS while `enabled` (for turn-by-turn). */
export function useWatchPosition(enabled: boolean): WatchState {
  const [state, setState] = useState<WatchState>({ status: 'locating' });

  useEffect(() => {
    if (!enabled) return;
    if (!('geolocation' in navigator)) {
      const t = setTimeout(() => setState({ status: 'error', message: 'This browser can’t share its location.' }));
      return () => clearTimeout(t);
    }
    const id = navigator.geolocation.watchPosition(
      pos => setState({ status: 'tracking', lon: pos.coords.longitude, lat: pos.coords.latitude, accuracyM: pos.coords.accuracy, atMs: pos.timestamp }),
      err =>
        setState({
          status: 'error',
          message: err.code === err.PERMISSION_DENIED ? 'Location access is off for this site.' : 'Couldn’t get a GPS fix.',
        }),
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 20_000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  return enabled ? state : { status: 'off' };
}
