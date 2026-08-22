// Context Fence — packaged-mode static server.
//
// Serves the production frontend build (SPA: unknown non-/api paths fall
// back to index.html so react-router routes like /agents work) and proxies
// /api/* to the Electron-managed backend. Only used in packaged builds; in
// dev the app loads the Vite dev server directly (which has its own proxy).

const http = require('http');
const path = require('path');
const fs = require('fs');
const net = require('net');

const DIST = path.join(process.resourcesPath, 'frontend-dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

function createServer(backendPort) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;

    if (p.startsWith('/api')) {
      const proxy = http.request(
        { host: '127.0.0.1', port: backendPort, path: u.pathname + u.search, method: req.method, headers: req.headers },
        (pr) => {
          res.writeHead(pr.statusCode, pr.headers);
          pr.pipe(res);
        }
      );
      proxy.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('backend unreachable');
      });
      req.pipe(proxy);
      return;
    }

    let filePath = path.join(DIST, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(DIST)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    fs.stat(filePath, (err, st) => {
      if (!err && st.isFile()) {
        serveFile(res, filePath);
      } else if (!err && st.isDirectory()) {
        serveFile(res, path.join(filePath, 'index.html'));
      } else {
        // SPA fallback: react-router client routes (e.g. /agents)
        const accept = req.headers.accept || '';
        if (accept.includes('text/html')) {
          serveFile(res, path.join(DIST, 'index.html'));
        } else {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        }
      }
    });
  });

  // Realtime WebSocket passthrough: the backend's /ws hub (realtime/hub.js)
  // broadcasts audit/state pushes, and the packaged frontend connects to THIS
  // server's origin — so the handshake must be forwarded to the backend port.
  // Plain http.request cannot carry a WS upgrade; relay the raw socket.
  server.on('upgrade', (req, socket, head) => {
    if (req.url.split('?')[0] !== '/ws') {
      socket.destroy();
      return;
    }
    const backend = net.connect(backendPort, '127.0.0.1');
    backend.once('connect', () => {
      const headers = Object.entries(req.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('\r\n');
      backend.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers}\r\n\r\n`);
      if (head && head.length) backend.write(head);
    });
    backend.on('error', () => socket.destroy());
    socket.on('error', () => backend.destroy());
    socket.pipe(backend);
    backend.pipe(socket);
  });

  return server;
}

// Pinned static-server port: the packaged frontend's origin (and therefore
// the Firebase browserLocalPersistence auth session, which is keyed per
// origin) must stay stable across app restarts. A random port made every
// relaunch look like a new site — the signed-in account was dropped after
// every quit. Falls back to a random free port only if 3100 is taken.
const PREFERRED_PORT = 3100;

let instance = null;
function start(backendPort) {
  if (instance) return Promise.resolve(instance.url);
  const srv = createServer(backendPort);
  return new Promise((resolve, reject) => {
    const bind = (port) => {
      srv.once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          bind(0);
          return;
        }
        reject(err);
      });
      srv.listen(port, '127.0.0.1', () => {
        instance = { server: srv, url: `http://127.0.0.1:${srv.address().port}` };
        resolve(instance.url);
      });
    };
    bind(PREFERRED_PORT);
  });
}

module.exports = { start };
