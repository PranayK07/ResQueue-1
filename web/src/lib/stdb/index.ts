// The shell's data API. Screens import from here (or lib/auth, lib/time, lib/geo), never from the SDK.
export type { ConnSnapshot, ConnState } from './connection';
export { CallError, mapCallError, mapServerError, type MappedError } from './errors';
export { useConnection, useSingleton, useTable, useView, type ConnectionInfo } from './hooks';
export { StdbProvider, useSurface } from './provider';
export { COMMAND, CREW, EVERYTHING, RESIDENT, WORLD, type Surface } from './queries';
export { call, useCall, type ReducerArgs, type ReducerName } from './reducers';
export type * from './rows';
