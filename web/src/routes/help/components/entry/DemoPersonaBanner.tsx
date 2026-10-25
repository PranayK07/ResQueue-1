import { MonoTag } from '@/lib/ui/MonoTag';
import { cn } from '@/lib/utils';

type DemoPersonaBannerProps = {
  /** Persona label from personas.ts. Always shown as a demo persona, never as a real person. */
  label: string;
  /** demo: opened from the ?demo=1 link. outside: the device's location is outside the grid. */
  reason: 'demo' | 'outside';
  className?: string;
};

/** Says plainly that this request uses an invented demo persona. */
export function DemoPersonaBanner({ label, reason, className }: DemoPersonaBannerProps) {
  return (
    <div
      role="note"
      className={cn(
        'rounded-card border border-dashed border-foreground/15 px-3.5 py-3 text-sm leading-5 text-muted-foreground',
        className
      )}
    >
      <p>
        Demo persona: <span className="font-medium text-foreground">{label}</span> <MonoTag>simulated</MonoTag>
      </p>
      {reason === 'outside' && (
        <p className="mt-1.5">Your location is outside the simulated incident area, so this demo uses a persona.</p>
      )}
    </div>
  );
}
