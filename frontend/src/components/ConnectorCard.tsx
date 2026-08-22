import { motion, type Variants } from 'framer-motion';
import { useState } from 'react';
import { RefreshCw, Link2, ShieldAlert, Unplug } from 'lucide-react';
import type { Connector } from '../types';
import { useOauthConnect, oauthAction } from '../hooks/useOauthConnect';
import AnimatedTooltip from './AnimatedTooltip';
import { LOGOS, FALLBACK_ICON } from '../lib/agentLogos';
import { getConnectorIcon } from '../lib/connectorIcons';

// Editorial connector card — same art direction as the Agents page cards:
// 26px radius card, icon tile + name + status state pill, light-weight figure row
// over a hairline, quiet footer with a "Manage" arrow. Pop-in is driven by
// the parent grid's stagger variants.

interface ConnectorCardProps {
  connector: Connector;
  ordinal: number;
  syncing: boolean;
  variants?: Variants;
  onExpand: () => void;
  onSync: () => void;
}

const STATUS_META: Record<Connector['status'], { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'qc-state-on' },
  'needs-auth': { label: 'Needs auth', className: 'qc-state-off' },
  error: { label: 'Failed', className: 'qc-state-err' },
};

export default function ConnectorCard({ connector: s, ordinal, syncing, variants, onExpand, onSync }: ConnectorCardProps) {
  const meta = STATUS_META[s.status] ?? STATUS_META.error;
  const origin = s.type === 'http' ? s.url ?? '' : s.command ?? '';
  const originShort = origin.length > 52 ? `${origin.slice(0, 51)}…` : origin;
  const boundAgents = s.boundAgents ?? [];
  const authType = s.authType ?? 'none';
  const action = oauthAction(s);
  const { connecting, error, connect } = useOauthConnect(s.name);
  const authorized = s.oauth?.hasToken && !s.oauth.expired;
  const ConnectorIcon = getConnectorIcon(s.name);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ status: 'connected' | 'timeout' | 'error'; message?: string } | null>(null);

  // B4: live connection test — the backend spawns the stored command, waits
  // for a real JSON-RPC initialize response + ping, and reports the outcome.
  async function handleTest(e: React.MouseEvent) {
    e.stopPropagation();
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(s.name)}/test`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { status?: string; message?: string };
      setTestResult({ status: (body.status as 'connected' | 'timeout' | 'error') ?? 'error', message: body.message });
    } catch (err) {
      setTestResult({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function handleConnect() {
    const ok = await connect();
    if (ok) onSync(); // token stored — sync now to validate it + pull tools
  }

  return (
    <motion.div
      className="qc-card"
      variants={variants}
      transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      onClick={onExpand}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onExpand(); } }}
    >
      <div className="qc-top">
        <div className="qc-icon-tile" title={s.name}>
          <ConnectorIcon size={18} strokeWidth={1.8} />
        </div>
        <div className="qc-id">
          <p className="qc-name" title={s.name}>{s.name}</p>
          <p className="qc-origin" title={origin}>{originShort || (s.type === 'http' ? 'http endpoint' : 'stdio command')}</p>
        </div>
        <span className={`qc-state ${meta.className}`} title={meta.label}>
          <span className="qc-state-dot" />
          {meta.label}
        </span>
      </div>

      <div className="qc-figure-row">
        <div className="qc-figure">
          <p className="qc-figure-value">{s.toolCount ?? 0}</p>
          <p className="qc-figure-label">Tools</p>
        </div>
        <div className="qc-figure">
          <p className="qc-figure-value">{(s.callsToday ?? 0).toLocaleString()}</p>
          <p className="qc-figure-label">Calls today</p>
        </div>
        <div className="qc-figure">
          <p className="qc-figure-value qc-figure-agents">
            {boundAgents.length === 0 ? (
              <span className="qc-unbound"><Unplug size={12} /> none</span>
            ) : (
              <span className="qc-agent-row">
                <AnimatedTooltip
                  items={boundAgents.map((b, bi) => ({
                    id: bi,
                    name: `${b.agentType}${b.enabled ? '' : ' (suspended)'}`,
                    image: LOGOS[b.agentType.toLowerCase()] ?? FALLBACK_ICON,
                    suspended: !b.enabled,
                  }))}
                />
              </span>
            )}
          </p>
          <p className="qc-figure-label">Bindings</p>
        </div>
      </div>

      {authType === 'oauth2' && !authorized && (
        <button
          className="qc-oauth"
          onClick={(e) => { e.stopPropagation(); void handleConnect(); }}
          disabled={connecting}
          title={action === 'reauthorize' ? 'Stored token expired — run the browser flow again' : 'Open the provider consent screen to authorize this connector'}
        >
          {connecting ? <RefreshCw size={11} className="qc-spin" /> : action === 'reauthorize' ? <ShieldAlert size={11} /> : <Link2 size={11} />}
          {connecting ? 'Connecting…' : action === 'reauthorize' ? 'Reauthorize' : 'Authorize'}
        </button>
      )}
      {authType === 'oauth2' && error && (
        <p className="qc-oauth-error" title={error}>{error.slice(0, 52)}{error.length > 52 ? '…' : ''}</p>
      )}

      {testResult && (
        <p className={`qc-test-result qc-test-${testResult.status}`} title={testResult.message}>
          {testResult.status === 'connected' ? 'Handshake OK' : testResult.status === 'timeout' ? 'Timed out' : 'Failed'}{testResult.message ? ` — ${testResult.message}` : ''}
        </p>
      )}

      <div className="qc-foot">
        <button className="qc-act" onClick={handleTest} disabled={testing}
          title="Spawn this server's command and verify the JSON-RPC initialize handshake">
          {testing ? <RefreshCw size={11} className="qc-spin" /> : '◦'} {testing ? 'Testing…' : 'Test'}
        </button>
        <button className="qc-act" onClick={(e) => { e.stopPropagation(); onSync(); }} disabled={syncing} title="Sync tools">
          <RefreshCw size={11} className={syncing ? 'qc-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync'}
        </button>
        <span className="qc-manage" onClick={(e) => { e.stopPropagation(); onExpand(); }}>
          Manage
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
        </span>
      </div>

      <style>{`
.qc-card {
  position: relative;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 24px 26px 0;
  cursor: pointer; min-width: 0; overflow: hidden;
  display: flex; flex-direction: column;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  transition: all 300ms cubic-bezier(0.22,1,0.36,1);
}
.qc-card:hover {
  transform: translateY(-3px);
  border-color: rgba(255,49,68,0.22);
  box-shadow: 0 16px 44px rgba(16,24,32,0.09);
}

.qc-top { display: flex; align-items: center; gap: 14px; }
.qc-icon-tile {
  width: 40px; height: 40px; border-radius: 12px;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-primary); display: flex; align-items: center; justify-content: center;
  flex-shrink: 0; transition: all 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.qc-card:hover .qc-icon-tile {
  background: var(--bg-surface-hover, var(--card-bg));
  border-color: var(--border-strong);
  transform: scale(1.04);
}
.qc-id { flex: 1; min-width: 0; }
.qc-name {
  margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.01em;
  color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.qc-origin {
  margin: 4px 0 0; font-size: 11px; font-weight: 500;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-muted); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}

.qc-state {
  display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
  font-size: 11px; font-weight: 650;
  padding: 6px 13px; border-radius: 999px; border: 1px solid transparent;
}
.qc-state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.qc-state-on  { background: rgba(47,230,176,0.09); color: #128a6d; border-color: rgba(18,138,109,0.25); }
.qc-state-off { background: rgba(255,176,32,0.09); color: #b7791f; border-color: rgba(183,121,31,0.28); }
.qc-state-err { background: rgba(255,49,68,0.08); color: #d92c3c; border-color: rgba(217,44,60,0.25); }

.qc-figure-row {
  display: grid; grid-template-columns: 1fr 1fr 1.3fr; gap: 12px;
  margin-top: 18px; padding-top: 16px;
  border-top: 1px solid var(--border-default);
}
.qc-figure-value {
  margin: 0; font-size: 22px; font-weight: 550; letter-spacing: -0.02em;
  line-height: 1.05; color: var(--text-primary);
  display: flex; align-items: center; gap: 6px; min-height: 26px;
  font-variant-numeric: tabular-nums;
}
.qc-figure-label { margin: 3px 0 0; font-size: 11px; font-weight: 550; color: var(--text-muted); }
.qc-figure-agents { flex-wrap: wrap; }
.qc-unbound { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; font-weight: 500; color: var(--text-muted); }
.qc-agent-row { display: inline-flex; gap: 4px; }
/* AnimatedTooltip avatars + spring tooltip (see AnimatedTooltip.tsx) */
.at-row { display: inline-flex; align-items: center; }
.at-item { position: relative; margin-right: -5px; }
.at-item:last-child { margin-right: 0; }
.at-avatar {
  width: 20px; height: 20px; border-radius: 50%;
  object-fit: cover; display: block;
  background: var(--bg-inset);
  border: 1.5px solid var(--bg-card, #fff);
  box-shadow: 0 0 0 1px var(--border-default);
  transition: transform 300ms ease, z-index 0s;
  cursor: default;
}
.at-item:hover .at-avatar { transform: scale(1.35); z-index: 30; position: relative; }
.at-avatar-off { opacity: 0.4; filter: grayscale(1); }
.at-tip {
  position: absolute; top: -44px; left: 50%; translate: -50% 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  z-index: 50; padding: 6px 14px; border-radius: 8px;
  background: #111111; box-shadow: 0 10px 24px rgba(0,0,0,0.25);
}
.at-line { position: absolute; bottom: -1px; height: 1px; width: 40%; z-index: 30; }
.at-line-a { left: 40px; width: 20%; background: linear-gradient(to right, transparent, #10b981, transparent); }
.at-line-b { left: 10px; background: linear-gradient(to right, transparent, #0ea5e9, transparent); }
.at-name { position: relative; z-index: 30; font-size: 12.5px; font-weight: 700; color: #ffffff; }
.at-sub { position: relative; z-index: 30; font-size: 9.5px; font-weight: 550; color: rgba(255,255,255,0.55); }

.qc-oauth {
  align-self: flex-start; margin-top: 14px;
  display: inline-flex; align-items: center; gap: 6px;
  font-family: inherit; font-size: 12px; font-weight: 650;
  color: #ffffff; background: #111111; border: none;
  padding: 8px 16px; border-radius: 999px; cursor: pointer;
  transition: opacity 160ms ease;
}
.qc-oauth:hover:not(:disabled) { opacity: 0.85; }
.qc-oauth:disabled { opacity: 0.55; cursor: not-allowed; }
.qc-oauth-error { margin: 10px 0 0; font-size: 10.5px; font-weight: 550; color: #ff5a5f; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.qc-test-result { margin: 12px 0 0; font-size: 10.5px; font-weight: 550; line-height: 1.5; word-break: break-word; }
.qc-test-connected { color: #128a6d; }
.qc-test-timeout { color: #b7791f; }
.qc-test-error { color: #d92c3c; }
@keyframes qcSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.qc-spin { animation: qcSpin 1s linear infinite; }

.qc-foot {
  display: flex; align-items: center; gap: 4px;
  margin-top: 16px; padding: 12px 0 16px;
  border-top: 1px solid var(--border-default);
}
.qc-act {
  display: inline-flex; align-items: center; gap: 5px;
  font-family: inherit; font-size: 11.5px; font-weight: 600;
  padding: 6px 10px; border-radius: 9px; border: none; background: transparent;
  color: var(--text-muted); cursor: pointer;
  transition: all 150ms ease;
}
.qc-act:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-inset); }
.qc-act:disabled { opacity: 0.5; cursor: not-allowed; }
.qc-manage {
  margin-left: auto;
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 650; color: var(--text-muted);
  padding: 6px 8px; border-radius: 9px; cursor: pointer;
  transition: color 150ms ease;
}
.qc-card:hover .qc-manage { color: var(--text-primary); }

:root[data-theme="dark"] .qc-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .qc-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .qc-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
:root[data-theme="dark"] .qc-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
:root[data-theme="dark"] .qc-state-err { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
:root[data-theme="dark"] .qc-oauth { background: #f2f5f9; color: #0a0d13; }
:root[data-theme="dark"] .qc-test-connected { color: #2fe6b0; }
:root[data-theme="dark"] .qc-test-timeout { color: #ffb020; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .qc-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .qc-card:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .qc-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
  :root:not([data-theme]) .qc-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
  :root:not([data-theme]) .qc-state-err { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
  :root:not([data-theme]) .qc-oauth { background: #f2f5f9; color: #0a0d13; }
  :root:not([data-theme]) .qc-test-connected { color: #2fe6b0; }
  :root:not([data-theme]) .qc-test-timeout { color: #ffb020; }
}
      `}</style>
    </motion.div>
  );
}
