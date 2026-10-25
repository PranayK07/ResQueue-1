/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_STDB_URI?: string;
  readonly VITE_STDB_DB?: string;
  readonly VITE_MAP_STYLE_URL?: string;
  readonly VITE_INTAKE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
