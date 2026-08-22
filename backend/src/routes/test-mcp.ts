import { Router } from 'express';
import { sendRequest, getSpawnedServers, PROXY_HTTP_PORT } from '../mcp/proxy.js';
import { maskSecrets } from '../policy/engine.js';
import db from '../db/index.js';

const router = Router();

router.post('/', async (req, res) => {
  try {
    const { endpoint, method, params } = req.body as {
      endpoint?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
    if (!method) return res.status(400).json({ error: 'method required (e.g. tools/call)' });

    // HTTP connectors: relay through the local HTTP MCP ingress
    // (127.0.0.1:3002/<server>) so the FULL policy path runs — evaluation,
    // auth injection (static headers or proxy-minted OAuth2 token), audit —
    // exactly like a real agent's traffic. stdio connectors use the existing
    // sendRequest path through the TCP ingress.
    const row = db
      .prepare('SELECT type, url FROM mcp_servers WHERE name = ?')
      .get(endpoint) as { type: string; url: string | null } | undefined;
    if (row && row.type === 'http' && row.url) {
      const t0 = Date.now();
      let upstream: Response;
      try {
        upstream = await fetch(`http://127.0.0.1:${PROXY_HTTP_PORT}/${encodeURIComponent(endpoint)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params ?? {} }),
        });
      } catch (err) {
        return res.status(502).json({ ok: false, result: { decision: 'log', tool: method, params: params ?? {}, response: null, error: (err as Error).message, durationMs: Date.now() - t0, server: endpoint } });
      }
      const text = await upstream.text();
      let parsed: { result?: unknown; error?: { message: string } } | null = null;
      try { parsed = JSON.parse(text) as { result?: unknown; error?: { message: string } }; } catch { /* non-JSON */ }
      const body = parsed?.result ?? parsed?.error?.message ?? text.slice(0, 2000);
      return res.json({
        ok: upstream.ok && !parsed?.error,
        result: {
          decision: 'allow',
          tool: method,
          params: params ?? {},
          response: maskSecrets(body),
          error: parsed?.error?.message ?? null,
          durationMs: Date.now() - t0,
          server: endpoint,
        },
      });
    }

    const result = await sendRequest(endpoint, method, params ?? {});

    res.json({
      ok: result.ok,
      result: {
        decision: result.decision,
        tool: method,
        params: params ?? {},
        response: result.result !== null && result.result !== undefined ? maskSecrets(result.result) : null,
        error: result.error ?? null,
        durationMs: result.durationMs,
        server: endpoint,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'MCP test failed' });
  }
});

router.get('/servers', (_req, res) => {
  res.json({ servers: getSpawnedServers() });
});

export default router;
