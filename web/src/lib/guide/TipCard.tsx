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

/** Where the card goes: beside the anchor on desktop, below or above it on phones, flipped to stay on screen. */
function place(rect: Rect | null, w: number, h: number, mode: GuideMode) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (!rect) return { top: vh - h - 24, left: (vw - w) / 2 };
  const right = rect.left + rect.width + GAP;
  const left = rect.left - GAP - w;
  const below = rect.top + rect.height + GAP;
  const above = rect.top - GAP - h;
  let top: number;
  let x: number;
  if (mode === 'step' && right + w <= vw - MARGIN) [top, x] = [rect.top, right];
  else if (mode === 'step' && left >= MARGIN) [top, x] = [rect.top, left];
  else if (below + h <= vh - MARGIN) [top, x] = [below, rect.left];
  else if (above >= MARGIN) [top, x] = [above, rect.left];
  else [top, x] = [vh - h - MARGIN, (vw - w) / 2];
  return { top: clamp(top, MARGIN, vh - h - MARGIN), left: clamp(x, MARGIN, vw - w - MARGIN) };
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
