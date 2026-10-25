import { useEffect, useState } from 'react';
import { findAnchor } from './useAnchor';

export type Rect = { top: number; left: number; width: number; height: number };

const same = (a: Rect | null, b: Rect) =>
  !!a && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;

/**
 * The viewport rect of an anchor, kept current through scrolling (any
 * container), resizes and layout shifts. Null while the anchor isn't rendered.
 */
export function useAnchorRect(id: string | null): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);

  useEffect(() => {
    if (!id) {
      setRect(null);
      return;
    }
    let frame = 0;
    let el: HTMLElement | null = null;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());

    function measure() {
      frame = 0;
      if (!el || !el.isConnected) {
        ro?.disconnect();
        el = findAnchor(id!);
        if (el) ro?.observe(el);
      }
      if (!el) {
        setRect(null);
        return;
      }
      const r = el.getBoundingClientRect();
      const next = { top: r.top, left: r.left, width: r.width, height: r.height };
      setRect(prev => (same(prev, next) ? prev : next));
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(measure);
    }

    measure();
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    // Lists above an anchor can move it without resizing it; a slow poll catches that.
    const poll = setInterval(schedule, 400);
    return () => {
      cancelAnimationFrame(frame);
      ro?.disconnect();
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
      clearInterval(poll);
    };
  }, [id]);

  return rect;
}
