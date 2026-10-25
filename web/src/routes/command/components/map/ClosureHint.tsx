import { MousePointerClick } from 'lucide-react';

type ClosureHintProps = {
  /** True once the first point is placed. */
  hasFirstPoint: boolean;
};

/** Top-center chip shown while drawing a road closure. */
export function ClosureHint({ hasFirstPoint }: ClosureHintProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface/90 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-foreground shadow-lg backdrop-blur-sm"
    >
      <MousePointerClick className="size-3.5 text-muted-foreground" aria-hidden />
      {hasFirstPoint ? 'Now click the second point. Esc cancels.' : 'Click two points to draw a closure. Esc cancels.'}
    </div>
  );
}
