import { APP_NAME } from '@/lib/app';
import { Call911Link } from './Call911Link';

/**
 * Sticky top bar for /help. z-[75] sits above the guide dim layer (z-70) and below tip cards (z-80),
 * so Call 911 is never dimmed or covered. Render it outside any element that creates a stacking context.
 */
export function HelpHeader() {
  return (
    <header data-guide-clear className="sticky top-0 z-[75] bg-background/90 pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="mx-auto flex min-h-16 w-full max-w-md items-center gap-3 px-4">
        <span aria-hidden className="size-7 shrink-0 rounded-lg bg-linear-to-br from-lvl-high to-lvl-critical" />
        <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <h1 className="max-w-full truncate text-[15px] leading-5 font-semibold text-foreground">{APP_NAME}</h1>
          <span
            title="Everything here is simulated"
            className="mono-tag inline-flex h-5 items-center rounded-md border border-lvl-high/40 px-1.5 text-lvl-high"
          >
            Simulated demo
          </span>
        </div>
        <Call911Link size="pill" />
      </div>
    </header>
  );
}
