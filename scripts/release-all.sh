#!/usr/bin/env bash
set -euo pipefail

# release-all.sh — ONE command ships a Context Fence release everywhere.
#
#   scripts/release-all.sh v1.2.0
#
# 1. macOS  — builds the universal dmg (build-mac.sh) and publishes it to the
#             homebrew-context-fence tap repo's GitHub release
# 2. tap    — bumps the cask formula (version + sha256) and pushes it
# 3. tag    — pushes v1.2.0, which triggers windows-release.yml CI: the exe is
#             built on a Windows runner, published, and the manifest bumped
# 4. web    — release.json is updated here (mac side) and by the CI (windows
#             side); the website refetches it on a ~10 minute cadence — no
#             redeploy, the downloads page just starts showing the new version
#
# Requires: gh (authenticated), git, macOS host for the dmg build.
# TAP_DIR overrides the tap clone (default ~/homebrew-context-fence).

VERSION="${1:-}"
VERSION="${VERSION#v}"
if [[ -z "$VERSION" ]]; then
  echo "usage: release-all.sh vX.X.X"
  exit 1
fi
TAG="v$VERSION"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAP_DIR="${TAP_DIR:-$HOME/homebrew-context-fence}"
TAP_REPO="aditya-ig10/homebrew-context-fence"
# Public releases repo: BOTH platforms' assets live here from v1.1.8-a on
# (dmg + exe + changelog notes). The website's /downloads page reads
# release.json from this repo.
RELEASES_REPO="aditya-ig10/context-fence-releases"
TAP_CASK="$TAP_DIR/Casks/context-fence.rb"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "preflight"
command -v gh >/dev/null 2>&1 || { echo "error: gh CLI is required"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated"; exit 1; }
[[ -f "$TAP_CASK" ]] || { echo "error: tap clone not found at $TAP_DIR (set TAP_DIR)"; exit 1; }
BRANCH="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
TAP_BRANCH="$(git -C "$TAP_DIR" rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" == "master" ]] || echo "warn: repo not on master (on $BRANCH)"

step "bump version to $VERSION (electron/package.json — single source of truth)"
CURRENT="$(node -p "require('$ROOT/electron/package.json').version")"
if [[ "$CURRENT" == "$VERSION" ]]; then
  echo "version already $VERSION — skipping bump"
else
  (cd "$ROOT/electron" && npm version "$VERSION" --no-git-tag-version)
fi

step "build universal dmg"
(cd "$ROOT/electron" && bash build-mac.sh universal)

DMG="$ROOT/electron/release/Context-Fence-$VERSION-universal.dmg"
[[ -f "$DMG" ]] || { echo "error: dmg not found: $DMG"; exit 1; }
SHA256="$(shasum -a 256 "$DMG" | awk '{print $1}')"
SIZE_MB="$(awk -v b="$(stat -f%z "$DMG")" 'BEGIN { printf "%.1f", b / 1048576 }')"

# Changelog for the release notes: git log since the previous tag (the new
# tag does not exist yet when the dmg release is created — the newest existing
# tag is the previous release).
PREV_TAG="$(git -C "$ROOT" tag --sort=-creatordate | head -1)"
RELEASE_NOTES="$ROOT/electron/release/release-notes-$VERSION.md"
{
  echo "# Context Fence v$VERSION"
  echo
  echo "Local-first MCP security proxy. Universal binary (Intel + Apple Silicon) for macOS, NSIS installer for Windows x64."
  echo
  echo "## Changelog"
  if [[ -n "$PREV_TAG" ]]; then
    git -C "$ROOT" log --oneline --no-merges "$PREV_TAG..HEAD" | sed 's/^/- /'
  else
    echo "- Initial public release."
  fi
  echo
  echo "## Downloads"
  echo "- **macOS** (Intel + Apple Silicon): \`Context-Fence-$VERSION-universal.dmg\` — ${SIZE_MB} mb — sha256 \`$SHA256\`"
  echo "- **Windows x64**: \`Context-Fence-Setup-$VERSION-x64.exe\` (added by the Windows CI when it publishes)"
  echo
  echo "macOS: unsigned (ad-hoc) — if Gatekeeper blocks it, right-click → Open. Windows: Authenticode-signed (developer cert) — SmartScreen may still prompt until reputation builds. Verify the sha256 after download."
} > "$RELEASE_NOTES"

step "publish dmg to $RELEASES_REPO release (with changelog)"
gh release create "$TAG" "$DMG" \
  --repo "$RELEASES_REPO" \
  --title "Context Fence v$VERSION" \
  --notes-file "$RELEASE_NOTES"

step "bump cask formula ($TAP_CASK)"
node - "$TAP_CASK" "$VERSION" "$SHA256" <<'NODE'
const [path, version, sha] = process.argv.slice(2);
const fs = require("fs");
const src = fs.readFileSync(path, "utf8");
const out = src
  .replace(/version "[^"]*"/, `version "${version}"`)
  .replace(/sha256 "[^"]*"/, `sha256 "${sha}"`);
if (out === src) {
  console.error("cask: version/sha256 lines not found — nothing changed");
  process.exit(1);
}
fs.writeFileSync(path, out);
NODE

step "push tap repo"
(cd "$TAP_DIR" && git add Casks/context-fence.rb \
  && git commit -m "add context-fence cask v$VERSION" \
  && git push origin "$TAP_BRANCH")

step "update release.json — the manifest the website reads"
RELEASE_VERSION="$VERSION" \
RELEASE_DATE="$(date '+%b %-d, %Y' | tr '[:upper:]' '[:lower:]')" \
DMG_URL="https://github.com/$RELEASES_REPO/releases/download/$TAG/Context-Fence-$VERSION-universal.dmg" \
DMG_SHA256="$SHA256" \
DMG_SIZE="${SIZE_MB} mb" \
node "$ROOT/scripts/release-manifest.mjs"
git add release.json
git commit -m "release: bump manifest to $TAG"
git push origin "$BRANCH"

step "push tag — windows CI builds the exe, publishes it, bumps the manifest"
git tag "$TAG"
git push origin "$TAG"

echo
echo "done — v$VERSION is live everywhere:"
echo "  release:       $RELEASES_REPO/releases/tag/$TAG (dmg + exe, changelog)"
echo "  homebrew:      brew upgrade --cask context-fence"
echo "  website:       /downloads shows v$VERSION within ~10 minutes"