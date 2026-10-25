import { useId, type ReactNode } from 'react';
import { APP_NAME } from '@/lib/app';
import { cn } from '@/lib/utils';

export type GateFrameProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  className?: string;
};

/** Full-height, centered 20px frame shared by the /crew sign-in steps. */
export function GateFrame({ title, subtitle, children, className }: GateFrameProps) {
  const titleId = useId();

  return (
    <div className={cn('flex min-h-dvh w-full items-center justify-center px-4 py-8', className)}>
      <section
        aria-labelledby={titleId}
        className="flex w-full max-w-sm flex-col gap-6 rounded-frame border border-border bg-surface p-6"
      >
        <header className="flex flex-col gap-1.5">
          <p className="label-caps">{APP_NAME}</p>
          <h1 id={titleId} className="text-xl leading-7 font-semibold text-foreground">
            {title}
          </h1>
          {subtitle != null && <p className="text-sm text-muted-foreground">{subtitle}</p>}
        </header>
        {children}
      </section>
    </div>
  );
}
