import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { MonoTag } from '@/lib/ui/MonoTag';
import type { Rect } from './useAnchorRect';

type Tag = { key: string; id: string; rect: Rect };

/** True when the URL has ?anchors=1. */
export function anchorsOverlayRequested(search: string): boolean {
  return new URLSearchParams(search).get('anchors') === '1';
}

/** Dev and pitch aid: every anchor's mono tag drawn over its element, like Jimo's element catalog. */
export function AnchorOverlay() {
  const [tags, setTags] = useState<Tag[]>([]);

  useEffect(() => {
    let frame = 0;
    function read() {
      frame = 0;
      const out: Tag[] = [];
      document.querySelectorAll<HTMLElement>('[data-guide]').forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const id = el.dataset.guide ?? '';
        out.push({ key: `${id}:${i}`, id, rect: { top: r.top, left: r.left, width: r.width, height: r.height } });
      });
      setTags(out);
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(read);
    };
    read();
    const poll = setInterval(schedule, 500);
    window.addEventListener('scroll', schedule, true);
    window.addEventListener('resize', schedule);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(poll);
      window.removeEventListener('scroll', schedule, true);
      window.removeEventListener('resize', schedule);
    };
  }, []);

  return createPortal(
    <div aria-hidden className="pointer-events-none fixed inset-0 z-[90]">
      {tags.map(t => (
        <div
          key={t.key}
          className="fixed rounded-md outline-1 outline-guide/60 outline-dashed"
          style={{ top: t.rect.top, left: t.rect.left, width: t.rect.width, height: t.rect.height }}
        >
          <MonoTag tone="guide" className="absolute -top-2.5 left-1 bg-background/90">
            {t.id}
          </MonoTag>
        </div>
      ))}
    </div>,
    document.body
  );
}
