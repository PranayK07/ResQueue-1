import { useEffect, useId, useMemo, useState } from 'react';
import { Construction, LoaderCircle } from 'lucide-react';
import type { RoadClosureRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { Panel } from '@/lib/ui/Panel';
import { cn } from '@/lib/utils';
import { ClosureListItem } from './ClosureListItem';
import { SideSkeleton } from './SideSkeleton';
import { StaleNote } from './StaleNote';
import { closuresInOrder } from './sort';

export type ClosurePanelProps = {
  closures: readonly RoadClosureRow[];
  /** The map is taking the two clicks. */
  drawing: boolean;
  /** Both points are placed: ask for a name. */
  draftReady: boolean;
  /** Enter drawing mode. */
  onStart: () => void;
  /** Leave drawing mode and drop the draft. Always available. */
  onCancel: () => void;
  /** add_road_closure with the drawn points. Called with the trimmed name. */
  onSave: (name: string) => void;
  saving: boolean;
  /** set_road_closure_active [confirm]. Per-row Reopen/Close shows only when this is set. */
  onToggle?: (id: string, active: boolean) => void;
  /** Every reducer control off (not live). Cancel stays available. */
  disabled: boolean;
  /** Closure whose toggle call is in flight. */
  togglingId?: string | null;
  /** Rows still arriving: skeleton for the list. */
  loading?: boolean;
  /** Data is old: grayed. */
  stale?: boolean;
  /** Mapped error copy from a failed save or toggle. */
  error?: string | null;
  /** Wall-clock ms of the last live data, shown as "Last update" while stale. */
  lastUpdateMs?: number | null;
  className?: string;
};

const NAME_MAX = 80;

/** Road closures: draw a new one on the map, name it, and list the existing ones. */
export function ClosurePanel({
  closures,
  drawing,
  draftReady,
  onStart,
  onCancel,
  onSave,
  saving,
  onToggle,
  disabled,
  togglingId = null,
  loading,
  stale,
  error,
  lastUpdateMs,
  className,
}: ClosurePanelProps) {
  const [name, setName] = useState('');
  const inputId = useId();
  const sorted = useMemo(() => closuresInOrder(closures), [closures]);
  const activeCount = useMemo(() => closures.filter(c => c.active).length, [closures]);
  const trimmed = name.trim();

  // A finished or cancelled drawing starts the next one with an empty name.
  useEffect(() => {
    if (!drawing && !draftReady) setName('');
  }, [drawing, draftReady]);

  return (
    <Panel
      title="Road closures"
      meta={loading || closures.length === 0 ? undefined : <span className="tabular-nums">{activeCount} active</span>}
      aria-busy={saving || togglingId !== null || undefined}
      className={className}
    >
      <div className="flex flex-col gap-3 px-4 pb-4">
        {draftReady ? (
          <form
            className="flex flex-col gap-2"
            onSubmit={e => {
              e.preventDefault();
              if (trimmed && !saving && !disabled) onSave(trimmed);
            }}
          >
            <label htmlFor={inputId} className="text-xs text-muted-foreground">
              Closure name
            </label>
            <Input
              id={inputId}
              autoFocus
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={NAME_MAX}
              placeholder="Road or segment"
              disabled={saving}
            />
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={!trimmed || saving || disabled} aria-busy={saving || undefined}>
                {saving && <LoaderCircle className="motion-safe:animate-spin" aria-hidden />}
                Save
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={saving}>
                Cancel
              </Button>
            </div>
          </form>
        ) : drawing ? (
          <div className="flex items-center justify-between gap-2">
            <p role="status" className="text-sm text-muted-foreground">
              Click two points on the map.
            </p>
            <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={disabled} onClick={onStart}>
            <Construction aria-hidden />
            Draw a closure
          </Button>
        )}

        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {loading ? (
          <SideSkeleton label="Loading road closures" rows={2} className="px-0 pb-0" />
        ) : sorted.length === 0 ? (
          <p className="text-sm text-muted-foreground">No road closures.</p>
        ) : (
          <ul
            aria-label="Road closures"
            className={cn('-my-1.5 max-h-40 divide-y divide-border overflow-y-auto', stale && 'opacity-60 grayscale')}
          >
            {sorted.map(c => {
              const id = String(c.id);
              return (
                <ClosureListItem
                  key={id}
                  closure={c}
                  onToggle={onToggle}
                  pending={togglingId === id}
                  disabled={disabled || togglingId !== null}
                />
              );
            })}
          </ul>
        )}

        {stale && <StaleNote lastUpdateMs={lastUpdateMs} />}
      </div>
    </Panel>
  );
}
