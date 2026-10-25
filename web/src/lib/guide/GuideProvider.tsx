import { useReducedMotion } from 'motion/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { load, save } from '@/lib/storage';
import { Spotlight } from './Spotlight';
import { TipCard } from './TipCard';
import type { GuideMode, GuideScreen, GuideStep } from './types';
import { findAnchor } from './useAnchor';
import { useAnchorRect } from './useAnchorRect';

const doneKey = (screen: GuideScreen) => `guide:${screen}:done`;

type GuideContextValue = {
  screen: GuideScreen;
  mode: GuideMode;
  /** Steps whose requires() passes right now. */
  stepCount: number;
  open: boolean;
  start: () => void;
};

const GuideContext = createContext<GuideContextValue | null>(null);

/** The surrounding guide, or null outside a GuideProvider. */
export function useGuide(): GuideContextValue | null {
  return useContext(GuideContext);
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    target.getAttribute('role') === 'slider'
  );
}

// Esc and arrows belong to an open dialog or drawer, not the guide.
const dialogOpen = () => !!document.querySelector('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');

type GuideProviderProps<S> = {
  screen: GuideScreen;
  mode: GuideMode;
  steps: readonly GuideStep<S>[];
  /** Live state for requires(). Memoize it: a new object every render re-filters the steps. */
  state: S;
  /** False hides the guide entirely (for example /help outside demo mode or before a request exists). */
  enabled?: boolean;
  /** Start once per screen per browser (localStorage "guide:<screen>:done"). */
  autoStart?: boolean;
  children: ReactNode;
};

export function GuideProvider<S>({
  screen,
  mode,
  steps,
  state,
  enabled = true,
  autoStart = true,
  children,
}: GuideProviderProps<S>) {
  const available = useMemo(
    () => (enabled ? steps.filter(s => !s.requires || s.requires(state)) : []),
    [enabled, steps, state]
  );
  const [rawIndex, setRawIndex] = useState<number | null>(null);
  const index = rawIndex === null || available.length === 0 ? null : Math.min(rawIndex, available.length - 1);
  const step = index === null ? undefined : available[index];
  const rect = useAnchorRect(step?.anchor ?? null);
  const reduce = useReducedMotion();
  const open = step !== undefined;

  const finish = useCallback(() => {
    save(doneKey(screen), '1');
    setRawIndex(null);
  }, [screen]);

  const go = useCallback(
    (i: number) => {
      setRawIndex(i);
      const target = available[i];
      if (mode === 'scroll' && target) {
        findAnchor(target.anchor)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
      }
    },
    [available, mode, reduce]
  );

  const start = useCallback(() => {
    if (available.length > 0) go(0);
  }, [available.length, go]);

  const next = useCallback(() => {
    if (index === null) return;
    if (index + 1 >= available.length) finish();
    else go(index + 1);
  }, [index, available.length, finish, go]);

  const back = useCallback(() => {
    if (index !== null && index > 0) go(index - 1);
  }, [index, go]);

  const autoStarted = useRef(false);
  useEffect(() => {
    if (!enabled || !autoStart || autoStarted.current || available.length === 0) return;
    autoStarted.current = true;
    if (load(doneKey(screen)) !== '1') go(0);
  }, [enabled, autoStart, available.length, screen, go]);

  useEffect(() => {
    if (!enabled) setRawIndex(null);
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target) || dialogOpen()) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        e.preventDefault();
        back();
      } else if (e.key === 'Escape') {
        finish();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, next, back, finish]);

  // Scroll mode: the anchor crossing the middle of the viewport becomes the active step.
  useEffect(() => {
    if (mode !== 'scroll' || !open || typeof IntersectionObserver === 'undefined') return;
    const els = available.map(s => findAnchor(s.anchor));
    const io = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const i = els.indexOf(entry.target as HTMLElement);
          if (i >= 0) setRawIndex(i);
        }
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    for (const el of els) if (el) io.observe(el);
    return () => io.disconnect();
  }, [mode, open, available]);

  const ctx = useMemo<GuideContextValue>(
    () => ({ screen, mode, stepCount: available.length, open, start }),
    [screen, mode, available.length, open, start]
  );

  return (
    <GuideContext.Provider value={ctx}>
      {children}
      {step &&
        index !== null &&
        createPortal(
          <>
            <Spotlight rect={rect} dim={mode === 'step' ? 0.6 : 0.35} />
            <TipCard
              step={step}
              index={index}
              total={available.length}
              rect={rect}
              mode={mode}
              onNext={next}
              onBack={back}
              onSkip={finish}
            />
          </>,
          document.body
        )}
    </GuideContext.Provider>
  );
}
