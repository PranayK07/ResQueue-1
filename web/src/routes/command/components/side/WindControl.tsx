import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, Lock, LockOpen, Wind } from 'lucide-react';
import { WIND_SPEED_MAX_UI } from '@/lib/domain/limits';
import { useAnchor } from '@/lib/guide';
import type { WeatherRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { EmptyState } from '@/lib/ui/EmptyState';
import { Panel } from '@/lib/ui/Panel';
import { cn } from '@/lib/utils';
import { SideSkeleton } from './SideSkeleton';
import { StaleNote } from './StaleNote';
import { WindDial } from './WindDial';
import { WindSlider } from './WindSlider';

export type WindControlProps = {
  weather: WeatherRow | undefined;
  /** Once per finished drag or key press on either slider: speed in m/s, direction the wind blows from in whole degrees. */
  onCommit: (speedMps: number, fromDeg: number) => void;
  /** "Return to live wind" (release_weather_lock). The button shows only when this is set and the wind is locked. */
  onRelease?: () => void;
  /** A wind call is in flight. */
  pending: boolean;
  /** Every control off (not live). */
  disabled: boolean;
  /** Data is old: grayed. */
  stale: boolean;
  /** No weather row yet because rows are still arriving: skeleton instead of the empty state. */
  loading?: boolean;
  /** Mapped error copy from the last failed wind call, shown under the sliders. */
  error?: string | null;
  /** Wall-clock ms of the last live data, shown as "Last update" while stale. */
  lastUpdateMs?: number | null;
  className?: string;
};

type WindValue = { speed: number; dir: number };

const SPEED_STEP = 0.5;
const DIR_MAX = 359;

const clampSpeed = (v: number): number => Math.min(WIND_SPEED_MAX_UI, Math.max(0, v));
/** Whole degrees in 0..359. */
const normDeg = (v: number): number => ((Math.round(v) % 360) + 360) % 360;

/** The demo's wind control: compass, speed and direction sliders, source and lock. */
export function WindControl({
  weather,
  onCommit,
  onRelease,
  pending,
  disabled,
  stale,
  loading,
  error,
  lastUpdateMs,
  className,
}: WindControlProps) {
  const anchor = useAnchor('cmd.wind');
  // Values under the user's hand. Null shows the server's wind.
  const [draft, setDraft] = useState<WindValue | null>(null);
  const [dragEnds, setDragEnds] = useState(0);
  const dragging = useRef(false);
  // A commit was sent and its result hasn't shown up yet: keep the draft on screen.
  const awaiting = useRef(false);

  const serverSpeed = weather?.windSpeedMps;
  const serverDir = weather?.windFromDeg;

  // New server wind replaces the draft, unless a drag is under way.
  useEffect(() => {
    if (dragging.current) return;
    awaiting.current = false;
    setDraft(null);
  }, [serverSpeed, serverDir]);

  // A call that ended (applied or failed) does the same.
  useEffect(() => {
    if (pending || dragging.current) return;
    awaiting.current = false;
    setDraft(null);
  }, [pending]);

  // A drag that ended without a commit goes back to the server's wind.
  useEffect(() => {
    if (!dragging.current && !awaiting.current) setDraft(null);
  }, [dragEnds]);

  // Losing the connection mid-drag drops the drag.
  useEffect(() => {
    if (!disabled) return;
    dragging.current = false;
    awaiting.current = false;
    setDraft(null);
  }, [disabled]);

  const startDrag = () => {
    dragging.current = true;
  };
  const endDrag = () => {
    if (!dragging.current) return;
    dragging.current = false;
    setDragEnds(n => n + 1);
  };
  const commit = (next: WindValue) => {
    awaiting.current = true;
    setDraft(next);
    onCommit(next.speed, normDeg(next.dir));
  };

  let body: ReactNode;
  if (!weather) {
    body = loading ? (
      <SideSkeleton label="Loading the wind" rows={2} />
    ) : (
      <EmptyState icon={Wind} title="No wind data yet." className="py-6" />
    );
  } else {
    const shown = draft ?? { speed: weather.windSpeedMps, dir: weather.windFromDeg };
    const speedText = shown.speed.toFixed(1);
    const fromDeg = normDeg(shown.dir);

    body = (
      <div className={cn('flex flex-col gap-3 px-4 pb-4', stale && 'opacity-60 grayscale')}>
        <div className="flex items-center gap-4">
          <WindDial fromDeg={shown.dir} className="size-20 shrink-0" />
          <dl className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 text-sm">
            <dt className="text-muted-foreground">Speed</dt>
            <dd className="text-right font-mono tabular-nums">{speedText} m/s</dd>
            <dt className="text-muted-foreground">From</dt>
            <dd className="text-right font-mono tabular-nums">{fromDeg}°</dd>
            <dt className="text-muted-foreground">Source</dt>
            <dd className="flex min-w-0 items-center justify-end gap-1.5">
              <span className="truncate">{weather.source}</span>
              {weather.locked && (
                <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/5 px-1.5 py-0.5 text-xs text-muted-foreground">
                  <Lock className="size-3" aria-hidden />
                  Locked
                </span>
              )}
            </dd>
          </dl>
        </div>

        <WindSlider
          label="Speed"
          valueText={`${speedText} meters per second`}
          value={clampSpeed(shown.speed)}
          min={0}
          max={WIND_SPEED_MAX_UI}
          step={SPEED_STEP}
          disabled={disabled}
          onChange={speed => setDraft({ speed, dir: shown.dir })}
          onCommit={speed => commit({ speed, dir: shown.dir })}
          onDragStart={startDrag}
          onDragEnd={endDrag}
        />
        <WindSlider
          label="From"
          valueText={`From ${fromDeg} degrees`}
          value={fromDeg}
          min={0}
          max={DIR_MAX}
          step={1}
          disabled={disabled}
          onChange={dir => setDraft({ speed: shown.speed, dir })}
          onCommit={dir => commit({ speed: shown.speed, dir })}
          onDragStart={startDrag}
          onDragEnd={endDrag}
        />

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {weather.locked && onRelease && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="self-start"
            disabled={disabled || pending}
            onClick={onRelease}
          >
            <LockOpen aria-hidden />
            Return to live wind
          </Button>
        )}

        {stale && <StaleNote lastUpdateMs={lastUpdateMs} />}
      </div>
    );
  }

  return (
    <Panel
      {...anchor}
      title="Wind"
      meta={
        weather ? (
          <span className="inline-flex items-center gap-1.5">
            {pending && (
              <>
                <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
                <span className="sr-only">Sending</span>
              </>
            )}
            {weather.source}
            {weather.locked ? ' · locked' : ''}
          </span>
        ) : undefined
      }
      aria-busy={pending || undefined}
      className={className}
    >
      {body}
    </Panel>
  );
}
