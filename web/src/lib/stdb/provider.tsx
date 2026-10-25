import { useContext, useEffect, type ReactNode } from 'react';
import { connection } from './connection';
import { SurfaceContext } from './context';
import type { Surface } from './queries';
import type { SourceName } from './rows';

type StdbProviderProps = {
  surface: Surface;
  /** Override the surface's query set. Only the dev /_debug route does this. */
  sources?: readonly SourceName[];
  children: ReactNode;
};

/** Connects this tab as one surface and scopes the data hooks below it to that surface. */
export function StdbProvider({ surface, sources, children }: StdbProviderProps) {
  useEffect(() => {
    connection.use(surface, sources);
  }, [surface, sources]);
  return <SurfaceContext.Provider value={surface}>{children}</SurfaceContext.Provider>;
}

export function useSurface(): Surface | null {
  return useContext(SurfaceContext);
}
