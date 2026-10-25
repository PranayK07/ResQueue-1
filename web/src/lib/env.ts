// Every connection setting comes from VITE_* env vars: the local sandbox in
// development, a hosted database for the demo. Nothing here has a fallback.

const read = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export const ENV = {
  stdbUri: read(import.meta.env.VITE_STDB_URI),
  stdbDb: read(import.meta.env.VITE_STDB_DB),
  mapStyleUrl: read(import.meta.env.VITE_MAP_STYLE_URL),
  intakeUrl: read(import.meta.env.VITE_INTAKE_URL),
} as const;

/** Names of required vars that are missing, for the config error state. */
export function missingStdbEnv(): string[] {
  const missing: string[] = [];
  if (!ENV.stdbUri) missing.push('VITE_STDB_URI');
  if (!ENV.stdbDb) missing.push('VITE_STDB_DB');
  return missing;
}
