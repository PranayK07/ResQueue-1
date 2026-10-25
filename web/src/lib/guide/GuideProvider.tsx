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
/** After a jump (Next, Back, start), ignore scroll-driven step changes while the page settles. */
const SETTLE_MS = 800;

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

const OPEN_DIALOG = '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]';

/** The open Radix dialog, sheet or drawer, if any (they own Esc, arrows and taps while open). */
function useOpenDialog(): Element | null {
  const [el, setEl] = useState<Element | null>(null);
  useEffect(() => {
    const read = () => setEl(document.querySelector(OPEN_DIALOG));
    read();
    const mo = new MutationObserver(read);
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
    return () => mo.disconnect();
  }, []);
  return el;
}

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
  const anchorsKey = available.map(s => s.anchor).join('|');
  // The active step is tracked by anchor, so a gated step appearing or leaving doesn't swap the tip.
  const [active, setActive] = useState<string | null>(null);
  const lastIndex = useRef(0);
  const settleUntil = useRef(0);
  const reduce = useReducedMotion();
  const dialog = useOpenDialog();

  let index: number | null = null;
  if (active !== null && available.length > 0) {
    const found = available.findIndex(s => s.anchor === active);
    index = found >= 0 ? found : Math.min(lastIndex.current, available.length - 1);
  }
  if (index !== null) lastIndex.current = index;
  const step = index === null ? undefined : available[index];
  const open = step !== undefined;
  const rect = useAnchorRect(step?.anchor ?? null);

  const finish = useCallback(() => {
    save(doneKey(screen), '1');
    setActive(null);
  }, [screen]);

  const go = useCallback(
    (i: number) => {
      const target = available[i];
      if (!target) return;
      settleUntil.current = Date.now() + SETTLE_MS;
      setActive(target.anchor);
      if (mode === 'scroll') findAnchor(target.anchor)?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
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

  // Auto-start once per screen per browser: mark it done as soon as it starts.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!enabled || !autoStart || autoStarted.current || available.length === 0) return;
    autoStarted.current = true;
    if (load(doneKey(screen)) === '1') return;
    save(doneKey(screen), '1');
    go(0);
  }, [enabled, autoStart, available.length, screen, go]);

  useEffect(() => {
    if (!enabled) setActive(null);
  }, [enabled]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || isEditable(e.target)) return;
      if (document.querySelector(OPEN_DIALOG)) return;
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
  // At the very top or bottom of the page the first or last step wins, since they may never reach the middle.
  useEffect(() => {
    if (mode !== 'scroll' || !open || typeof IntersectionObserver === 'undefined') return;
    const ids = anchorsKey ? anchorsKey.split('|') : [];
    const els = ids.map(id => findAnchor(id));
    let first = true;
    const io = new IntersectionObserver(
      entries => {
        // The first batch reports where things are now, not a scroll; keep the chosen step.
        if (first) {
          first = false;
          return;
        }
        if (Date.now() < settleUntil.current) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const i = els.indexOf(entry.target as HTMLElement);
          if (i >= 0) setActive(ids[i]!);
        }
      },
      { rootMargin: '-45% 0px -45% 0px' }
    );
    for (const el of els) if (el) io.observe(el);
    const onScroll = () => {
      if (Date.now() < settleUntil.current || ids.length === 0) return;
      const doc = document.documentElement;
      if (window.scrollY <= 2) setActive(ids[0]!);
      else if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) setActive(ids[ids.length - 1]!);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      io.disconnect();
      window.removeEventListener('scroll', onScroll);
    };
  }, [mode, open, anchorsKey]);

  const ctx = useMemo<GuideContextValue>(
    () => ({ screen, mode, stepCount: available.length, open, start }),
    [screen, mode, available.length, open, start]
  );

  // A dialog that doesn't contain the anchor owns the screen: the guide steps aside until it closes.
  const anchorEl = step ? findAnchor(step.anchor) : null;
  const hiddenByDialog = !!dialog && !(anchorEl && dialog.contains(anchorEl));

  return (
    <GuideContext.Provider value={ctx}>
      {children}
      {step &&
        index !== null &&
        !hiddenByDialog &&
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
