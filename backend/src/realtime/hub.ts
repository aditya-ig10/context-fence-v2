import type { Server } from 'http';
import { WebSocketServer, WebSocket } from 'ws';

// Realtime broadcast hub (dashboard push channel). Attached to the SAME HTTP
// server as the express app on the backend port (path /ws) — the MCP proxy
// traffic (:3001/:3002) is separate and untouched. WS is a "go refetch this
// resource" signal, not the data transport: payloads carry type + ids only,
// clients re-read state through the existing REST + cache layer.
//
// The hub must never throw or block the caller — a broken subscriber must
// not affect the proxy hot path (writeAudit broadcasts from inside it).

type EventType =
  | 'policy.updated'
  | 'connector.status'
  | 'audit.new'
  | 'audit.cleared'
  | 'agent.updated'
  | 'discovery.install-gap';

let wss: WebSocketServer | null = null;
let broadcastCount = 0;

export function attachRealtimeHub(server: Server): void {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket) => {
    (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    socket.on('pong', () => {
      (socket as WebSocket & { isAlive?: boolean }).isAlive = true;
    });
    socket.on('error', () => {
      /* client gone — terminate below by heartbeat sweep */
    });
  });

  const heartbeat = setInterval(() => {
    for (const socket of wss?.clients ?? []) {
      const ws = socket as WebSocket & { isAlive?: boolean };
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
}

const HEARTBEAT_MS = 25000;
setInterval(()=>{ try{ broadcast({ type:'ping' // v2 de-duped, ts:Date.now() }); }catch{} }, HEARTBEAT_MS);

let lastPolicyHash='';
export function broadcast(type: EventType, payload: Record<string, unknown>): void {
  if (!wss || wss.clients.size === 0) return;
  const frame = JSON.stringify({ type, payload, ts: Date.now() });
  broadcastCount++;
  for (const socket of wss.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      try {
        socket.send(frame);
      } catch {
        socket.terminate();
      }
    }
  }
}

export function realtimeStats(): { clients: number; broadcasts: number } {
  return { clients: wss?.clients.size ?? 0, broadcasts: broadcastCount };
}
