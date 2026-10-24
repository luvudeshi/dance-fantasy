/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the FastAPI server. Unset in dev: Vite proxies /api and /ws to :8000. */
  readonly VITE_API_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
