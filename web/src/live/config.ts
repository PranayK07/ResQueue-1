// Which data source the app runs on, and where SpacetimeDB is. VITE_* values (web/.env.local) win; otherwise the
// server and database come from the repo-root .env through vite.config.ts, so the web app connects wherever
// scripts/dev.sh published the module.

export type DataSource = 'live' | 'sim';

const env = import.meta.env;
const read = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
// Undefined only outside Vite (e.g. a bare type-check run); the local sandbox is the safe default.
const defaults = typeof __STDB_DEFAULTS__ === 'undefined' ? { uri: 'ws://127.0.0.1:3000', db: 'wildfire-rescue' } : __STDB_DEFAULTS__;

export const DATA_SOURCE: DataSource = read(env.VITE_DATA_SOURCE)?.toLowerCase() === 'sim' ? 'sim' : 'live';
export const STDB_URI: string = read(env.VITE_STDB_URI) ?? defaults.uri;
export const STDB_DB: string = read(env.VITE_STDB_DB) ?? read(defaults.db) ?? 'wildfire-rescue';
export const isLive: boolean = DATA_SOURCE === 'live';

function configError(): string | null {
  let url: URL;
  try {
    url = new URL(STDB_URI);
  } catch {
    return `"${STDB_URI}" is not a valid SpacetimeDB address (VITE_STDB_URI or STDB_HTTP).`;
  }
  if (!/^(wss?|https?):$/.test(url.protocol)) return `"${STDB_URI}" must start with ws://, wss://, http:// or https://.`;
  return null;
}

/** Why the live connection can't start (a malformed address), or null. */
export const CONFIG_ERROR: string | null = isLive ? configError() : null;
