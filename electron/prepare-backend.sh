#!/bin/bash
# Prepare a self-contained backend for bundling into the app (N7).
#
# Packaging strategy: BUNDLE EVERYTHING. The app ships with backend prod
# deps (including better-sqlite3 rebuilt for Electron's ABI) + compiled
# dist + policy + mcp scripts inside the .app bundle. First run needs
# neither internet nor npm. Tradeoff: bigger app (~deps size), and a
# rebuild step on dependency upgrades. Justified vs on-demand npm install:
# end users may be offline or behind proxies; bundling makes first-run
# deterministic.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/electron/staging/backend"
ELECTRON_VERSION="$("$ROOT/electron/node_modules/.bin/electron" --version 2>/dev/null | sed 's/^v//')"

echo "==> backend build (tsc -> dist)"
(cd "$ROOT/backend" && npm run build)

echo "==> staging prod-only backend -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$ROOT/backend/package.json" "$STAGE/"
cp -R "$ROOT/backend/dist" "$STAGE/dist"
cp -R "$ROOT/backend/scripts" "$STAGE/scripts"
cp "$ROOT/backend/context-fence.yaml" "$STAGE/"
# Ship the firewall's own MCP config so the packaged app discovers the same
# connectors as the dev flow (getMcpServersFromConfigs reads cwd/.mcp.json;
# without it the packaged backend finds nothing and Test MCP is empty).
cp "$ROOT/backend/.mcp.json" "$STAGE/"

echo "==> prod-only npm install (bundled; no network at user runtime)"
(cd "$STAGE" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3)

echo "==> rebuild native deps for Electron ABI v$ELECTRON_VERSION"
(cd "$ROOT/electron" && npx @electron/rebuild --version "$ELECTRON_VERSION" -f -w better-sqlite3 -m "$STAGE" 2>&1 | tail -4)

echo "==> staging size:"
du -sh "$STAGE"
