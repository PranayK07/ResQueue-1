import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'

// The repo-root .env (shared with scripts/dev.sh and the agents) says which SpacetimeDB the stack runs on. Only its
// STDB_* keys are read, so no secret can reach the bundle. VITE_STDB_URI / VITE_STDB_DB in web/.env.local still win.
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
// Same targets as agents/rescue/config.py: STDB_HTTP overrides STDB_SERVER.
const SERVERS: Record<string, string> = { local: 'ws://127.0.0.1:3000', maincloud: 'wss://maincloud.spacetimedb.com' }

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, REPO_ROOT, 'STDB_')
  const http = env.STDB_HTTP?.trim()
  const uri = http ? http.replace(/^http/, 'ws') : (SERVERS[env.STDB_SERVER?.trim() || 'local'] ?? SERVERS.local)
  return {
    plugins: [react()],
    define: {
      __STDB_DEFAULTS__: JSON.stringify({ uri, db: env.STDB_DB?.trim() || 'wildfire-rescue' }),
    },
  }
})
