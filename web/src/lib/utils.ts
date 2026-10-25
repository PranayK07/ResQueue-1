import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge the theme's custom radii (rounded-frame, rounded-card) so
// a className override wins over a component's built-in rounded-* class.
const twMerge = extendTailwindMerge({ extend: { theme: { radius: ['frame', 'card'] } } });

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
