// Context Fence — Electron main process.
//
// Owns the backend's full lifecycle:
//   - spawns the real backend entry (dev: `npm exec tsx src/index.ts`;
//     packaged: ELECTRON_RUN_AS_NODE + compiled dist/index.js) as a detached
//     child so the whole tree (including lazily-spawned MCP server children)
//     can be killed as one process group on quit — no orphans.
//   - waits for /api/health 200 before showing the app window.
//   - first run (no SQLite DB in userData/data): shows a native setup window
//     whose steps report real progress over IPC before the app window opens.
//
// Security defaults: nodeIntegration off, contextIsolation on, sandbox on.
// The only preload surface is the setup bridge (window.cfSetup) used by the
// setup window; the dashboard window never receives native capability.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { URL, URLSearchParams } = require('url');
const { startOauthFlow, pkcePair, base64url, listenLoopback } = require('./oauth-flow.js');
const { checkForUpdates } = require('./updates.js');
const crypto = require('crypto');

const DEV = !app.isPackaged;
const APP_NAME = 'Context Fence';

// ── Google OAuth Desktop client credentials ───────────────────────────────
// These are a Desktop app OAuth 2.0 client (not the Firebase web client).
// Desktop client secrets are NOT sensitive — Google's security model for
// Desktop apps relies on PKCE, not the secret (the secret is embedded in
// every user's binary anyway). env vars override for dev flexibility.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID ||
  '751149542813-si762lkjhvfno5e26fs30d36j29cc9sm.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET ||
  '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';

// Allow tests to isolate the app-data location (N5/N8).
const USER_DATA = process.env.CF_USER_DATA || app.getPath('userData');
app.setPath('userData', USER_DATA);
fs.mkdirSync(USER_DATA, { recursive: true });

// CF_DATA_DIR override lets the packaged app share the repo's dev database
// (see launch-shared.sh) WITHOUT moving Electron's own userData — so the
// Firebase session, cookies and storage stay at their normal persistent path
// and the signed-in Google account survives quitting/reopening the app.
const DATA_DIR = process.env.CF_DATA_DIR || path.join(USER_DATA, 'data');
const DB_PATH = path.join(DATA_DIR, 'context-fence.db');
const POLICY_SOURCE = DEV
  ? path.join(__dirname, '..', 'backend', 'context-fence.yaml')
  : path.join(process.resourcesPath, 'backend', 'context-fence.yaml');
const POLICY_TARGET = path.join(USER_DATA, 'context-fence.yaml');

// Dev mode reuses the real dev stack: vite on :5173 proxies /api to :3000,
// so the Electron-managed backend must own :3000 in dev.
const DEV_BACKEND_PORT = 3000;

let backendPort = null;
let backendChild = null;
let appWindow = null;
let setupWindow = null;
let setupPhase = null; // 'backend-up' while setup owns a running backend

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function backendEntry() {
  if (DEV) {
    return {
      cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
      args: ['exec', 'tsx', 'src/index.ts'],
      cwd: path.join(__dirname, '..', 'backend'),
    };
  }
  return {
    cmd: process.execPath, // app binary re-invoked as plain Node
    args: [path.join(process.resourcesPath, 'backend', 'dist', 'index.js')],
    cwd: path.join(process.resourcesPath, 'backend'),
  };
}

// EMFILE backstop: macOS shells/Dock-launched apps default to a soft fd
// ceiling of 256, and transient spikes (rapid OAuth sync retries against a
// hung upstream) can cross it even after the leak fixes. `ulimit -n` is a
// process-launch attribute — it must be raised in the SHELL that starts
// node, not inside the process. Wrapping the launch in `sh -c 'ulimit -n
// 4096 && exec "$@"'` (exec preserves the pid, so process-group kill and
// taskkill semantics are unaffected) gives the backend headroom to ride out
// any spike. Windows has no per-process fd ulimit — left untouched.
function backendCommand() {
  const entry = backendEntry();
  if (process.platform !== 'win32') {
    return {
      cmd: '/bin/sh',
      // `$@` must carry the REAL command (entry.cmd) first — for the packaged
      // app that's the Electron binary re-invoked as plain Node
      // (ELECTRON_RUN_AS_NODE=1), and exec'ing dist/index.js directly would
      // ENOEXEC. exec preserves the pid, so process-group kill semantics
      // (kill -pid / taskkill /T) still take the whole tree down.
      args: ['-c', 'ulimit -n 4096 2>/dev/null; exec "$@"', 'backend-launcher', entry.cmd, ...entry.args],
      cwd: entry.cwd,
    };
  }
  return entry;
}

function backendEnv() {
  return {
    ...process.env,
    PORT: String(backendPort),
    CF_DATA_DIR: DATA_DIR,
    CF_POLICY_DIR: USER_DATA,
    NODE_ENV: DEV ? 'development' : 'production',
    ELECTRON_RUN_AS_NODE: DEV ? '' : '1',
  };
}

async function waitForHealth(timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${backendPort}/api/health`, (r) => resolve(r));
        req.on('error', reject);
        req.setTimeout(1500, () => { req.destroy(new Error('timeout')); });
      });
      if (res.statusCode === 200) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

// Kill the backend and its whole process tree (MCP server children included).
// POSIX: kill the process group (-pid). Windows has no kill(-pid): taskkill
// /T (tree) + /F (force) is the equivalent; without it MCP children would
// be orphaned on every quit.
function killBackendTree(signal = 'SIGTERM') {
  if (!backendChild) return;
  const pid = backendChild.pid;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch { /* already gone */ }
    return;
  }
  try {
    process.kill(-pid, signal); // process group: backend + any MCP server children
  } catch {
    try { process.kill(pid, signal); } catch { /* already gone */ }
  }
}

let backendRetries = 0;
async function startBackend() {
  if (backendChild && backendChild.exitCode === null) return true;
  backendPort = DEV ? DEV_BACKEND_PORT : await pickFreePort();
  const entry = backendCommand();
  backendChild = spawn(entry.cmd, entry.args, {
    cwd: entry.cwd,
    env: backendEnv(),
    detached: true, // own process group so kill(-pid)/taskkill /T takes down the tree
    windowsHide: true, // no console flash on Windows
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  backendChild.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  backendChild.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  backendChild.on('exit', (code, sig) => {
    process.stdout.write(`[backend] exited code=${code} sig=${sig}\n`);
    if (setupPhase === 'backend-up') setupPhase = null;
  });
  let ok = await waitForHealth();
  if (!ok && backendRetries < 2) {
    backendRetries++;
    await new Promise(r=> setTimeout(r, 800*backendRetries));
    ok = await waitForHealth();
  }
  if (!ok) {
    killBackendTree('SIGKILL');
    throw new Error('backend did not reach /api/health in time');
  }
  return true;
}

function apiGet(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${backendPort}${p}`, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, body }));
    }).on('error', reject);
  });
}

function apiPost(p, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload ?? {});
    const req = http.request(
      { host: '127.0.0.1', port: backendPort, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (r) => {
        let data = '';
        r.on('data', (c) => (data += c));
        r.on('end', () => resolve({ status: r.statusCode, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('backend request timed out')));
    req.end(body);
  });
}

// ── OAuth authorization-code flow (main-process half) ─────────────────────
// Renderer contract (preload → window.cfOauth.start):
//   invoke('oauth:start', serverName) → { ok: true } | { ok: false, error }
// The invoke resolves only when the browser flow has finished (authorized,
// failed, cancelled, or timed out) — no push events needed. The actual
// token exchange runs in the BACKEND (/api/servers/:name/oauth/token): the
// client_secret and token_url live in the SQLite DB and never cross this
// IPC boundary. Secrets never reach the renderer: the renderer only ever
// sees the connector's name it passed in and the ok/error verdict.
const activeOauthFlows = new Map(); // serverName → AbortController

function cancelOauthFlows() {
  for (const ctrl of activeOauthFlows.values()) ctrl.abort();
  activeOauthFlows.clear();
}

async function handleOauthStart(serverName) {
  if (!backendPort) return { ok: false, error: 'backend not running' };
  if (activeOauthFlows.has(serverName)) {
    return { ok: false, error: 'An approval window is already open for this connector.' };
  }
  const ctrl = new AbortController();
  activeOauthFlows.set(serverName, ctrl);
  try {
    // One-click path: if the connector only has its URL, the backend
    // discovers the provider's endpoints and registers a client (RFC 7591)
    // before the browser opens — the user never types anything. Flow facts
    // come from the backend (never tokens/secrets). shell.openExternal
    // opens the provider's consent screen in the SYSTEM browser — not an
    // embedded webview (embedded OAuth webviews are rejected by providers
    // like Google as insecure, and the system browser is the correct
    // posture for a firewall product anyway).
    return await startOauthFlow({
      serverName,
      backendPort,
      ensureConfig: async (redirectUri) => {
        const tryGet = async () => {
          const res = await apiGet(`/api/servers/${encodeURIComponent(serverName)}/oauth-config`);
          if (res.status !== 200) {
            let msg = res.body;
            try { msg = JSON.parse(res.body).error ?? msg; } catch { /* keep raw */ }
            return { error: msg };
          }
          return { config: JSON.parse(res.body).config };
        };
        let got = await tryGet();
        if (got.error) return got;
        // Full config already? Done. Otherwise auto-configure (discover +
        // dynamic client registration) with this loopback's redirect URI.
        if (!got.config.authorization_url || !got.config.client_id) {
          const reg = await apiPost(`/api/servers/${encodeURIComponent(serverName)}/oauth/register`, { redirect_uri: redirectUri });
          if (reg.status !== 200) {
            let msg = reg.body;
            try { msg = JSON.parse(reg.body).error ?? msg; } catch { /* keep raw */ }
            return { error: msg };
          }
          got = await tryGet();
        }
        return got;
      },
      openExternal: (url) => shell.openExternal(url),
      signal: ctrl.signal,
    });
  } catch (err) {
    return { ok: false, error: err.message || 'OAuth flow failed' };
  } finally {
    activeOauthFlows.delete(serverName);
  }
}

// ── Google OAuth loopback sign-in (Path B) ────────────────────────────────
// Opens accounts.google.com in the SYSTEM browser (shell.openExternal),
// catches the auth code on a one-shot loopback server, exchanges for tokens
// at Google's token endpoint, and returns the id_token to the renderer so it
// can call signInWithCredential(auth, GoogleAuthProvider.credential(idToken)).
// No popup window, no Electron webview, no redirect_uri injected anywhere
// near Firebase's own signInWithPopup/signInWithRedirect flow.
//
// Requires: GOOGLE_CLIENT_ID env var set to a Desktop OAuth 2.0 client ID
// from Google Cloud Console → Credentials (type: Desktop app). Desktop
// clients use PKCE (no client_secret) and Google accepts any loopback port
// per RFC 8252 — you only need to add http://127.0.0.1 (no port) as an

async function handleGoogleAuth() {
  // GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are bound at the top of this
  // file — hardcoded Desktop app credentials with env-var override for dev.
  if (!GOOGLE_CLIENT_ID) {
    return { success: false, error: 'Google client ID not configured.' };
  }

  let loopback;
  try {
    loopback = await listenLoopback(300_000); // 5 min
  } catch (err) {
    return { success: false, error: `Could not start local callback server: ${err.message}` };
  }

  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;
  const { verifier, challenge } = pkcePair();
  const state = base64url(crypto.randomBytes(16));

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', GOOGLE_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'openid email profile');
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'select_account');

  let callbackData = null;
  const callbackPromise = new Promise((resolve) => {
    loopback.onCallback.set((v) => { callbackData = v; resolve(v); });
  });

  try {
    await shell.openExternal(authUrl.toString());
  } catch (err) {
    loopback.close();
    return { success: false, error: `Failed to open browser: ${err.message}` };
  }

  const result = await callbackPromise;

  if (result.error) {
    return { success: false, error: `Google returned an error: ${result.error}` };
  }
  if (!result.code) {
    return { success: false, error: 'No authorization code received from Google' };
  }
  if (result.state !== state) {
    return { success: false, error: 'State mismatch — possible CSRF, sign-in aborted' };
  }

  // Exchange the auth code for tokens at Google's token endpoint.
  // client_secret is required by Google even for Desktop clients (PKCE is the
  // real security mechanism; the secret is non-sensitive per Google's own docs).
  const tokenBody = new URLSearchParams({
    code: result.code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  }).toString();

  try {
    const tokens = await new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'oauth2.googleapis.com',
          path: '/token',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(tokenBody),
          },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid token response')); }
          });
        }
      );
      req.on('error', reject);
      req.setTimeout(15000, () => req.destroy(new Error('Token exchange timed out')));
      req.end(tokenBody);
    });

    if (tokens.error) {
      return { success: false, error: `Token exchange failed: ${tokens.error_description || tokens.error}` };
    }
    if (!tokens.id_token) {
      return { success: false, error: 'Token response missing id_token' };
    }
    return {
      success: true,
      oauthIdToken: tokens.id_token,
      oauthAccessToken: tokens.access_token || null,
    };
  } catch (err) {
    return { success: false, error: `Token exchange error: ${err.message}` };
  } finally {
    loopback.close(); // always clean up the listener
  }
}

// ── N6: first-run bootstrap steps, each reporting REAL completion ────────
async function runSetupSteps(sendProgress) {
  const report = async (step, message, detail) => {
    sendProgress({ step, message, detail, done: false });
    await new Promise((r) => setTimeout(r, 150)); // let the UI paint the running state
  };

  // (1) Runtime dependencies — bundled in packaged builds, verified in dev.
  let depsDetail;
  if (DEV) {
    const nm = path.join(__dirname, '..', 'backend', 'node_modules');
    if (fs.existsSync(nm)) {
      depsDetail = 'backend/node_modules present — nothing to install';
    } else {
      await report(1, 'Installing backend dependencies', 'npm install --omit=dev …');
      await new Promise((resolve, reject) => {
        const inst = spawn('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
          cwd: path.join(__dirname, '..', 'backend'),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        inst.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`npm install exited ${code}`))));
      });
      depsDetail = 'dependencies installed';
    }
  } else {
    const bundled = path.join(process.resourcesPath, 'backend', 'node_modules');
    depsDetail = fs.existsSync(bundled)
      ? 'bundled with the app — nothing to install (no network needed)'
      : 'ERROR: backend node_modules missing from app bundle';
  }
  sendProgress({ step: 1, message: 'Runtime dependencies', detail: depsDetail, done: true });
  await new Promise((r) => setTimeout(r, 200));

  // (2) Seed the default policy file into userData if absent.
  let policyDetail;
  if (!fs.existsSync(POLICY_TARGET)) {
    await report(2, 'Copying default policy', 'context-fence.yaml → userData');
    if (!fs.existsSync(POLICY_SOURCE)) throw new Error(`policy source missing: ${POLICY_SOURCE}`);
    fs.copyFileSync(POLICY_SOURCE, POLICY_TARGET);
    policyDetail = `created ${POLICY_TARGET}`;
  } else {
    policyDetail = 'already present — skipped';
  }
  sendProgress({ step: 2, message: 'Default policy', detail: policyDetail, done: true });
  await new Promise((r) => setTimeout(r, 200));

  // (3) Start the backend — its startup IS the DB schema bootstrap.
  await report(3, 'Starting backend', `spawn → /api/health on a free port`);
  setupPhase = 'backend-up';
  await startBackend();
  const dbOk = fs.existsSync(DB_PATH);
  if (!dbOk) throw new Error('backend started but DB file missing');
  sendProgress({
    step: 3,
    message: 'Database schema',
    detail: `initialized ${DB_PATH} (${fs.statSync(DB_PATH).size} bytes)`,
    done: true,
  });
  await new Promise((r) => setTimeout(r, 200));

  // (4) Run agent detection once so the Agents page is populated.
  await report(4, 'Scanning for agents', 'GET /api/detect');
  const det = await apiGet('/api/detect');
  let agents = [];
  try {
    agents = JSON.parse(det.body).agents || [];
  } catch { /* keep empty */ }
  const names = agents.map((a) => a.name).filter(Boolean);
  sendProgress({
    step: 4,
    message: 'Agent detection',
    detail: `${agents.length} agent(s) detected${names.length ? ': ' + names.join(', ') : ''}`,
    done: true,
  });

  return { ok: true };
}

// ── Windows ───────────────────────────────────────────────────────────────
function baseWebPreferences() {
  return {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    preload: path.join(__dirname, 'preload.js'),
  };
}

function openAppWindow(url) {
  appWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    title: APP_NAME,
    backgroundColor: '#0f0f14',
    icon: path.join(__dirname, 'build', 'icon', 'master-1024.png'),
    webPreferences: baseWebPreferences(),
  });
  appWindow.setMenuBarVisibility(false);
  // Window-open policy:
  //   - Firebase auth popup (signInWithPopup): allowed as a REAL child
  //     BrowserWindow. Firebase's popup contract requires the authDomain
  //     handler to run inside a script-opened window that can close itself
  //     and postMessage back to the opener — shell.openExternal breaks that
  //     (the handler then forwards our random loopback page URL to Google as
  //     its OAuth redirect_uri, which is not registered → "invalid request").
  //   - Everything else (release pages, docs): system browser, never a child.
  appWindow.webContents.setWindowOpenHandler(({ url }) => {
    let host = '';
    try { host = new URL(url).host; } catch { /* malformed URL → external */ }
    if (host === 'context-fence.firebaseapp.com') {
      return { action: 'allow' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  appWindow.loadURL(url);
  if (process.platform === 'darwin' && DEV) {
    // macOS caches the dock tile per session; re-asserting the icon after
    // window activation helps the first-session override stick.
    const { nativeImage } = require('electron');
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon', 'master-1024.png')));
  }
  appWindow.on('closed', () => { appWindow = null; cancelOauthFlows(); });
}

function openSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 720,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: `${APP_NAME} — First run setup`,
    backgroundColor: '#0f0f14',
    icon: path.join(__dirname, 'build', 'icon', 'master-1024.png'),
    webPreferences: baseWebPreferences(),
  });
  setupWindow.setMenuBarVisibility(false);
  setupWindow.loadFile(path.join(__dirname, 'setup.html'));
  setupWindow.on('closed', () => { setupWindow = null; });
}

async function frontendUrl() {
  if (DEV) return 'http://localhost:5173';
  return require('./static-server.js').start(backendPort);
}

// ── Lifecycle ─────────────────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (appWindow) {
      if (appWindow.isMinimized()) appWindow.restore();
      appWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && DEV) {
      const { nativeImage } = require('electron');
      const iconPath = path.join(__dirname, 'build', 'icon', 'master-1024.png');
      const img = nativeImage.createFromPath(iconPath);
      process.stdout.write(`[app] dock icon image: ${JSON.stringify(img.getSize())} empty=${img.isEmpty()}\n`);
      try {
        app.dock.setIcon(img);
        process.stdout.write('[app] dock icon set\n');
      } catch (err) {
        process.stdout.write(`[app] dock setIcon failed: ${err}\n`);
      }
    }

    ipcMain.handle('setup:run', async () => {
      try {
        const result = await runSetupSteps((p) => setupWindow?.webContents.send('setup:progress', p));
        setupPhase = null;
        return result;
      } catch (err) {
        setupPhase = null;
        return { ok: false, error: String(err.message || err) };
      }
    });

    ipcMain.handle('oauth:start', (_e, serverName) => handleOauthStart(String(serverName || '')));

    // Google sign-in (Path B) — loopback authorization-code + PKCE flow.
    // Opens Google's consent screen in the system browser, catches the auth
    // code on a one-shot 127.0.0.1:0 listener, exchanges for tokens at
    // Google's token endpoint, and returns the id_token so the renderer can
    // call signInWithCredential(auth, GoogleAuthProvider.credential(idToken)).
    // This bypasses signInWithPopup entirely — no Firebase popup, no Electron
    // webview, no random redirect_uri injected into Firebase's own flow.
    ipcMain.handle('google:auth:start', () => handleGoogleAuth());

    // Notify-only update check: Settings "Check for Updates" → GitHub API
    // latest release, semver-compared against the running build. No
    // download/install here — that stays manual (brew / installer).
    ipcMain.handle('app:check-update', () => checkForUpdates({ currentVersion: app.getVersion() }));

    const firstRun = !fs.existsSync(DB_PATH);
    process.stdout.write(`[app] ${DEV ? 'DEV' : 'packaged'} firstRun=${firstRun} userData=${USER_DATA}\n`);
    if (firstRun) {
      openSetupWindow();
    } else {
      try {
        await startBackend();
      } catch (err) {
        process.stderr.write(`[app] backend failed: ${err}\n`);
      }
      openAppWindow(await frontendUrl());
    }

    // After a successful setup run, hand off: close setup, open the app window.
    ipcMain.on('setup:done', async () => {
      if (setupWindow) setupWindow.destroy();
      await startBackend();
      openAppWindow(await frontendUrl());
    });
  });

  app.on('window-all-closed', () => {
    // macOS convention: stay alive with no windows (activate reopens). The
    // setup→dashboard handoff passes through a zero-window moment, so we
    // must not quit here; only Cmd+Q (before-quit) tears the app down.
    if (process.platform !== 'darwin' || quitting) app.quit();
  });

  let quitting = false;
  app.on('before-quit', () => {
    if (quitting) return;
    quitting = true;
    cancelOauthFlows(); // in-flight loopback listener must die with the app
    process.stdout.write(`[app] before-quit t=${Date.now()}\n`);
    if (setupPhase === 'backend-up') killBackendTree();
    if (backendChild) {
      killBackendTree();
      // give the tree a moment to exit, then force-kill
      setTimeout(() => {
        process.stdout.write(`[app] SIGKILL t=${Date.now()}\n`);
        killBackendTree('SIGKILL');
      }, 2500);
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !quitting) {
      openAppWindow(frontendUrl());
    }
  });
}
