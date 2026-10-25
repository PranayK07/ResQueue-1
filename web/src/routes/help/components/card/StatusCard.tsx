import type { ResidentCard } from '@/lib/stdb';
import { requestStatusLabel } from '@/lib/domain/status';
import { useAnchor } from '@/lib/guide';
import { Button } from '@/lib/ui/button';
import { Panel } from '@/lib/ui/Panel';
import { Stat } from '@/lib/ui/Stat';
import { cn } from '@/lib/utils';
import { statusCopy } from './statusCopy';

export type StatusCardProps = {
  /** The row to show: newest active my_requests row, else the newest closed one. */
  card: ResidentCard;
  /** Minutes until the crew arrives, from etaS and sim time. Undefined when unknown. */
  etaMin: number | undefined;
  /** No live connection: the card is grayed and shows when it last updated. */
  stale: boolean;
  /** Preformatted time of the last live update, e.g. "14:05". */
  lastUpdated?: string;
  /** Starts a new request from a closed card. The ask-again control only renders when set. */
  onAskAgain?: () => void;
  className?: string;
};

/** The resident's live card. Never shows `level`. */
export function StatusCard({ card, etaMin, stale, lastUpdated, onAskAgain, className }: StatusCardProps) {
  const positionAnchor = useAnchor('help.card.position');
  const crewAnchor = useAnchor('help.card.crew');
  const reasonAnchor = useAnchor('help.card.reason');

  const copy = statusCopy(card, etaMin);
  const showReason = copy.showReason && card.reason.trim() !== '';

  return (
    <section
      data-status={card.status}
      className={cn(
        'rounded-frame border border-border bg-surface p-5 transition-[opacity,filter] duration-200 ease-out',
        stale && 'opacity-60 grayscale',
        className
      )}
    >
      <p className="label-caps">{copy.label}</p>

      <div {...positionAnchor} aria-live="polite" aria-atomic="true" className="mt-2">
        <h2
          className={cn(
            'font-semibold text-balance tabular-nums',
            copy.closed ? 'text-lg leading-snug' : 'text-3xl leading-tight tracking-tight'
          )}
        >
          {copy.headline}
        </h2>
        {copy.detail != null && <p className="mt-1 text-sm text-muted-foreground">{copy.detail}</p>}
      </div>

      {copy.showEta && (
        <div {...crewAnchor} className="mt-4 grid grid-cols-2 gap-2">
          <Stat label="Crew arrives" value={copy.etaText ?? 'Not yet'} />
          <Stat label="Status" value={requestStatusLabel(card.status)} />
        </div>
      )}

      {showReason && (
        <Panel {...reasonAnchor} raised title="Why you're here" className="mt-4">
          <p className="px-4 pb-3 text-sm leading-relaxed">{card.reason}</p>
        </Panel>
      )}

      {copy.closed && copy.askAgain === 'button' && onAskAgain && (
        <Button
          className="mt-5 h-auto min-h-[72px] w-full rounded-card text-lg font-semibold"
          disabled={stale}
          onClick={onAskAgain}
        >
          I need help
        </Button>
      )}

      {copy.closed && copy.askAgain === 'link' && onAskAgain && (
        <Button
          variant="ghost"
          className="-ml-3 mt-3 h-auto min-h-12 px-3 text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          disabled={stale}
          onClick={onAskAgain}
        >
          Need help again?
        </Button>
      )}

      {stale && (
        <p className="mono-tag mt-4 text-muted-foreground">
          {lastUpdated ? `Last updated ${lastUpdated}` : 'Not updating right now'}
        </p>
      )}
    </section>
  );
}
