#!/usr/bin/env node
// Minimal stdio MCP server used by the proxy engine tests (N4/N5).
// Speaks Content-Length framed JSON-RPC over stdin/stdout, like a real
// MCP server, so the proxy can spawn it as a child process.
let buf = Buffer.alloc(0);

function handle(msg) {
  if (!msg || typeof msg.method !== 'string') return;
  const { id, method, params } = msg;
  if (method === 'notifications/initialized') return; // no response to notifications
  const result =
    method === 'initialize'
      ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'mock-mcp', version: '1.0.0' } }
      : method === 'ping'
        ? {}
        : method === 'tools/list'
          ? { tools: [] }
          : method === 'tools/call'
            ? { content: [{ type: 'text', text: `mock result for ${params?.name ?? 'unknown'}` }] }
            : { ok: true };
  if (id !== undefined) send({ jsonrpc: '2.0', id, result });
}

process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (buf.includes(Buffer.from('\r\n\r\n'))) {
    // Content-Length framed (legacy harness)
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) break;
      const header = buf.subarray(0, sep).toString('utf-8');
      const m = /content-length\s*:\s*(\d+)/i.exec(header);
      if (!m) break;
      const len = parseInt(m[1], 10);
      if (buf.length < sep + 4 + len) break;
      const body = buf.subarray(sep + 4, sep + 4 + len).toString('utf-8');
      buf = buf.subarray(sep + 4 + len);
      let msg;
      try {
        msg = JSON.parse(body);
      } catch {
        continue;
      }
      handle(msg);
    }
    return;
  }
  // Newline-delimited JSON (official MCP stdio transport)
  const text = buf.toString('utf-8');
  const lines = text.split('\n');
  buf = Buffer.from(lines.pop() ?? '');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      handle(JSON.parse(trimmed));
    } catch {
      /* non-JSON banner line: skip */
    }
  }
});

function send(msg) {
  const body = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`);
}
