// Context Fence — OAuth authorization-code flow orchestration (main process).
//
// Branch A (loopback redirect): the flow runs a temporary HTTP server on
// 127.0.0.1:0 inside the Electron main process ONLY for the duration of the
// flow, opens the provider's consent screen in the SYSTEM browser, catches
// the redirect on the loopback server, and hands the code to the backend,
// which performs the token exchange (client_secret never leaves the DB).
//
// This module is deliberately Electron-free (pure Node) so the exact flow —
// PKCE, state, one-shot loopback, exchange — is testable headlessly against
// a real OAuth provider + real backend (NODE 6 e2e).
//
// IPC contract (main ↔ renderer, implemented in main.js):
//   renderer → main:  ipcRenderer.invoke('oauth:start', serverName)
//   main → renderer:  resolves with { ok: true } | { ok: false, error }
//   (result arrives when the browser flow has completed or failed; no
//    push events needed — the invoke call itself is the completion signal)

const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

function base64url(buf) {
  return buf.toString('base64url');
}

// RFC 7636 PKCE pair. S256 challenge; the verifier is held in the main
// process for the lifetime of the flow and sent to the backend at exchange
// time (it never crosses the renderer).
function pkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// One-shot loopback listener on 127.0.0.1:0 (never 0.0.0.0 — nothing about
// the auth flow needs to be reachable beyond localhost). It accepts a
// single GET /callback, responds with a close-page HTML, and tears the
// server down immediately — the same leak discipline as the EMFILE work:
// a listener left bound is an fd + a port held hostage.
function listenLoopback(timeoutMs) {
  return new Promise((resolve, reject) => {
    let handle = null;
    let done = false;
    let timer = null;
    const settle = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      resolve(v);
    };
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('unexpected path');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><html><body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;background:#0f0f14;color:#e8e8ef">' +
          '<div style="text-align:center;padding:24px">' +
          '<div style="font-size:44px;margin-bottom:12px">✓</div>' +
          '<h1 style="font-size:18px;margin:0 0 6px;font-weight:650">Signed in</h1>' +
          '<p style="font-size:13px;color:#9a9aa8;margin:0">You can close this tab and return to Context Fence.</p>' +
          '</div>' +
          '<script>setTimeout(function(){try{window.close()}catch(e){}},300)</script>' +
          '</body></html>'
      );
      server.close(); // one callback, then the listener is gone
      const q = u.searchParams;
      if (handle) handle({ code: q.get('code'), state: q.get('state'), error: q.get('error') });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      timer = setTimeout(() => settle({ error: 'timed out waiting for the browser to return' }), timeoutMs);
      resolve({
        port,
        close: () => settle({ error: 'flow cancelled' }),
        onCallback: { set: (fn) => { handle = fn; } },
      });
    });
  });
}

// Build the provider consent URL (RFC 6749 §4.1.1 + RFC 7636 + RFC 8707).
function buildAuthUrl(config, redirectUri, challenge, state) {
  const u = new URL(config.authorization_url);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', config.client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (config.scope) u.searchParams.set('scope', config.scope);
  // RFC 8707 resource indicator — audience-bind the token to this MCP server.
  if (config.resource && /^https:\/\//i.test(config.resource)) {
    u.searchParams.set('resource', config.resource);
  }
  return u.toString();
}

/**
 * Run one full authorization-code flow.
 *
 * @param {object} opts
 * @param {string} opts.serverName     connector name
 * @param {object} [opts.config]       from GET /api/servers/:name/oauth-config
 * @param {number} opts.backendPort    backend HTTP port (code exchange target)
 * @param {Function} [opts.ensureConfig] async (redirectUri) => { config } |
 *   { error } — called with the loopback redirect URI BEFORE the browser
 *   opens, so the caller can auto-configure the connector (discovery +
 *   dynamic client registration) when only its URL is known. Returned config
 *   replaces opts.config.
 * @param {(url: string) => Promise<void>|void} opts.openExternal  opens the
 *   system browser — injected so tests can drive the redirect chain directly
 * @param {AbortSignal} [opts.signal]  abort → closes the loopback server
 * @param {number} [opts.timeoutMs]    max wait for the callback (default 10 min)
 * @returns {Promise<{ok: true} | {ok: false; error: string}>}
 */
async function startOauthFlow({ serverName, config, backendPort, ensureConfig, openExternal, signal, timeoutMs = 600_000 }) {
  const { verifier, challenge } = pkcePair();
  const state = base64url(crypto.randomBytes(16));

  let loopback;
  try {
    loopback = await listenLoopback(timeoutMs);
  } catch (err) {
    return { ok: false, error: `could not start local callback server: ${err.message}` };
  }
  const redirectUri = `http://127.0.0.1:${loopback.port}/callback`;

  const callback = new Promise((resolve, reject) => {
    loopback.onCallback.set((v) => {
      if (v.error) return resolve({ ok: false, error: `Provider returned an error: ${v.error}` });
      if (!v.code) return resolve({ ok: false, error: 'Callback carried no authorization code' });
      if (v.state !== state) {
        return resolve({ ok: false, error: 'state mismatch — callback rejected (possible CSRF)' });
      }
      resolve({ ok: true, code: v.code });
    });
  });

  const abort = () => loopback.close();
  signal?.addEventListener?.('abort', abort, { once: true });

  try {
    // One-click plumbing: if only the connector URL is known, ensureConfig
    // discovers endpoints + registers a client (RFC 7591) before we build
    // the consent URL.
    let flowConfig = config;
    if (ensureConfig) {
      const ensured = await ensureConfig(redirectUri);
      if (!ensured.config) {
        return { ok: false, error: ensured.error || 'This connector is not ready for OAuth sign-in.' };
      }
      flowConfig = ensured.config;
    }
    if (!flowConfig?.authorization_url) {
      return { ok: false, error: 'This connector has no authorization URL configured.' };
    }

    await openExternal(buildAuthUrl(flowConfig, redirectUri, challenge, state));
    const result = await callback;
    if (!result.ok) return result;

    // Exchange via the backend — it holds client_secret + token_url and
    // persists the tokens into mcp_servers.__oauth.
    const body = JSON.stringify({
      code: result.code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    });
    const exchange = await new Promise((resolve) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: backendPort,
          path: `/api/servers/${encodeURIComponent(serverName)}/oauth/token`,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        },
        (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on('error', (err) => resolve({ status: 0, body: String(err.message) }));
      req.setTimeout(15000, () => req.destroy(new Error('exchange timed out')));
      req.end(body);
    });

    if (exchange.status !== 200) {
      let detail = exchange.body;
      try { detail = JSON.parse(exchange.body).error ?? detail; } catch { /* keep raw */ }
      return { ok: false, error: `Token exchange failed: ${detail}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'OAuth flow failed' };
  } finally {
    signal?.removeEventListener?.('abort', abort);
    loopback.close(); // idempotent — never leave the listener behind
  }
}

module.exports = { startOauthFlow, pkcePair, buildAuthUrl, base64url, listenLoopback };
