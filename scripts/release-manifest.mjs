#!/usr/bin/env node
/**
 * release-manifest.mjs — updates release.json, the machine-readable manifest
 * the website (aditya-ig10/CTFENCE-WEB) refetches every ~10 minutes to show
 * the latest version, sha256s and asset links on the downloads page.
 *
 * Used by both release paths:
 *   - the Windows CI (windows-release.yml) on every v* tag push, and
 *   - the manual macOS flow (see RELEASE.md step 8).
 *
 * Usage:
 *   RELEASE_VERSION=1.2.0 \
 *   RELEASE_DATE="aug 20, 2026" \
 *   DMG_URL="https://github.com/aditya-ig10/homebrew-context-fence/releases/download/v1.2.0/Context-Fence-1.2.0-universal.dmg" \
 *   DMG_SHA256=64-hex \
 *   DMG_SIZE="280 mb" \
 *   EXE_URL="https://github.com/aditya-ig10/context-fence/releases/download/v1.2.0/Context-Fence-Setup-1.2.0-x64.exe" \
 *   EXE_SHA256=64-hex \
 *   EXE_SIZE="120 mb" \
 *   LINUX_URL="https://github.com/aditya-ig10/context-fence-releases/releases/download/v1.2.0/Context-Fence-1.2.0-x64.AppImage" \
 *   LINUX_SHA256=64-hex \
 *   LINUX_SIZE="130 mb" \
 *   node scripts/release-manifest.mjs
 *
 * Unset variables are left untouched — a macOS-only bump never clobbers the
 * Windows fields and vice versa.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(root, "release.json");

const str = (v) => (v !== undefined && v !== null && String(v).trim() !== "" ? String(v).trim() : undefined);

const patch = (fields) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));

const version = str(process.env.RELEASE_VERSION);
const released = str(process.env.RELEASE_DATE) ?? undefined;

if (!version) {
  console.error("RELEASE_VERSION is required");
  process.exit(1);
}

const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
const platforms = existing.platforms ?? {};

const mac = patch({
  label: str(process.env.DMG_LABEL),
  sub: str(process.env.DMG_SUB),
  size: str(process.env.DMG_SIZE),
  sha256: str(process.env.DMG_SHA256),
  href: str(process.env.DMG_URL),
  unsigned: str(process.env.DMG_UNSIGNED),
});

const windows = patch({
  label: str(process.env.EXE_LABEL),
  sub: str(process.env.EXE_SUB),
  size: str(process.env.EXE_SIZE),
  sha256: str(process.env.EXE_SHA256),
  href: str(process.env.EXE_URL),
  unsigned: str(process.env.EXE_UNSIGNED),
});

const brew = patch({
  install: str(process.env.BREW_INSTALL),
  update: str(process.env.BREW_UPDATE),
});

// Linux (AppImage / deb / rpm) — the AppImage is the primary artifact whose
// href/sha/size land here; deb and rpm ride along on the same release. The
// "unsigned" field carries the install hint, mirroring how mac/win use it.
const linux = patch({
  label: str(process.env.LINUX_LABEL),
  sub: str(process.env.LINUX_SUB),
  size: str(process.env.LINUX_SIZE),
  sha256: str(process.env.LINUX_SHA256),
  href: str(process.env.LINUX_URL),
  unsigned: str(process.env.LINUX_UNSIGNED),
});

const next = {
  version,
  released: released ?? existing.released,
  platforms: {
    ...platforms,
    ...(Object.keys(mac).length ? { mac: { ...platforms.mac, ...mac } } : {}),
    ...(Object.keys(windows).length ? { windows: { ...platforms.windows, ...windows } } : {}),
    ...(Object.keys(brew).length ? { brew: { ...platforms.brew, ...brew } } : {}),
    ...(Object.keys(linux).length ? { linux: { ...platforms.linux, ...linux } } : {}),
  },
};

writeFileSync(manifestPath, `${JSON.stringify(next, null, 2)}\n`);
console.log(`release.json -> v${next.version} (${released ?? "date unchanged"})`);
