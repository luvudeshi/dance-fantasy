#!/usr/bin/env bash
# Start the API server (:8000) and the web dev server (:5173) together.
# Ctrl-C stops both. Works with macOS's stock bash 3.2.
set -euo pipefail
set -m # each background job gets its own process group, so we can stop its children too
# (jobs get stdin from /dev/null below: with job control on, a background job reading the TTY would be stopped)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8000}"

command -v uv >/dev/null 2>&1 || { echo "uv not found. Install it: brew install uv (see README)"; exit 1; }
command -v npm >/dev/null 2>&1 || { echo "npm not found. Install Node.js 22+ (see README)"; exit 1; }
[ -d "$ROOT/server/.venv" ] || (cd "$ROOT/server" && uv sync)
[ -d "$ROOT/web/node_modules" ] || (cd "$ROOT/web" && npm install)

prefix() { # prefix <tag> <ansi color>: tag every line of stdin
  while IFS= read -r line; do printf '\033[%sm[%s]\033[0m %s\n' "$2" "$1" "$line"; done
}

API_PID=""
WEB_PID=""
cleanup() {
  trap - INT TERM EXIT
  for pid in $API_PID $WEB_PID; do kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

(cd "$ROOT/server" && exec uv run uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port "$API_PORT") \
  < /dev/null > >(prefix api 35) 2>&1 &
API_PID=$!
(cd "$ROOT/web" && exec npm run dev) < /dev/null > >(prefix web 36) 2>&1 &
WEB_PID=$!

printf '\n  API  http://127.0.0.1:%s/api/health\n  Web  http://localhost:5173\n  Ctrl-C stops both.\n\n' "$API_PORT"

# Exit (and stop the other one) as soon as either process dies.
while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null; do sleep 1; done
echo "One of the dev servers exited; stopping the other."
