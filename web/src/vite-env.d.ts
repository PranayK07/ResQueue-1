/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'live' (default): SpacetimeDB. 'sim': the in-browser simulation. */
  readonly VITE_DATA_SOURCE?: string;
  readonly VITE_STDB_URI?: string;
  readonly VITE_STDB_DB?: string;
}

/** SpacetimeDB server and database from the repo-root .env (see vite.config.ts). */
declare const __STDB_DEFAULTS__: { uri: string; db: string };
