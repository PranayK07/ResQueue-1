import { useMemo } from 'react';

/** Marks an element as a guide anchor: `<section {...useAnchor('cmd.wind')}>`. */
export function useAnchor(id: string): { 'data-guide': string } {
  return useMemo(() => ({ 'data-guide': id }), [id]);
}

export function anchorSelector(id: string): string {
  return `[data-guide="${id.replace(/["\\]/g, '\\$&')}"]`;
}

export function findAnchor(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(anchorSelector(id));
}
