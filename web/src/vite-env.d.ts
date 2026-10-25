/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL of the FastAPI server. Unset in dev: Vite proxies /api and /ws to :8000. */
  readonly VITE_API_BASE?: string
  /** '1' on Vercel deployments: uploads go to Vercel Blob first (request bodies cap at 4.5 MB). */
  readonly VITE_BLOB_UPLOADS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
