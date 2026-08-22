#!/bin/bash
# Context Fence — macOS installer (Branch A: ad-hoc signed, Gatekeeper bypass)
# Run this after mounting the dmg. Removes quarantine from the app and
# installs it to /Applications.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Context Fence.app"
DEST="/Applications/Context Fence.app"

echo "==> Removing Gatekeeper quarantine flags (required for unsigned builds)..."
xattr -cr "$APP" 2>/dev/null || true

echo "==> Copying Context Fence.app to /Applications..."
if [ -d "$DEST" ]; then
  echo "    Removing existing copy at $DEST..."
  rm -rf "$DEST"
fi
cp -R "$APP" "$DEST"

echo "==> Done. Launching Context Fence..."
open "$DEST"
