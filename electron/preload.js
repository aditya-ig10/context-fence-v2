// Context Fence — preload bridge.
//
// Two surfaces, both minimal:
//   - window.cfSetup: the first-run setup window's progress bridge.
//   - window.cfOauth: OAuth authorization-code flow trigger used by the
//     connector management UI (ConnectorCard / ConnectorDetail).
//     start(serverName) → Promise<{ ok: boolean; error?: string }>; resolves
//     when the browser flow completes/fails. The token exchange happens in
//     the backend; no token material ever crosses this bridge.
//   - window.cfUpdates: notify-only update check (Settings → GitHub API).
//     check() → Promise<{ ok, current, latest, updateAvailable, releaseUrl,
//     notes? } | { ok, error }>. Never downloads or installs anything.
//   - window.electronAuth: Google/Apple sign-in via loopback OAuth (Path B).
//     startOAuth('google') opens accounts.google.com in the system browser,
//     catches the code on a one-shot loopback, exchanges for tokens in the
//     main process, and resolves with { success, oauthIdToken, oauthAccessToken }.
//     Firebase sees only the final signInWithCredential call — no popup.
// The dashboard window never receives any other native capability.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cfSetup', {
  run: () => ipcRenderer.invoke('setup:run'),
  onProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
  done: () => ipcRenderer.send('setup:done'),
});

contextBridge.exposeInMainWorld('cfOauth', {
  start: (serverName) => ipcRenderer.invoke('oauth:start', serverName),
});

contextBridge.exposeInMainWorld('cfUpdates', {
  // Settings → main-process GitHub API check. Resolves with
  // { ok, current, latest, updateAvailable, releaseUrl, notes } | { ok, error }.
  check: () => ipcRenderer.invoke('app:check-update'),
});

// Google/Apple sign-in bridge (Path B — loopback OAuth, no popup).
// LoginPage.tsx checks window.electronAuth to decide which auth path to take.
// startOAuth('google') → invokes google:auth:start in main.js → returns
// { success, oauthIdToken, oauthAccessToken } → firebase.ts calls
// signInWithCredential(auth, GoogleAuthProvider.credential(idToken)).
// Apple is not yet implemented via loopback (requires Apple Developer account
// for Sign-in with Apple); falls back to signInWithPopup in the web path.
contextBridge.exposeInMainWorld('electronAuth', {
  startOAuth: (provider) => {
    if (provider === 'google') {
      return ipcRenderer.invoke('google:auth:start');
    }
    // Apple: not supported via loopback yet — return a clear error so
    // LoginPage can fall back to the web popup path gracefully.
    return Promise.resolve({ success: false, error: 'Apple sign-in not available in desktop app. Use email sign-in instead.' });
  },
});
