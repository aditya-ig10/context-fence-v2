Context Fence — macOS Install Notes
====================================

This build is ad-hoc signed (no Apple Developer ID — $0 distribution).
macOS Gatekeeper will try to block it. Three ways to install:

1. EASY: double-click Install.command in this dmg. It clears the
   quarantine flag and copies the app to /Applications.

2. MANUAL (if Install.command is also blocked):
   Right-click "Context Fence.app" -> Open -> Open (once per copy).

3. TERMINAL (if neither works):
   xattr -cr "/Applications/Context Fence.app" && open "/Applications/Context Fence.app"

First launch may take a few seconds (bundled backend starts in-process).

Upgrade path: with an Apple Developer ID ($99/yr) the same build is
notarized and ships as a normal double-click-install dmg with zero
friction.
