import { useEffect, useRef, useState } from 'react';
import { invalidateCache } from './useCachedFetch';
import { pushToast } from '../components/Toasts';

// useRealtimeSync — single WebSocket connection from the app root.
//
// The backend broadcasts { type, payload, ts } on /ws whenever state mutates
// (policy writes, connector status changes, audit entries, agent changes).
// This hook turns those events into immediate invalidateCache() calls, so
// every mounted useCachedFetch re-reads the affected resource instantly —
// WS is the "go refetch this" signal, REST stays the data transport.
//
// Connection lifecycle: auto-reconnect with capped exponential backoff;
// no user-visible state, no retry storms (the local backend restarts during
// dev all the time — the client must just come back silently).

export type RealtimeEventType = 'policy.updated' | 'connector.status' | 'audit.new' | 'audit.cleared' | 'agent.updated' | 'discovery.install-gap';

interface RealtimeEvent {
  type: RealtimeEventType;
  payload: Record<string, unknown>;
  ts: number;
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// Module-level connection state: pages that need hard realtime guarantees
// (Audit Log) can read it cheaply and fall back to light polling when the
// push channel is down (e.g. packaged build served without a WS proxy).
let realtimeConnected = false;
export function isRealtimeConnected(): boolean {
  return realtimeConnected;
}

function wsUrl(): string {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/ws`;
}

function handleEvent(ev: RealtimeEvent): void {
  switch (ev.type) {
    case 'policy.updated':
      invalidateCache((k) => k === 'policies' || k === 'policies:status' || k === 'stats' || k.startsWith('server:'));
      break;
    case 'connector.status':
      invalidateCache((k) => k === 'servers' || k === 'mcp-configs' || k === 'stats' || k.startsWith('server:') || k.startsWith('detect'));
      break;
    case 'audit.new':
    case 'audit.cleared':
      // Every proxied call lands here — the dashboard, audit page, connector
      // cards and detail drawers all re-read from their own keys.
      invalidateCache((k) => k === 'stats' || k === 'servers' || k === 'dashboard' || k.startsWith('logs:') || k.startsWith('server:'));
      break;
    case 'agent.updated':
      invalidateCache((k) => k === 'agents' || k === 'settings' || k === 'mcp-configs' || k.startsWith('detect'));
      break;
    case 'discovery.install-gap':
      // A config changed on disk but declared no new MCP (e.g. `shadcn mcp
      // init` reported success and wrote nothing Context Fence can see).
      pushToast({
        kind: 'warn',
        title: 'MCP install not detected',
        message: typeof ev.payload.message === 'string' ? ev.payload.message : 'No new MCP entry appeared in the scanned config files.',
      });
      invalidateCache((k) => k === 'servers' || k === 'mcp-configs' || k.startsWith('server:') || k.startsWith('detect'));
      break;
  }
}

export function useRealtimeSync(): { connected: boolean } {
  const [connected, setConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const backoffRef = useRef(RECONNECT_BASE_MS);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let closedByUnmount = false;

    const connect = () => {
      if (closedByUnmount) return;
      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        scheduleReconnect();
        return;
      }
      socketRef.current = socket;

      socket.onopen = () => {
        backoffRef.current = RECONNECT_BASE_MS;
        realtimeConnected = true;
        setConnected(true);
      };

      socket.onmessage = (msg) => {
        try {
          const ev = JSON.parse(String(msg.data)) as RealtimeEvent;
          if (ev && typeof ev.type === 'string') handleEvent(ev);
        } catch {
          /* malformed frame — ignore */
        }
      };

      socket.onclose = () => {
        realtimeConnected = false;
        setConnected(false);
        if (!closedByUnmount) scheduleReconnect();
      };

      socket.onerror = () => {
        socket.close();
      };
    };

    const scheduleReconnect = () => {
      if (closedByUnmount || retryTimerRef.current) return;
      retryTimerRef.current = setTimeout(() => {
        retryTimerRef.current = null;
        connect();
      }, backoffRef.current);
      backoffRef.current = Math.min(backoffRef.current * 2, RECONNECT_MAX_MS);
    };

    connect();

    return () => {
      closedByUnmount = true;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      socketRef.current?.close();
    };
  }, []);

  return { connected };
}
