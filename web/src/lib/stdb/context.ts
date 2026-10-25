import { createContext } from 'react';
import type { Surface } from './queries';

/** The surface a subtree belongs to; data hooks return nothing for any other surface's connection. */
export const SurfaceContext = createContext<Surface | null>(null);
