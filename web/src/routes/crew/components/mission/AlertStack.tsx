import type { ReactNode } from 'react';
import { useAnchor } from '@/lib/guide';
import { cn } from '@/lib/utils';

export type AlertStackProps = {
  /** AlertBanner elements, most urgent first. */
  children: ReactNode;
  className?: string;
};

/** Column of AlertBanners under the header. */
export function AlertStack({ children, className }: AlertStackProps) {
  const anchor = useAnchor('crew.alerts');
  return (
    <div {...anchor} className={cn('flex flex-col gap-2', className)}>
      {children}
    </div>
  );
}
