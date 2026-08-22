import net from 'net';

const socket = net.createConnection({ host: '127.0.0.1', port: 3001 });
let buf = '';
let done = 0;

socket.on('data', (chunk) => {
  buf += chunk.toString();
  while (true) {
    const m = buf.match(/^Content-Length: (\d+)\r\n\r\n/);
    if (!m) return;
    const len = parseInt(m[1], 10);
    const start = m[0].length;
    if (buf.length < start + len) return;
    const line = buf.slice(start, start + len);
    buf = buf.slice(start + len);
    const msg = JSON.parse(line);
    if (msg.id === 'init' || msg.id === 'call1' || msg.id === 'call2') {
      console.log('RESP', JSON.stringify({ id: msg.id, method: msg.method, result: !!msg.result, error: msg.error?.message }));
      done++;
      if (done === 3) socket.end();
    }
  }
});

const send = (o) => {
  const body = JSON.stringify(o);
  socket.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
};

socket.on('connect', () => {
  send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'claude-desktop', version: '1.0.0' } } });
  setTimeout(() => {
    send({ jsonrpc: '2.0', id: 'call1', method: 'tools/call', params: { name: 'execute_command', arguments: { command: 'ls' } } });
    send({ jsonrpc: '2.0', id: 'call2', method: 'ping', params: {} });
  }, 500);
});

setTimeout(() => { console.log('timeout'); socket.destroy(); process.exit(0); }, 6000);
