import { useCallback, useEffect, useState } from 'react';

export type PositionState = (
  | { status: 'locating' }
  | { status: 'found'; lat: number; lon: number; accuracyM: number; fixedAt: number }
  | { status: 'denied' | 'unavailable'; message: string }
) & { source?: 'device' | 'incident' };

/** One-shot high-accuracy browser geolocation, with a retry. */
export function useCurrentPosition(enabled = true) {
  const [state, setState] = useState<PositionState>(() =>
    'geolocation' in navigator
      ? { status: 'locating' }
      : { status: 'unavailable', message: 'This browser can’t share its location.' }
  );

  const request = useCallback(() => {
    if (!enabled) return;
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition(
      pos =>
        setState({
          status: 'found',
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          fixedAt: pos.timestamp,
        }),
      err =>
        setState(
          err.code === err.PERMISSION_DENIED
            ? { status: 'denied', message: 'Location access is off for this site.' }
            : { status: 'unavailable', message: 'Couldn’t detect your location.' }
        ),
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 30_000 }
    );
  }, [enabled]);

  useEffect(() => {
    request();
  }, [request]);

  const retry = useCallback(() => {
    if (!('geolocation' in navigator)) return;
    setState({ status: 'locating' });
    request();
  }, [request]);

  return { position: state, retry };
}
