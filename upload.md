# Release and Deployment Guide

This document outlines the standard operating procedure for building and releasing a new version of Context Fence across all platforms (macOS Homebrew, Windows Installer, and In-App Update Notifications).

## Overview

When releasing a new version (e.g., `v1.1.2`), three things must happen:
1. **macOS**: Build the universal DMG locally, upload it to the Homebrew tap's GitHub release, and update the Cask formula (`context-fence.rb`).
2. **Windows**: Trigger the automated GitHub Actions CI workflow to build the `.exe` installer.
3. **In-App Update**: By publishing the GitHub release on the main repository (or tap), the app's internal version checker will automatically detect the new version and notify users.

---

## Step-by-Step Deployment Process

### 1. Bump the Version
First, update the version number across all three `package.json` files (`backend`, `frontend`, `electron`).

```bash
# Example script to bump versions to 1.1.2
node -e "
const fs = require('fs');
['backend/package.json','frontend/package.json','electron/package.json'].forEach(f => {
  const p = JSON.parse(fs.readFileSync(f,'utf8'));
  p.version = '1.1.2';
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n');
  console.log(f, '->', p.version);
});
"
```

Commit the changes:
```bash
git add backend/package.json frontend/package.json electron/package.json
git commit -m "feat: v1.1.2 release"
git push origin master
```

### 2. Build the macOS DMG (Local)
Run the Electron build script to compile the backend, frontend, and package them into a universal macOS DMG.

```bash
bash electron/build-mac.sh universal 2>&1
```
*This process takes roughly 3-5 minutes and outputs `Context-Fence-1.1.2-universal.dmg` in the `electron/release/` directory.*

### 3. Compute the SHA256 Checksum
Homebrew requires a SHA256 hash to verify the integrity of the downloaded DMG.

```bash
shasum -a 256 electron/release/Context-Fence-1.1.2-universal.dmg
```
*(Copy the resulting hash for the next step).*

### 4. Create the Homebrew Release & Upload the DMG
We use the GitHub CLI (`gh`) to create a new release on the custom Homebrew tap repository and upload the DMG asset.

```bash
# Create the release
gh release create v1.1.2 \
  --repo aditya-ig10/homebrew-context-fence \
  --title "Context Fence v1.1.2" \
  --notes "Release notes here..."

# Upload the DMG asset
gh release upload v1.1.2 \
  "electron/release/Context-Fence-1.1.2-universal.dmg" \
  --repo aditya-ig10/homebrew-context-fence \
  --clobber
```

### 5. Update the Homebrew Cask Formula
Update the `Casks/context-fence.rb` file in the tap repository to point to the new version and the new SHA256 hash. 

Create a temporary file `context-fence-1.1.2.rb` with the updated formula:
```ruby
cask "context-fence" do
  version "1.1.2"
  sha256 "<THE_NEW_SHA256_HASH_HERE>"

  url "https://github.com/aditya-ig10/homebrew-context-fence/releases/download/v#{version}/Context-Fence-#{version}-universal.dmg"
  name "Context Fence"
  desc "Local-first MCP security proxy for AI coding agents"
  homepage "https://github.com/aditya-ig10/context-fence"

  app "Context Fence.app"

  postflight do
    system_command "/usr/bin/xattr",
                    args: ["-cr", "#{appdir}/Context Fence.app"]
  end

  zap trash: [
    "~/Library/Application Support/Context Fence",
    "~/Library/Preferences/com.contextfence.app.plist",
  ]
end
```

Push the updated formula directly via the GitHub API:
```bash
# Get current file SHA
FILE_SHA=$(gh api repos/aditya-ig10/homebrew-context-fence/contents/Casks/context-fence.rb --jq '.sha')

# Base64-encode the new cask content
NEW_CONTENT=$(base64 -i context-fence-1.1.2.rb)

# Push updated cask formula
gh api -X PUT repos/aditya-ig10/homebrew-context-fence/contents/Casks/context-fence.rb \
  --field message="cask: update to v1.1.2" \
  --field content="$NEW_CONTENT" \
  --field sha="$FILE_SHA" \
  --jq '.commit.sha'
```

### 6. Trigger the Windows Build
The Windows `.exe` installer is built automatically by GitHub Actions when a new version tag is pushed to the main repository.

```bash
git tag v1.1.2
git push origin v1.1.2
```

This triggers the `.github/workflows/windows-release.yml` workflow, which will compile the Windows executable and publish it to the `v1.1.2` release on the main `context-fence` repository.

---

## User Upgrade Instructions

Once the above steps are complete, users can upgrade their installations:

**macOS Users:**
```bash
brew update
brew upgrade --cask context-fence
```

**Windows Users:**
The app will display an "Update available" notification. Users can download the new `.exe` from the latest GitHub release and run the installer. All data is preserved during the upgrade.
