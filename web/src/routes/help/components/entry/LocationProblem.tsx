import { LocateOff, MapPinOff, MapPinX, RotateCw, UserRound, type LucideIcon } from 'lucide-react';
import { Button } from '@/lib/ui/button';
import { cn } from '@/lib/utils';
import { Call911Link } from './Call911Link';

type LocationProblemKind = 'denied' | 'unavailable' | 'outside';

type LocationProblemProps = {
  kind: LocationProblemKind;
  /** Shows "Try again" when given. */
  onRetry?: () => void;
  /** Shows "Use the demo persona" when given (demo mode, or the device is outside the grid). */
  onUsePersona?: () => void;
  className?: string;
};

const COPY: Record<LocationProblemKind, { icon: LucideIcon; text: string }> = {
  denied: { icon: MapPinOff, text: 'A crew needs your location to find you. Call 911.' },
  unavailable: { icon: LocateOff, text: "We couldn't get your location. Try again, or call 911." },
  outside: { icon: MapPinX, text: "You're outside the active incident area." },
};

const ACTION = 'h-auto min-h-12 w-full gap-2 text-base';

/** Why we can't use this device's location. Call 911 is always offered. */
export function LocationProblem({ kind, onRetry, onUsePersona, className }: LocationProblemProps) {
  const { icon: Icon, text } = COPY[kind];
  return (
    <div
      role="alert"
      className={cn('flex flex-col gap-3 rounded-card border border-lvl-high/30 bg-lvl-high/10 p-4', className)}
    >
      <p className="flex items-start gap-2.5 text-base font-medium text-foreground">
        <Icon className="mt-0.5 size-5 shrink-0 text-lvl-high" aria-hidden />
        <span>{text}</span>
      </p>
      <Call911Link size="block" />
      {onRetry && (
        <Button type="button" variant="outline" onClick={() => onRetry()} className={ACTION}>
          <RotateCw className="size-5" aria-hidden />
          Try again
        </Button>
      )}
      {onUsePersona && (
        <Button type="button" variant="outline" onClick={() => onUsePersona()} className={ACTION}>
          <UserRound className="size-5" aria-hidden />
          Use the demo persona
        </Button>
      )}
    </div>
  );
}
