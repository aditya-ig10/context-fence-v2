import { useState } from 'react';
import { invalidateCache } from './useCachedFetch';
import type { Connector } from '../types';

// Shared OAuth connect trigger (ConnectorCard + ConnectorDetail). Talks to
// the Electron main process via the preload bridge (window.cfOauth); in a
// plain browser (dev without the app shell) it degrades to an explanatory
// error instead of crashing.
//
// `connect()` resolves true on a completed authorization (token stored) —
// the caller refreshes its data. `connecting` drives the "waiting for
// browser authorization…" state; `error` carries a TRANSLATED failure in
// plain language — never raw endpoints, port numbers or JSON (a firewall
// product's own UI should not look like an error dump).

// Failure → plain-language mapping. Match on distinctive fragments; fall
// back to a generic "try again" line for anything unknown.
export function translateOauthError(raw: string): string {
  if (/already in progress|already open/i.test(raw)) return 'An approval window is already open for this connector.';
  if (/state mismatch|could not start local callback/i.test(raw)) return "Something went wrong with the connection — please try again.";
  if (/timed out|took too long/i.test(raw)) return 'The approval window took too long — please try again.';
  if (/cancelled|flow cancelled/i.test(raw)) return 'You closed the approval window — nothing was changed.';
  if (/does not support automatic registration|no authorization URL configured/i.test(raw)) {
    return 'This provider does not support one-click sign-in — add its OAuth settings in Connector settings.';
  }
  if (/provider returned an error|didn't approve|access_denied|denied/i.test(raw)) {
    return "The provider didn't approve this connection — you can try again.";
  }
  if (/not ready for oauth|oauth is not configured/i.test(raw)) {
    return 'This connector needs its OAuth settings before it can connect.';
  }
  return "Couldn't connect — try again.";
}

export interface OauthConnectState {
  connecting: boolean;
  error: string | null;
  connect: () => Promise<boolean>;
  clearError: () => void;
}

export function useOauthConnect(serverName: string): OauthConnectState {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(): Promise<boolean> {
    if (connecting) return false;
    setConnecting(true);
    setError(null);
    try {
      const bridge = window.cfOauth;
      if (!bridge) {
        setError('OAuth sign-in is only available inside the Context Fence app.');
        return false;
      }
      const result = await bridge.start(serverName);
      if (!result?.ok) {
        setError(translateOauthError(result?.error ?? ''));
        return false;
      }
      invalidateCache((k) => k.startsWith('server:') || k === 'servers');
      return true;
    } catch {
      setError("Couldn't connect — try again.");
      return false;
    } finally {
      setConnecting(false);
    }
  }

  return { connecting, error, connect, clearError: () => setError(null) };
}

// What the Connect affordance should say for an OAuth2 connector:
//   'connect'      — never authorized (or not yet configured: the click
//                    auto-discovers + registers, one-tap UX)
//   'reauthorize'  — authorization was lost (refresh revoked/expired)
//   null           — authorized (no action needed)
export function oauthAction(connector: { authType: string; oauth?: Connector['oauth'] }): 'connect' | 'reauthorize' | null {
  const o = connector.oauth;
  if (connector.authType !== 'oauth2') return null;
  if (!o) return 'connect';
  if (!o.hasToken) return o.reauth ? 'reauthorize' : 'connect';
  if (o.expired && !o.hasRefreshToken) return 'reauthorize';
  return null;
}
