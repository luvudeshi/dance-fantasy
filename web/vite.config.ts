/// <reference types="vitest/config" />
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { createLogger, defineConfig, type Logger } from 'vite'

const API_TARGET = 'http://127.0.0.1:8000'
const API_DOWN_NOTICE_MS = 60_000

function isConnRefused(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if ('code' in err && err.code === 'ECONNREFUSED') return true
  return err instanceof AggregateError && err.errors.some(isConnRefused)
}

/**
 * Vite's proxy logs a full ECONNREFUSED stack for every proxied request while the API
 * server is down (the header's health poll alone makes one every few seconds). Collapse
 * those into one short line per minute; every other message passes through unchanged.
 * The browser still gets Vite's 502, which src/api.ts reports as "Server not reachable".
 */
function quietProxyLogger(): Logger {
  const logger = createLogger()
  const logError = logger.error.bind(logger)
  let lastNotice = Number.NEGATIVE_INFINITY
  logger.error = (msg, options) => {
    if (msg.includes('proxy error') && isConnRefused(options?.error)) {
      const now = Date.now()
      if (now - lastNotice >= API_DOWN_NOTICE_MS) {
        lastNotice = now
        logger.warn(`API server not reachable at ${API_TARGET} (proxy answers 502); start it with \`make server\``, {
          timestamp: true,
        })
      }
      return
    }
    logError(msg, options)
  }
  return logger
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  customLogger: quietProxyLogger(),
  // One .env at the repo root. Only VITE_* variables are exposed to client code.
  envDir: '..',
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API_TARGET,
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
    // Serve this project ('.', incl. node_modules) plus ../shared, nothing else from the
    // repo (entries resolve against the web root). .env files also stay blocked by Vite's
    // default server.fs.deny list.
    fs: { allow: ['.', '../shared'] },
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
})
