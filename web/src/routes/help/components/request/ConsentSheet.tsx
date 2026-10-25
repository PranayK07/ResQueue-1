import type { ReactNode } from 'react';
import { HandHelping, LoaderCircle, MapPin, MessageSquareText, Users, type LucideIcon } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { Drawer, DrawerContent, DrawerDescription, DrawerFooter, DrawerTitle } from '@/lib/ui/drawer';
import { ConsentDurationPicker } from './ConsentDurationPicker';

export type ConsentSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sharing window in minutes, one of CONSENT_OPTIONS. */
  minutes: number;
  onMinutesChange: (m: number) => void;
  onContinue: () => void;
  /** Geolocation is running. Shows the spinner and blocks the button. */
  locating: boolean;
  /** Blocks the button, e.g. when the connection isn't live. */
  disabled: boolean;
  /** Set when a demo persona is active; shows the persona location line. */
  personaLabel?: string;
  /** Rendered as given above the button, e.g. <LocationProblem>. Bring its own role="alert". */
  problem?: ReactNode;
};

const SHARED: readonly { icon: LucideIcon; label: string }[] = [
  { icon: MapPin, label: 'Your location' },
  { icon: Users, label: 'How many people' },
  { icon: HandHelping, label: 'What you need' },
  { icon: MessageSquareText, label: 'Your note' },
];

/** Consent before anything is shared: what, who sees it, and for how long. */
export function ConsentSheet({
  open,
  onOpenChange,
  minutes,
  onMinutesChange,
  onContinue,
  locating,
  disabled,
  personaLabel,
  problem,
}: ConsentSheetProps) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="mx-auto max-w-md">
        <div className="shrink-0 px-5 pt-4 pb-3">
          <DrawerTitle className="text-lg font-semibold">Share your location with responders</DrawerTitle>
        </div>

        <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-2">
          <ul className="space-y-2.5" aria-label="What's shared">
            {SHARED.map(({ icon: Icon, label }) => (
              <li key={label} className="flex items-center gap-3 text-sm text-foreground">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                {label}
              </li>
            ))}
          </ul>

          <DrawerDescription>Only incident command and the crew assigned to you can see it.</DrawerDescription>

          <ConsentDurationPicker value={minutes} onChange={onMinutesChange} disabled={locating} />

          <p className="text-sm text-muted-foreground">
            Your location is deleted when the request closes or the time runs out.
          </p>
        </div>

        <DrawerFooter className="shrink-0 gap-3 px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          {problem}
          <Button
            type="button"
            className="h-14 w-full text-base"
            disabled={disabled || locating}
            aria-busy={locating || undefined}
            onClick={onContinue}
          >
            {locating ? (
              <>
                <LoaderCircle className="size-5 motion-safe:animate-spin" aria-hidden />
                Finding your location...
              </>
            ) : (
              'Share and continue'
            )}
          </Button>
          {personaLabel && (
            <p className="text-center text-xs text-muted-foreground">Using the demo persona's location.</p>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
