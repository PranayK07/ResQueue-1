import { motion, useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type WheelEvent } from 'react';
import { Button } from '@/lib/ui/button';
import { MonoTag } from '@/lib/ui/MonoTag';
import { cn } from '@/lib/utils';
import type { GuideMode, GuideStep } from './types';
import type { Rect } from './useAnchorRect';

const MARGIN = 12;
const GAP = 16;
const WHEEL_THRESHOLD = 20;
const WHEEL_COOLDOWN_MS = 450;

type TipCardProps = {
  step: Pick<GuideStep, 'anchor' | 'title' | 'body' | 'tryIt'>;
  index: number;
  total: number;
  rect: Rect | null;
  mode: GuideMode;
  onNext: () => void;
  onBack: () => void;
  onSkip: () => void;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

type Box = { top: number; left: number; width: number; height: number };

const overlaps = (a: Box, b: Box) =>
  a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

/** Controls that must stay uncovered (Call 911, I'm safe now, mission actions) carry data-guide-clear. */
function clearRects(): Box[] {
  return Array.from(document.querySelectorAll('[data-guide-clear]')).map(el => {
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
  });
}

/**
 * Where the card goes: beside the anchor on desktop, below or above it on
 * phones, then the top or bottom of the viewport. The first slot that fits on
 * screen and covers no data-guide-clear control wins.
 */
function place(rect: Rect | null, w: number, h: number, mode: GuideMode) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const avoid = clearRects();
  const fits = (top: number, left: number) => {
    const box = { top, left, width: w, height: h };
    return top >= MARGIN && left >= MARGIN && top + h <= vh - MARGIN && left + w <= vw - MARGIN && !avoid.some(a => overlaps(a, box));
  };
  const candidates: [number, number][] = [];
  if (rect) {
    const x = clamp(rect.left, MARGIN, vw - w - MARGIN);
    if (mode === 'step') {
      candidates.push([rect.top, rect.left + rect.width + GAP], [rect.top, rect.left - GAP - w]);
    }
    candidates.push([rect.top + rect.height + GAP, x], [rect.top - GAP - h, x]);
  }
  const cx = (vw - w) / 2;
  candidates.push([vh - h - MARGIN, cx], [MARGIN + 64, cx]);
  for (const [top, left] of candidates) {
    const t = clamp(top, MARGIN, vh - h - MARGIN);
    const l = clamp(left, MARGIN, vw - w - MARGIN);
    if (t === top && l === left && fits(t, l)) return { top: t, left: l };
  }
  return { top: clamp(vh - h - MARGIN, MARGIN, vh - h - MARGIN), left: clamp(cx, MARGIN, vw - w - MARGIN) };
}

/** The tip: anchor tag, title, body, tryIt, step dots, Back / Next / Skip. */
export function TipCard({ step, index, total, rect, mode, onNext, onBack, onSkip }: TipCardProps) {
  const ref = useRef<HTMLDivElement>(null);
  const lastWheel = useRef(0);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const reduce = useReducedMotion();
  const touch = mode === 'scroll';
  const last = index + 1 === total;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const next = place(rect, el.offsetWidth, el.offsetHeight, mode);
    setPos(p => (p && p.top === next.top && p.left === next.left ? p : next));
  }, [rect, mode, step.anchor, index]);

  function onWheel(e: WheelEvent) {
    if (mode !== 'step' || Math.abs(e.deltaY) < WHEEL_THRESHOLD) return;
    const now = Date.now();
    if (now - lastWheel.current < WHEEL_COOLDOWN_MS) return;
    lastWheel.current = now;
    if (e.deltaY > 0) onNext();
    else onBack();
  }

  return (
    <motion.div
      ref={ref}
      key={step.anchor}
      role="dialog"
      aria-modal="false"
      aria-labelledby="guide-tip-title"
      onWheel={onWheel}
      initial={reduce ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className="pointer-events-auto fixed z-[80] w-[320px] max-w-[calc(100vw-24px)] rounded-card border border-border bg-surface-2 p-4 shadow-2xl shadow-black/60"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
    >
      <MonoTag tone="guide">{step.anchor}</MonoTag>
      <h3 id="guide-tip-title" className="mt-2 text-sm font-semibold text-foreground">
        {step.title}
      </h3>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{step.body}</p>
      {step.tryIt && <p className="mt-2 text-sm text-guide">{step.tryIt}</p>}
      <div className="mt-3 flex items-center gap-2">
        <div className="flex items-center gap-1" aria-hidden>
          {Array.from({ length: total }, (_, i) => (
            <span
              key={i}
              className={cn('h-1.5 rounded-full transition-all', i === index ? 'w-4 bg-guide' : 'w-1.5 bg-muted-foreground/40')}
            />
          ))}
        </div>
        <span className="mono-tag text-muted-foreground">
          {index + 1} / {total}
        </span>
        <div className="ml-auto flex items-center gap-1.5">
          <Button variant="ghost" size="sm" className={cn(touch && 'h-12 px-3')} onClick={onSkip}>
            Skip
          </Button>
          {index > 0 && (
            <Button variant="ghost" size="sm" className={cn(touch && 'h-12 px-3')} onClick={onBack}>
              Back
            </Button>
          )}
          <Button
            size="sm"
            className={cn('bg-guide text-background hover:bg-guide/85', touch && 'h-12 px-4')}
            onClick={onNext}
          >
            {last ? 'Done' : 'Next'}
          </Button>
        </div>
      </div>
    </motion.div>
  );
}
