import type { CSSProperties } from 'react';
import { cn } from '@/lib/utils';

// Cheap virtualization: the browser skips layout and paint for rows scrolled out of
// view. "auto" remembers each row's real size once it has rendered, so the
// scrollbar stays steady.
export const QUEUE_ROW_STYLE: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 76px' };
export const ASSESSING_ROW_STYLE: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' };

/**
 * A clickable row: hover, the focus ring for keyboard users, and a neutral ring when
 * selected. Rings are inset because content-visibility adds paint containment, which
 * would clip an outer ring at the row's edges.
 */
export function rowButtonClass(selected: boolean, className?: string): string {
  return cn(
    'w-full rounded-md px-2 py-2 text-left transition-colors duration-150 ease-out',
    'hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none',
    selected && 'bg-accent ring-1 ring-foreground/40 ring-inset',
    className
  );
}
