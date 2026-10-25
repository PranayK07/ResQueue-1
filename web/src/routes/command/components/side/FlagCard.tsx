import { useId, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import type { OpsFlagRow } from '@/lib/stdb';
import { Button } from '@/lib/ui/button';
import { Input } from '@/lib/ui/input';
import { cn } from '@/lib/utils';
import { FlagKindTag } from './FlagKindTag';

export type FlagCardProps = {
  flag: OpsFlagRow;
  onResolve: (flagId: string, resolution: string) => void;
  onSelectRequest: (requestId: string) => void;
  /** This flag's resolve call is in flight. */
  pending: boolean;
  /** Resolve controls off (not live, or another flag's call is in flight). */
  disabled: boolean;
  /** Mapped error copy from this flag's failed resolve. */
  error?: string | null;
  className?: string;
};

/** Spec 4.2 presets. The resolution is free text; these are shortcuts. */
const PRESETS = ['Air support requested', 'Pinned to another station'] as const;
const RESOLUTION_MAX = 200;

/** One open flag: kind, request, detail, recommendation, and the controls that record a decision. */
export function FlagCard({ flag, onResolve, onSelectRequest, pending, disabled, error, className }: FlagCardProps) {
  const [text, setText] = useState('');
  const errorId = useId();
  const flagId = String(flag.id);
  const requestId = String(flag.requestId);
  const off = disabled || pending;
  const typed = text.trim();

  return (
    <article
      aria-label={`Flag on request #${requestId}`}
      aria-busy={pending || undefined}
      className={cn('flex flex-col gap-2 rounded-card border border-border bg-surface-2 p-3', className)}
    >
      <header className="flex items-center gap-2">
        <FlagKindTag kind={flag.kind} />
        {flag.requestId !== 0n && (
          <button
            type="button"
            onClick={() => onSelectRequest(requestId)}
            aria-label={`Open request #${requestId}`}
            className="mono-tag rounded-sm text-foreground underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            #{requestId}
          </button>
        )}
        {pending && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 motion-safe:animate-spin" aria-hidden />
            Recording
          </span>
        )}
      </header>

      {flag.detail && <p className="text-sm text-muted-foreground">{flag.detail}</p>}
      {flag.recommendation && <p className="text-sm">Recommendation: {flag.recommendation}</p>}

      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map(p => (
          <Button key={p} type="button" variant="outline" size="sm" disabled={off} onClick={() => onResolve(flagId, p)}>
            {p}
          </Button>
        ))}
      </div>
      <form
        className="flex gap-1.5"
        onSubmit={e => {
          e.preventDefault();
          if (typed && !off) onResolve(flagId, typed);
        }}
      >
        <Input
          value={text}
          onChange={e => setText(e.target.value)}
          maxLength={RESOLUTION_MAX}
          placeholder="Or type your decision"
          aria-label={`Decision for request #${requestId}`}
          aria-describedby={error ? errorId : undefined}
          aria-invalid={error ? true : undefined}
          disabled={off}
          className="h-7 text-xs md:text-xs"
        />
        <Button type="submit" size="sm" disabled={off || !typed}>
          Record
        </Button>
      </form>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        Resolving records your decision. There are no air units in the simulation.
      </p>
    </article>
  );
}
