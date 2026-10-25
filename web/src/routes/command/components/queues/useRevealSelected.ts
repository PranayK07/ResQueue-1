import { useEffect, useRef } from 'react';

/**
 * Scrolls a row into view when it becomes selected (for example from the map or
 * the event log). Instant scroll, so nothing glides for reduced-motion users.
 */
export function useRevealSelected<T extends HTMLElement>(selected: boolean) {
  const ref = useRef<T>(null);
  useEffect(() => {
    // Optional call: jsdom (unit tests) has no scrollIntoView.
    if (selected) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);
  return ref;
}
