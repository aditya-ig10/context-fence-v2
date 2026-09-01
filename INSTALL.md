# Installing Context Fence

Follow these steps in order. If something doesn't work, screenshot the error and send it.

## 1. Check if you have Homebrew

Open **Terminal** (press `Cmd + Space`, type `Terminal`, press Return), then paste:

```
brew --version
```

- If you see a version number like `Homebrew 6.x.x` — good, skip to step 2.
- If you see `command not found` — go to https://brew.sh and paste the one-line install command it shows into Terminal. Wait for it to finish (it can take a few minutes), then come back here.

## 2. Add the app's download source (one-time)

```
brew tap aditya-ig10/context-fence-v2
```

## 3. Trust the download source (one-time)

```
brew trust --cask aditya-ig10/context-fence/context-fence
```

(If it says already trusted, that's fine — keep going.)

## 4. Install

```
brew install --cask context-fence
```

This downloads and installs the app. The first time you open it, macOS may ask **"Context Fence wants to accept incoming connections"** — click **Allow** (that's the firewall feature working).

## 5. Open the app

Click the **Finder** icon in your dock, click **Applications** in the sidebar, double-click **Context Fence**.

First launch can take ~10 seconds (it's starting a small built-in server). A dashboard window should appear.

## 6. Check it's actually running

Back in Terminal, paste:

```
lsof -iTCP -sTCP:LISTEN -P | grep -i context
```

**Normal:** you see 2-3 lines with "Context" in them, including ports `3001` and `3002`.

**Not normal:** empty output, or an error message. Screenshot the Terminal window and the app state, send both.

## 7. What to report if it's broken

Send a screenshot of anything like:

- "Context Fence cannot be opened because the developer cannot be verified" / "is damaged"
- The app icon bounces in the dock and then disappears (quits on its own)
- Step 6 shows no ports at all
- Anything that asks you to download it "from the internet" or blocks opening it

Just screenshot it and send it — don't try to fix it yourself.

## Updating

When a new version comes out:

```
brew update
brew upgrade --cask context-fence
```

Your rules, connectors and audit log are kept — only the app itself is replaced. The app's own **Settings → Updates → Check for Updates** button will tell you when a new release exists.

## Uninstall

```
brew uninstall --cask context-fence && brew untap aditya-ig10/context-fence
```

> v2 tap: `aditya-ig10/context-fence-v2` supports side-by-side install with v1.
