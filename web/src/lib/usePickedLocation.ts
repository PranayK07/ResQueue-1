import { useEffect, useRef, useState } from 'react';
import { coordsPlace, reverseGeocode, type Place } from './geo';
import type { CallerLocation } from './request';

/** Editable location for the correction screens: pin drops are reverse-geocoded. */
export function usePickedLocation(initial: CallerLocation | null) {
  const [location, setLocation] = useState<CallerLocation | null>(initial);
  const [lookingUp, setLookingUp] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const entrance = location?.entrance ?? '';

  /** Drop the pin at a coordinate and look up its address. */
  function pick(lat: number, lon: number): Promise<Place> {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setLocation({ ...coordsPlace(lat, lon), street: 'Finding address…', area: '', entrance });
    setLookingUp(true);
    return reverseGeocode(lat, lon, ctrl.signal)
      .catch(() => coordsPlace(lat, lon))
      .then(place => {
        if (!ctrl.signal.aborted) {
          setLocation({ ...place, entrance });
          setLookingUp(false);
        }
        return place;
      });
  }

  /** Use a searched address as-is. */
  function choose(place: Place) {
    abortRef.current?.abort();
    setLookingUp(false);
    setLocation({ ...place, entrance });
  }

  function setEntrance(value: string) {
    setLocation(l => (l ? { ...l, entrance: value } : l));
  }

  return { location, lookingUp, pick, choose, setEntrance };
}
