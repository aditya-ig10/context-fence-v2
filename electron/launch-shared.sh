#!/bin/bash
# Launch the packaged Context Fence.app against the SAME database the
# web/dev flow uses (backend/data/context-fence.db), so connectors, audit
# logs and settings are identical in the app and the browser.
#
# Why CF_DATA_DIR and not CF_USER_DATA: the DB path is derived from
# CF_DATA_DIR (electron/main.js), while Electron's own session state (the
# Firebase login) stays in the normal userData dir — so the Google account
# is preserved across quitting and reopening the app.
#
# IMPORTANT: run ONE backend at a time. The packaged app and the dev backend
# both bind the fixed MCP proxy ports (:3001/:3002) and both pin :3000 as the
# HTTP API port. Quit one before starting the other.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="/Applications/Context Fence.app"

if [ ! -d "$APP" ]; then
  echo "Packaged app not found at $APP" >&2
  echo "Build + install it first: cd electron && npm run prepare:backend && npm run dist" >&2
  exit 1
fi

if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  echo "Context Fence is already running — quit it first so this launch picks up the shared DB." >&2
  exit 1
fi

mkdir -p "$ROOT/backend/data"
export CF_DATA_DIR="$ROOT/backend/data"

echo "Launching Context Fence with shared DB: $CF_DATA_DIR"
echo "(web/dev backend reads the same file — never run them simultaneously)"
open "$APP"