import type { Route } from './routing';
import type { Grid, RoadClosure, FireCell } from './types';
export interface RoadPoint { lon: number; lat: number; name: string }
export interface RoadGraph { nodes: { id: number; lon: number; lat: number }[]; edges: { id: string; from: number; to: number; name: string; speedMps: number; oneway: boolean }[] }
export interface RoadContext { grid?: Grid; fireCells?: readonly FireCell[]; closures?: readonly RoadClosure[] }
export function distance(a: [number, number], b: [number, number]): number;
export function blockedEdges(graph: RoadGraph, context?: RoadContext): Set<string>;
export function roadRoute(graph: RoadGraph, from: [number, number], to: [number, number], context?: RoadContext): Route;
export function routeFromPoints(points: RoadPoint[], durationS: number): Route;
export function positionAlong(points: RoadPoint[], fraction: number): [number, number] | null;
export function unavailable(reason: string): Route;
