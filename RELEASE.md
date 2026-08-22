# Context Fence — Release Guide (maintainer)

Full release cycle for Context Fence. One command ships the release
**everywhere**:

- **macOS** — universal dmg built locally and published, with a generated changelog
- **Windows** — `v*` tag push triggers CI: exe built on a Windows runner and published
- **Public releases repo** — `aditya-ig10/context-fence-releases` is the single home for **both** platforms' assets (dmg + exe) and their changelog notes, for every release from `v1.1.8-a` onwards
- **Homebrew tap** — cask formula bumped (`version` + `sha256`) and pushed
- **Website** — `release.json` (the manifest the `/downloads` page reads) is bumped here (mac side) and by CI (windows side), then auto-copied to the public releases repo (and the tap repo, legacy) so the site can fetch it without auth

## The public releases repo

`aditya-ig10/context-fence-releases` (public) hosts everything a user needs to
download and verify a version:

- release assets: `Context-Fence-<version>-universal.dmg` (macOS, Intel +
  Apple Silicon) and `Context-Fence-Setup-<version>-x64.exe` (Windows)
- changelog in the release notes — generated from `git log` since the previous
  tag, so every bug fix and feature ships with its release
- `release.json` on `main` — the manifest the website fetches

The main repo (`context-fence`) is **private**, so nothing there is reachable
by anonymous visitors — the releases repo exists to be public.

## Release in one command

```bash
scripts/release-all.sh vX.X.X
```

That's the whole flow. The script: bumps `electron/package.json` → builds the
universal dmg → publishes it (with changelog) to `context-fence-releases` →
updates the cask and pushes the tap → updates `release.json` → pushes the tag
(which fires the Windows CI). An agent can be asked to run exactly this.

Under the hood it runs, in order:

1. **Preflight** — `gh` authenticated, tap clone present (`TAP_DIR`, default `~/homebrew-context-fence`).
2. **Bump** — `electron/package.json` is the single source of truth (`npm version X.X.X --no-git-tag-version`). `build-mac.sh` reads the dmg version from it; `CFBundleShortVersionString` comes from it via electron-builder.
3. **Build** — `bash build-mac.sh universal`. Requires a macOS host; network required (prod npm install + Electron binary download for ABI rebuild).
4. **Publish dmg** — `gh release create` against `aditya-ig10/context-fence-releases`, notes generated from `git log` since the previous tag.
5. **Cask** — only two lines change in `Casks/context-fence.rb`: `version` and `sha256`. The `url` line derives from `v#{version}` interpolation against the releases repo — never touched.
6. **Manifest (mac side)** — `scripts/release-manifest.mjs` merges version/date/dmg sha/size into `release.json`, then commit + push.
7. **Tag push** — `git push origin vX.X.X` triggers `.github/workflows/windows-release.yml`, which builds the NSIS installer, publishes it to the SAME release in `context-fence-releases` (appending its sha/size row to the changelog), and bumps the manifest's windows fields (exe sha + size + url).
8. **Sync to public repos (automatic)** — when `windows-release` finishes, `.github/workflows/sync-release-manifest.yml` copies the final `release.json` into `aditya-ig10/context-fence-releases` (canonical — the website fetches it from here) and `aditya-ig10/homebrew-context-fence` (legacy mirror) via the contents API. The website picks it up within ~10 minutes (ISR).

## Manifest sync to the public repos

`release.json` must live in a **public** repo for the website to fetch it —
the main repo is private, so `raw.githubusercontent.com` 404s for anonymous
visitors and the downloads page falls back to its static copy.

`sync-release-manifest` automates the copy: on every `windows-release`
completion (or manual `workflow_dispatch`), it reads `release.json` from the
main repo and PUTs it to both public repos (`context-fence-releases` +
`homebrew-context-fence`, `main` branch). The website must point at:

```text
https://raw.githubusercontent.com/aditya-ig10/context-fence-releases/main/release.json
```

(`CTFENCE-WEB/lib/releases.ts`, `RELEASE_URL`.)

Setup (one-time, already done):

1. A PAT for `aditya-ig10` with `repo` scope (covers both destination repos).
   The default `GITHUB_TOKEN` cannot push to a different repository.
2. Store it as an Actions secret on the main repo:
   ```bash
   gh auth token | gh secret set TAP_REPO_TOKEN -R aditya-ig10/context-fence
   ```

Backfill a release that shipped before the workflow existed (done once for
v1.1.8 / v1.1.8-a):

```bash
gh api repos/aditya-ig10/context-fence/contents/release.json --jq '.content' | base64 -D > /tmp/release.json
CONTENT=$(openssl base64 -A -in /tmp/release.json)
for REPO in aditya-ig10/context-fence-releases aditya-ig10/homebrew-context-fence; do
  SHA=$(gh api repos/$REPO/contents/release.json --jq .sha 2>/dev/null || true)
  jq -n --arg c "$CONTENT" --arg s "$SHA" \
    '{message: "chore: sync release manifest", content: $c} +
     (if $s != "" then {sha: $s} else {} end)' \
    | gh api --method PUT repos/$REPO/contents/release.json \
      --input - --jq '.commit.sha'
done
```

## Verify the build before it ships (never skip)

```bash
file "electron/release/mac-universal/Context Fence.app/Contents/MacOS/Context Fence"
```

Must show: `Mach-O universal binary with 2 architectures: [x86_64 ...] [arm64 ...]`.
Anything else = stop. An arm64-only dmg will read as "damaged" on Intel Macs.

## Known gotchas (re-check every release)

1. **`--universal` flag is mandatory.** `--config.mac.target.0.arch=universal` is a silent no-op (the target is a string array) — the build silently falls back to host arch.
2. **`x64ArchFiles` lives under `mac` in `electron/package.json`**, not the config root. Schema rejects it at root. Pattern: `"x64ArchFiles": "**/prebuilds/*.node"`. Without it the universal merge fails on identical `better-sqlite3` prebuilds (Mach-O with identical SHAs across x64/arm64 builds).
3. The dmg staging dir is wiped and rebuilt by the script (`rm -rf release/dmg-staging`) — don't hand-edit files there; edits go in `electron/dmg-assets/` (Install.command, README.txt).
4. `build-mac.sh` can fail once on a download race — just rerun it.
5. `gh release create` fails with `Repository is empty` only on a brand-new repo (one-time, already fixed).
6. The Windows CI runs on `windows-2022` (pinned — `windows-latest` images VS 2026, which node-gyp 11.5 cannot parse). Never "fix" that to `windows-latest`.
7. The CI publishes the exe to the release the mac side already created in `context-fence-releases` — if the mac release was skipped (CI-only run), the workflow's `create-or-upload` fallback still uploads the exe and generates the changelog itself.
8. The changelog notes file (`electron/release/release-notes-<version>.md`) is a local build artifact — it is NOT committed. CI regenerates the notes when it is absent.

## Verify the website picked it up

`/downloads` → the version pill, sha256s and sizes must read `vX.X.X` within
~10 minutes of the tag push (ISR revalidation). No redeploy needed. The site
fetches the public releases repo URL, so a quick sanity check is:

```bash
curl -s https://raw.githubusercontent.com/aditya-ig10/context-fence-releases/main/release.json | jq .version
```

## Self-test before announcing

```bash
brew update
brew upgrade --cask context-fence
```

Then verify:

```bash
xattr -l "/Applications/Context Fence.app"            # expect: empty (or com.apple.provenance only — never com.apple.quarantine)
open "/Applications/Context Fence.app"                # dashboard window appears
lsof -iTCP -sTCP:LISTEN -P | grep -i context          # expect: ports 3001, 3002, + one random high port
```

**Do NOT curl `localhost:3000`** — the Electron shell picks a random API port by design; 3001/3002 are the stable check targets.

## Rollback (broken release)

```bash
# 1. Delete the release + tag
gh release delete vX.X.X --repo aditya-ig10/context-fence-releases --yes --cleanup-tag

# 2. Revert the cask to the last good version
cd ~/homebrew-context-fence
git log --oneline -3                       # find the "add context-fence cask vX.X.X" commit
git revert <bad-commit-hash>               # restores previous version + sha256
git push origin main

# 3. Revert the manifest to the last good version (website follows)
git revert <manifest-bump-commit>          # in the context-fence repo
git push origin master
# then re-sync the public copies (the workflow only runs on releases):
# dispatch the sync-release-manifest workflow manually, or rerun the
# backfill commands from "Manifest sync to the public repos" above

# 4. Friends who already pulled the broken version must reset their state:
brew uninstall --cask context-fence
brew untap aditya-ig10/context-fence
brew tap aditya-ig10/context-fence
brew trust --cask aditya-ig10/context-fence/context-fence   # only if trust didn't survive the untap
brew install --cask context-fence
```

Note: `brew upgrade` will not reinstall a same-version cask — after a rollback the bumped tag is gone, so downgrades always go through the untap/tap flow above.
