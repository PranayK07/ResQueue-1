import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { distanceText, instruction, maneuverIcon, type Progress } from '../../ops/navigation';
import type { Route } from '../../ops/routing';

/** Collapsed height: handle + next maneuver, nothing cut off below. */
export const SHEET_PEEK = 108;
/** The sheet never covers more than a third of the screen. */
export const SHEET_MAX_FRACTION = 1 / 3;

interface Props {
  /** Desktop directions occupy a side pane instead of covering the map. */
  docked?: boolean;
  /** Total height available to the app, for the 1/3 limit. */
  appHeight: number;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Reports the sheet's current height so the map can keep the route clear of it. */
  onHeightChange: (h: number) => void;
  destination: string;
  route: Route | null;
  progress: Progress | null;
  arrived: boolean;
  /** e.g. "ETA 20:46 · 8 min" */
  etaText: string;
  /** Shown above the steps: preview banner, GPS warning, … */
  notice?: ReactNode;
  /** Action row (Google Maps, GPS toggle, re-route). */
  actions: ReactNode;
  /** Shown when arrived instead of directions. */
  arrivedContent?: ReactNode;
  /** "Then: Q-005 …" */
  nextLeg?: ReactNode;
  empty?: ReactNode;
}

/** Swipe-up directions on mobile; a persistent, scrollable pane on desktop. */
export function DirectionsSheet(p: Props) {
  const maxH = Math.max(SHEET_PEEK + 60, Math.round(p.appHeight * SHEET_MAX_FRACTION));
  const [dragH, setDragH] = useState<number | null>(null);
  const start = useRef<{ y: number; h: number; moved: boolean } | null>(null);
  const height = dragH ?? (p.expanded ? maxH : SHEET_PEEK);
  const { docked, onHeightChange } = p;

  // Also report height changes caused by resizing an expanded mobile sheet.
  useEffect(() => {
    onHeightChange(docked ? 0 : height);
  }, [onHeightChange, docked, height]);

  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { y: e.clientY, h: height, moved: false };
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dy = s.y - e.clientY;
    if (Math.abs(dy) > 4) s.moved = true;
    if (!s.moved) return;
    const h = Math.min(maxH, Math.max(SHEET_PEEK, s.h + dy));
    setDragH(h);
    p.onHeightChange(h);
  };
  const onUp = () => {
    const s = start.current;
    start.current = null;
    if (!s) return;
    // A tap toggles; a swipe snaps to whichever state is nearer.
    const next = s.moved ? (dragH ?? height) > (SHEET_PEEK + maxH) / 2 : !p.expanded;
    setDragH(null);
    p.onExpandedChange(next);
    p.onHeightChange(next ? maxH : SHEET_PEEK);
  };

  const step = p.route && p.progress ? p.route.steps[p.progress.nextStep] : null;

  return (
    <section className={`dsheet${p.docked ? ' dsheet--docked' : ''}`} style={p.docked ? undefined : { height }} aria-label="Directions">
      <div
        className="dsheet__grab"
        role={p.docked ? undefined : 'button'}
        tabIndex={p.docked ? undefined : 0}
        aria-expanded={p.docked ? undefined : p.expanded}
        aria-label={p.docked ? undefined : p.expanded ? 'Collapse directions' : 'Expand directions'}
        onPointerDown={p.docked ? undefined : onDown}
        onPointerMove={p.docked ? undefined : onMove}
        onPointerUp={p.docked ? undefined : onUp}
        onPointerCancel={p.docked ? undefined : onUp}
        onKeyDown={e => {
          if (p.docked) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            p.onExpandedChange(!p.expanded);
            p.onHeightChange(!p.expanded ? maxH : SHEET_PEEK);
          }
        }}
      >
        {p.docked ? <p className="dsheet__heading">Directions</p> : <span className="dsheet__handle" aria-hidden />}
        {p.arrived ? (
          <div className="dsheet__next">
            <span className="dsheet__icon" aria-hidden>
              ⚑
            </span>
            <div className="dsheet__text">
              <p className="dsheet__dist">Arrived</p>
              <p className="dsheet__instr">{p.destination}</p>
            </div>
          </div>
        ) : step && p.progress ? (
          <div className="dsheet__next">
            <span className="dsheet__icon" aria-hidden>
              {maneuverIcon(step)}
            </span>
            <div className="dsheet__text">
              <p className="dsheet__dist">{step.type === 'arrive' ? distanceText(p.progress.remainingM) : `In ${distanceText(p.progress.toNextM)}`}</p>
              <p className="dsheet__instr">{instruction(step, p.destination)}</p>
            </div>
            <div className="dsheet__eta">
              <p className="mono">{p.etaText}</p>
              <p>{distanceText(p.progress.remainingM)} left</p>
            </div>
          </div>
        ) : (
          <div className="dsheet__next dsheet__next--empty">{p.empty ?? 'Loading directions…'}</div>
        )}
      </div>

      <div className="dsheet__body">
        {p.notice}
        <div className="dsheet__actions">{p.actions}</div>
        {p.arrived && p.arrivedContent}
        {!p.arrived && p.route && p.progress && (
          <ol className="dsheet__steps">
            {p.route.steps.map((s, i) => (
              <li key={i} className={i < p.progress!.nextStep ? 'is-done' : i === p.progress!.nextStep ? 'is-next' : ''}>
                <span className="dsheet__step-icon" aria-hidden>
                  {maneuverIcon(s)}
                </span>
                <span className="dsheet__step-text">{instruction(s, p.destination)}</span>
                {s.type !== 'arrive' && <span className="dsheet__step-dist">{distanceText(s.distanceM)}</span>}
              </li>
            ))}
          </ol>
        )}
        {!p.arrived && p.route && !p.route.onRoads && <p className="dsheet__warn">Road routing unavailable; showing a straight line.</p>}
        {p.nextLeg}
      </div>
    </section>
  );
}
