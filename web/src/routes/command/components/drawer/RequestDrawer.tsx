import { requestStatusLabel } from '@/lib/domain/status';
import type { OpsFlagRow, OpsQueueRow, OpsRequestRow, OpsTravelRow, StationRow, UnitRow } from '@/lib/stdb';
import { LevelBadge } from '@/lib/ui/LevelBadge';
import { Separator } from '@/lib/ui/separator';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/lib/ui/sheet';
import { cn } from '@/lib/utils';
import { FlagForm, type FlagKind } from './FlagForm';
import { FlagList } from './FlagList';
import { PinControl } from './PinControl';
import { QueueSummary } from './QueueSummary';
import { RequestDetails } from './RequestDetails';
import { TravelTable } from './TravelTable';

export type RequestDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The selected ops_request row. Undefined once it closes or is purged while open. */
  request: OpsRequestRow | undefined;
  /** Its ops_queue entry. Undefined while it is still being assessed. */
  queue: OpsQueueRow | undefined;
  /** ops_travel rows. Rows for other requests are ignored. */
  travel: readonly OpsTravelRow[];
  /** ops_flag rows. Rows for other requests are ignored. */
  flags: readonly OpsFlagRow[];
  stations: readonly StationRow[];
  units: readonly UnitRow[];
  /** Sim now in seconds. Undefined until sim_clock arrives. */
  simNow: number | undefined;
  /** override_assignment. stationId 0 unpins. */
  onPin: (stationId: number, note: string) => void;
  /** flag_request. */
  onFlag: (kind: FlagKind, detail: string) => void;
  pinPending: boolean;
  flagPending: boolean;
  /** Blocks every control, e.g. while offline or reconnecting. */
  disabled: boolean;
  /** Inline error text from the last failed pin or unpin (pair it with a toast). */
  pinError?: string;
  /** Inline error text from the last failed flag (pair it with a toast). */
  flagError?: string;
  /** No live connection: data is grayed, controls are blocked and a "Last update" line shows. */
  stale?: boolean;
  /** Preformatted time of the last live update, e.g. "14:05:09". */
  lastUpdated?: string;
};

/** The request detail sheet on /command: details, line, travel, flags, pin and flag actions. */
export function RequestDrawer({
  open,
  onOpenChange,
  request,
  queue,
  travel,
  flags,
  stations,
  units,
  simNow,
  onPin,
  onFlag,
  pinPending,
  flagPending,
  disabled,
  pinError,
  flagError,
  stale = false,
  lastUpdated,
}: RequestDrawerProps) {
  const blocked = disabled || stale;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="gap-0 bg-surface outline-none data-[side=right]:w-[480px] data-[side=right]:sm:max-w-[480px]"
        onOpenAutoFocus={e => {
          // Focus the sheet itself so it opens at the top instead of scrolling to the first input.
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus();
        }}
      >
        {request === undefined ? (
          <SheetHeader className="px-5 pt-5 pr-12 pb-4">
            <SheetTitle className="text-lg font-semibold">Request</SheetTitle>
            <SheetDescription>This request is no longer active.</SheetDescription>
          </SheetHeader>
        ) : (
          <>
            <SheetHeader className="shrink-0 gap-2 border-b border-border px-5 pt-5 pr-12 pb-4">
              <SheetTitle className="text-lg font-semibold">
                Request <span className="font-mono tabular-nums">#{String(request.id)}</span>
              </SheetTitle>
              <SheetDescription className="flex flex-wrap items-center gap-2">
                <LevelBadge level={request.level} size="md" />
                <span className="font-medium text-foreground">{requestStatusLabel(request.status)}</span>
                <span className="mono-tag text-muted-foreground">{request.channel}</span>
              </SheetDescription>
              {stale && (
                <p className="text-xs text-muted-foreground tabular-nums">
                  {lastUpdated ? `Last update ${lastUpdated}` : 'Last update unknown'}
                </p>
              )}
            </SheetHeader>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <div
                className={cn(
                  'space-y-6 px-5 py-5 transition-[opacity,filter] duration-200 ease-out',
                  stale && 'opacity-60 grayscale'
                )}
              >
                <RequestDetails request={request} simNow={simNow} />
                <QueueSummary queue={queue} stations={stations} units={units} />
                <TravelTable
                  travel={travel.filter(t => t.requestId === request.id)}
                  stations={stations}
                  currentStationId={queue?.stationId}
                />
                <FlagList flags={flags.filter(f => f.requestId === request.id)} />
              </div>

              <Separator />

              <div className="space-y-6 px-5 py-5">
                <PinControl
                  key={`pin-${String(request.id)}`}
                  status={request.status}
                  pinnedStationId={request.pinnedStationId}
                  stations={stations}
                  onPin={onPin}
                  pending={pinPending}
                  disabled={blocked}
                  error={pinError}
                />
                <FlagForm
                  key={`flag-${String(request.id)}`}
                  onFlag={onFlag}
                  pending={flagPending}
                  disabled={blocked}
                  error={flagError}
                />
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
