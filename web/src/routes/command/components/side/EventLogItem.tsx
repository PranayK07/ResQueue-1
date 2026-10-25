import type { EventLogRow } from '@/lib/stdb';
import { formatT } from '@/lib/time/sim';
import { cn } from '@/lib/utils';

export type EventLogItemProps = {
  event: EventLogRow;
  /** Called with the row's request id. Only rows with a request are clickable. */
  onFocusRequest: (requestId: string) => void;
  className?: string;
};

/** One log line: sim time, actor, message. A row tied to a request is a button that focuses it. */
export function EventLogItem({ event, onFocusRequest, className }: EventLogItemProps) {
  const content = (
    <>
      <span className="mono-tag flex min-w-0 items-center gap-2 text-muted-foreground">
        <span className="shrink-0">{formatT(event.simS)}</span>
        <span className="min-w-0 truncate">{event.actor}</span>
      </span>
      <span className="block text-[13px] leading-5 break-words text-foreground">{event.message}</span>
    </>
  );

  if (event.requestId === 0n) {
    return <div className={cn('rounded-md px-2 py-1.5', className)}>{content}</div>;
  }

  const requestId = String(event.requestId);
  return (
    <button
      type="button"
      onClick={() => onFocusRequest(requestId)}
      title={`Show request #${requestId}`}
      className={cn(
        'block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-white/5 focus-visible:outline-2 focus-visible:outline-ring',
        className
      )}
    >
      {content}
    </button>
  );
}
