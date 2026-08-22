#!/bin/bash
# Context Fence — reproducible macOS dmg build (Branch A: ad-hoc signed)
# Usage: ./build-mac.sh [arm64|x64|universal]  (default: host arch)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-$(uname -m)}"
APP_NAME="Context Fence.app"
VERSION="$(node -p "require('$ROOT/electron/package.json').version")"
DMG_ARCH=""
EB_FLAGS=""

case "$ARCH" in
  universal)            DMG_ARCH="universal"; EB_FLAGS="--universal" ;;
  arm64|aarch64)        DMG_ARCH="arm64";     EB_FLAGS="--arm64" ;;
  x64|x86_64)           DMG_ARCH="x64";       EB_FLAGS="--x64" ;;
  *) echo "usage: $0 [arm64|x64|universal]"; exit 1 ;;
esac

echo "==> [1/6] backend build (tsc)"
(cd "$ROOT/backend" && npm run build)

echo "==> [2/6] frontend build (vite)"
(cd "$ROOT/frontend" && npm run build)

echo "==> [3/6] stage backend + rebuild native deps for Electron ABI"
(cd "$ROOT/electron" && bash prepare-backend.sh)

echo "==> [4/6] electron-builder pack (unpacked .app, arch=$DMG_ARCH)"
rm -rf "$ROOT/electron/release/mac-$DMG_ARCH"
(cd "$ROOT/electron" && npx electron-builder --mac --dir $EB_FLAGS 2>&1 | tail -5)

echo "==> [5/6] ad-hoc codesign (BRANCH A)"
codesign --force --deep --sign - "$ROOT/electron/release/mac-$DMG_ARCH/$APP_NAME"
codesign -dv "$ROOT/electron/release/mac-$DMG_ARCH/$APP_NAME" 2>&1 | grep Signature

echo "==> [6/6] dmg wrap (hdiutil, with Install.command + README + Applications link)"
STAGE="$ROOT/electron/release/dmg-staging"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/electron/release/mac-$DMG_ARCH/$APP_NAME" "$STAGE/"
cp "$ROOT/electron/dmg-assets/Install.command" "$STAGE/"
cp "$ROOT/electron/dmg-assets/README.txt" "$STAGE/"
ln -sf /Applications "$STAGE/Applications"
chmod +x "$STAGE/Install.command"
OUT="$ROOT/electron/release/Context-Fence-$VERSION-$DMG_ARCH.dmg"
rm -f "$OUT"
hdiutil create -volname "Context Fence" -srcfolder "$STAGE" -ov -format UDZO "$OUT" 2>&1 | tail -2

echo "==> done: $OUT"
