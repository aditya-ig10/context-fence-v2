import { stdin, stdout } from 'node:process';

// Minimal MCP stdio echo server: reads newline-delimited JSON-RPC messages
// (the transport real MCP servers use) and writes each message back verbatim.
// Also handles the initialize handshake and tools/list the way a real server
// would, so the proxy's spawn-time handshake works against it.
let buf = Buffer.alloc(0);
stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  for (;;) {
    const nl = buf.indexOf('\n');
    if (nl === -1) break;
    const line = buf.subarray(0, nl).toString().trim();
    buf = buf.subarray(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === undefined || msg.id === null) continue;
    let reply;
    if (msg.method === 'initialize') {
      reply = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: msg.params?.protocolVersion ?? '2025-03-26',
          capabilities: { tools: { listChanged: true } },
          serverInfo: { name: 'echo-server', version: '0.0.1' },
        },
      };
    } else if (msg.method === 'tools/list') {
      reply = { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'say_hello' }] } };
    } else if (msg.method === 'notifications/initialized') {
      continue;
    } else {
      reply = msg; // echo
    }
    stdout.write(JSON.stringify(reply) + '\n');
  }
});
