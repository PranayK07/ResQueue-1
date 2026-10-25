import { BellRing, Bot, Info, OctagonAlert, WifiOff, X, type LucideIcon } from 'lucide-react';
import { LEVEL_META, toLevel } from '@/lib/domain/levels';
import { cn } from '@/lib/utils';

export type AlertKind = 'assignment' | 'closed' | 'escalated' | 'offline' | 'agent';

export type AlertBannerProps = {
  kind: AlertKind;
  /** String(request.id), without the "#". */
  requestId?: string;
  /** The new level, for "escalated". */
  level?: string;
  /** Shows a dismiss X when set. */
  onDismiss?: () => void;
  className?: string;
};

const ICON: Record<AlertKind, LucideIcon> = {
  assignment: BellRing,
  closed: Info,
  escalated: OctagonAlert,
  offline: WifiOff,
  agent: Bot,
};

const TONE: Record<AlertKind, { box: string; accent: string }> = {
  assignment: { box: 'border-lvl-high/50 bg-lvl-high/10', accent: 'text-lvl-high' },
  agent: { box: 'border-lvl-high/50 bg-lvl-high/10', accent: 'text-lvl-high' },
  offline: { box: 'border-destructive/60 bg-destructive/10', accent: 'text-destructive' },
  escalated: { box: 'border-destructive/60 bg-destructive/10', accent: 'text-destructive' },
  closed: { box: 'border-border bg-surface-2', accent: 'text-muted-foreground' },
};

function bannerCopy(kind: AlertKind, requestId?: string, level?: string): { title: string; body?: string } {
  const req = requestId ? `Request #${requestId}` : 'The request';
  switch (kind) {
    case 'assignment':
      return {
        title: requestId ? `New assignment: request #${requestId}` : 'New assignment',
        body: 'Check the mission below.',
      };
    case 'closed':
      return { title: `${req} was closed by the resident. Unit released.` };
    case 'escalated':
      return { title: level ? `${req} escalated to ${LEVEL_META[toLevel(level)].label}.` : `${req} escalated.` };
    case 'offline':
      return { title: "Offline. Taps won't send. Use the radio." };
    case 'agent':
      return { title: "Station agent is also driving this station's units." };
  }
}

/** One /crew alert: new assignment, request closed, escalated, offline, or station agent active. */
export function AlertBanner({ kind, requestId, level, onDismiss, className }: AlertBannerProps) {
  const Icon = ICON[kind];
  const tone = TONE[kind];
  const { title, body } = bannerCopy(kind, requestId, level);
  const urgent = kind === 'offline' || kind === 'escalated';

  return (
    <div
      role={urgent ? 'alert' : 'status'}
      data-alert={kind}
      className={cn(
        'flex animate-in items-start gap-3 rounded-card border px-4 py-3 duration-200 ease-out fade-in-0 slide-in-from-top-1',
        tone.box,
        className
      )}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', tone.accent)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-medium', kind === 'closed' ? 'text-foreground' : tone.accent)}>{title}</p>
        {body && <p className="mt-0.5 text-sm text-muted-foreground">{body}</p>}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-my-3 -mr-3 inline-flex size-12 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
