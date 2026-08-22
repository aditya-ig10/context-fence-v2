import { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import {
  X, RefreshCw, Play, Trash2, Shield, ShieldCheck, ShieldAlert,
  Globe, Terminal, KeyRound, Lock, AlertTriangle, PencilLine, Link2, Sparkles, Plus, Cpu, CheckCircle2,
} from 'lucide-react';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { useOauthConnect, oauthAction } from '../hooks/useOauthConnect';
import { notify } from './Toasts';
import { LOGOS } from '../lib/agentLogos';
import TestCallModal from './TestCallModal';
import type { ConnectorDetail as Detail, ConnectorTool } from '../types';

// Slide-over detail panel for one connector: live tool inventory (from
// discovered_tools) with per-tool allow/block/log-only toggles that write
// scoped custom_policies rules, agent bindings wired to the protect/rewrite
// flow, auth config (credentials stored in mcp_servers.headers, values never
// returned by the API — only "•••• saved" state), sync + test-call actions.

export interface DetectedAgentItem {
  name?: string;
  type?: string;
  agentName?: string;
  agentType?: string;
  status?: string;
  protected?: boolean;
}

interface ConnectorDetailProps {
  serverName: string;
  serverType: 'stdio' | 'http';
  onClose: () => void;
  onChanged: () => void;
  detectedAgents?: DetectedAgentItem[];
  /** Render as a full page (routed) instead of a slide-over drawer. */
  embedded?: boolean;
  /** Which sections to render (default: all). Lets the routed page own some sections. */
  sections?: ('tools' | 'agents' | 'auth' | 'activity' | 'config')[];
}

type AuthType = 'none' | 'apikey' | 'bearer' | 'oauth2';

const AUTH_OPTIONS: { value: AuthType; label: string; hint: string }[] = [
  { value: 'none', label: 'None', hint: 'Open endpoint' },
  { value: 'apikey', label: 'API key', hint: 'Custom header' },
  { value: 'bearer', label: 'Bearer token', hint: 'Authorization: Bearer' },
  { value: 'oauth2', label: 'OAuth2', hint: 'Authorization code + PKCE' },
];

const ACTION_META: Record<string, { icon: typeof Shield; color: string; bg: string }> = {
  allow: { icon: ShieldCheck, color: '#00a699', bg: 'rgba(0,166,153,0.08)' },
  deny: { icon: ShieldAlert, color: '#ff5a5f', bg: 'rgba(255,90,95,0.08)' },
  log: { icon: Shield, color: '#fcb400', bg: 'rgba(252,180,0,0.08)' },
};

function HourSparkline({ hours }: { hours: { hour: number; count: number }[] }) {
  const buckets = hours.reduce((acc, h) => {
    acc[h.hour] = (acc[h.hour] ?? 0) + h.count;
    return acc;
  }, {} as Record<number, number>);
  const now = new Date().getHours();
  const points: { hour: number; count: number }[] = [];
  for (let i = 23; i >= 0; i--) {
    const hour = ((now - i) % 24 + 24) % 24;
    points.push({ hour, count: buckets[hour] ?? 0 });
  }
  const max = Math.max(1, ...points.map((p) => p.count));
  return (
    <div className="cd-spark" title="Calls per hour (last 24h)">
      {points.map((p, i) => (
        <div
          key={i}
          className="cd-spark-bar"
          style={{ height: `${Math.max(8, (p.count / max) * 100)}%`, background: p.count > 0 ? 'var(--accent-coral)' : 'var(--bg-inset)' }}
        />
      ))}
    </div>
  );
}

// ── Configuration section (General + Per-Agent Override tabs) ───────────────
// General: the registered config as rendered from GET /api/servers/:name —
// read-only. Env values stay masked until reveal; values come from the
// agent-configs inspection endpoint (fetched lazily on first reveal).
// Per-Agent: which agents' configs declare this server and whether each
// declaration matches what Context Fence registered.

interface AgentConfigRow {
  agentName: string;
  agentPath: string;
  command: string[];
  args: string[];
  url: string | null;
  env: Record<string, string>;
  rewired: boolean;
  inSync: boolean;
}

interface AgentConfigsPayload {
  registered?: {
    name: string;
    type: string;
    url: string | null;
    command: string[];
    args: string[];
    env: Record<string, string>;
  };
  agents?: AgentConfigRow[];
}

function ConfigurationSection({
  serverName,
  type,
  command,
  url,
  envKeys,
  lastSync,
}: {
  serverName: string;
  type: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  envKeys: string[];
  lastSync: string | null;
}) {
  const [tab, setTab] = useState<'general' | 'agents'>('general');
  const [payload, setPayload] = useState<AgentConfigsPayload | null>(null);
  const [loadingAgents, setLoadingAgents] = useState(false);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [revealEnv, setRevealEnv] = useState(false);

  async function loadAgentConfigs() {
    setLoadingAgents(true);
    setAgentsError(null);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/agent-configs`);
      const body = (await res.json().catch(() => ({}))) as AgentConfigsPayload & { error?: string };
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      setPayload(body);
    } catch (err) {
      setAgentsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAgents(false);
    }
  }

  function switchTab(next: 'general' | 'agents') {
    setTab(next);
    if (next === 'agents' && !payload && !loadingAgents) void loadAgentConfigs();
  }

  function toggleReveal() {
    const next = !revealEnv;
    setRevealEnv(next);
    if (next && !payload && !loadingAgents) void loadAgentConfigs();
  }

  const regEnv = payload?.registered?.env ?? null;

  return (
    <section className="cd-section" id="cd-config-section">
      <div className="cd-section-head">
        <h3 className="cd-section-title">Configuration</h3>
        <div className="cd-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'general'} className={`cd-tab ${tab === 'general' ? 'active' : ''}`} onClick={() => switchTab('general')}>
            General
          </button>
          <button role="tab" aria-selected={tab === 'agents'} className={`cd-tab ${tab === 'agents' ? 'active' : ''}`} onClick={() => switchTab('agents')}>
            Per-Agent
          </button>
        </div>
      </div>

      {tab === 'general' ? (
        <div className="cd-config-grid">
          <span className="cd-config-key">Connection</span>
          <span className="cd-config-val">
            <span className="cd-code">{type}</span>
            {type === 'http' ? (
              url ? <span className="cd-config-mono">{url}</span> : <span className="cd-config-dim">no URL</span>
            ) : command ? (
              <span className="cd-config-mono">{command}{payload?.registered?.args?.length ? ' ' + payload.registered.args.join(' ') : ''}</span>
            ) : (
              <span className="cd-config-dim">not configured</span>
            )}
          </span>

          <span className="cd-config-key">Env vars</span>
          <span className="cd-config-val">
            {envKeys.length === 0 ? (
              <span className="cd-config-dim">none declared</span>
            ) : (
              <div className="cd-env-list">
                {envKeys.map((k) => {
                  const val = regEnv?.[k];
                  return (
                    <span key={k} className="cd-env-row">
                      <span className="cd-code">{k}</span>
                      <span className="cd-env-val">
                        {val === undefined
                          ? '(from agent config)'
                          : revealEnv
                            ? val
                            : '••••••••'}
                      </span>
                    </span>
                  );
                })}
                <button className="cd-btn cd-btn-small" onClick={toggleReveal} title={revealEnv ? 'Hide values' : 'Show stored values'}>
                  <KeyRound size={10} /> {revealEnv ? 'Hide' : 'Reveal'}
                </button>
              </div>
            )}
          </span>

          <span className="cd-config-key">Last synced</span>
          <span className="cd-config-val">
            {lastSync ? new Date(lastSync.replace(' ', 'T')).toLocaleString() : <span className="cd-config-dim">never — run Sync tools</span>}
          </span>
        </div>
      ) : loadingAgents ? (
        <div className="cd-config-loading"><RefreshCw size={12} className="cd-spin" /> Inspecting agent configs…</div>
      ) : agentsError ? (
        <div className="cd-banner cd-banner-error cd-banner-inline"><AlertTriangle size={12} /> {agentsError}</div>
      ) : (payload?.agents?.length ?? 0) === 0 ? (
        <p className="cd-note">No detected agent config declares “{serverName}”. It may have been added directly in Context Fence.</p>
      ) : (
        <div className="cd-agentcfg-list">
          {payload!.agents!.map((a, i) => (
            <div key={`${a.agentName}-${a.agentPath}-${i}`} className="cd-agentcfg">
              <div className="cd-agentcfg-head">
                <span className="cd-agent-name">{a.agentName}</span>
                {a.inSync ? (
                  <span className="cd-sync-badge ok" title="Agent declaration matches the registered config (or is rewired through the proxy)">
                    ✓ In sync{a.rewired ? ' (rewired)' : ''}
                  </span>
                ) : (
                  <span className="cd-sync-badge warn" title="Agent declaration differs from the registered config">
                    ⚠ Out of sync
                  </span>
                )}
              </div>
              <p className="cd-agentcfg-path" title={a.agentPath}>{a.agentPath}</p>
              <div className="cd-agentcfg-cols">
                <div className="cd-agentcfg-col">
                  <span className="cd-config-key">Agent config</span>
                  <pre className="cd-config-pre">{a.url ? a.url : [a.command, ...a.args].join(' ') || '(empty)'}</pre>
                </div>
                <div className="cd-agentcfg-col">
                  <span className="cd-config-key">Registered</span>
                  <pre className="cd-config-pre">{payload?.registered ? ((payload.registered.url ?? payload.registered.command.join(' ')) || '(empty)') : '—'}</pre>
                </div>
              </div>
              {Object.keys(a.env).length > 0 && (
                <p className="cd-agentcfg-env">
                  env: {Object.keys(a.env).join(', ')}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function ConnectorDetail({ serverName, serverType, onClose, onChanged, detectedAgents, embedded, sections: sectionsProp }: ConnectorDetailProps) {
  const show = Object.fromEntries(
    (['tools', 'agents', 'auth', 'activity', 'config'] as const).map((k) => [k, !sectionsProp || sectionsProp.includes(k)]),
  ) as Record<'tools' | 'agents' | 'auth' | 'activity' | 'config', boolean>;
  const navigate = useNavigate();
  const { data, loading, refresh } = useCachedFetch<Detail>(`server:${serverName}`, () =>
    fetch(`/api/servers/${encodeURIComponent(serverName)}`).then((r) => r.json()), { maxAgeMs: 15_000 });

  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [testOpen, setTestOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [togglingTool, setTogglingTool] = useState<string | null>(null);
  const [bindingBusy, setBindingBusy] = useState<string | null>(null);
  const [bindingError, setBindingError] = useState<string | null>(null);
  const [selectedAgentToAdd, setSelectedAgentToAdd] = useState<string>('');

  const [authType, setAuthType] = useState<AuthType>('none');
  const [authInit, setAuthInit] = useState(false);
  const [apiKeyHeader, setApiKeyHeader] = useState('');
  const [apiKeyValue, setApiKeyValue] = useState('');
  const [bearerValue, setBearerValue] = useState('');
  const [oauthUrl, setOauthUrl] = useState('');
  const [oauthAuthUrl, setOauthAuthUrl] = useState('');
  const [oauthScope, setOauthScope] = useState('');
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthSecret, setOauthSecret] = useState('');
  const [discovering, setDiscovering] = useState(false);
  const { connecting: oauthConnecting, error: oauthError, connect: oauthConnect } = useOauthConnect(serverName);
  const [authSaving, setAuthSaving] = useState(false);
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const server = data?.server;
  const tools = data?.tools ?? [];
  const stats = data?.stats;

  useEffect(() => {
    if (server && !authInit) {
      setAuthType((server.authType ?? 'none') as AuthType);
      setAuthInit(true);
      setApiKeyHeader(server.headerNames.find((h) => h.toLowerCase() !== 'authorization') ?? 'X-API-Key');
    }
  }, [server, authInit]);

  function invalidate() {
    invalidateCache((k) => k.startsWith('server:') || k === 'servers' || k.startsWith('policies'));
    refresh();
    onChanged();
  }

  async function handleSync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/sync-tools`, { method: 'POST' });
      const data = await res.json();
      if (!data.ok) setSyncError(data.error ?? 'Sync failed');
    } catch {
      setSyncError('Failed to reach the backend');
    }
    setSyncing(false);
    invalidate();
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await fetch(`/api/servers/${encodeURIComponent(serverName)}`, { method: 'DELETE' });
      onClose();
      onChanged();
    } catch { /* keep open */ }
    setRemoving(false);
  }

  // Per-tool policy toggle: writes a scoped custom_policies rule named
  // connector:<server>:<tool>. The same rule appears in the Policies page
  // (origin Custom) and is enforced by the engine's servers condition.
  async function setToolPolicy(tool: ConnectorTool, action: 'allow' | 'deny' | 'log') {
    setTogglingTool(tool.name);
    const ruleName = `connector:${serverName}:${tool.name}`;
    const body = {
      name: ruleName,
      description: `Per-tool policy for ${tool.name} on connector ${serverName}`,
      action,
      reason: action === 'deny'
        ? `Tool ${tool.name} blocked on ${serverName} from the connector page`
        : action === 'log'
          ? `Tool ${tool.name} calls logged on ${serverName}`
          : `Tool ${tool.name} allowed on ${serverName}`,
      methods: 'tools/call',
      tools: tool.name,
      servers: serverName,
    };
    try {
      if (tool.policy) {
        await fetch(`/api/policies/${encodeURIComponent(ruleName)}/override`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      } else {
        await fetch('/api/policies/create', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
      }
    } catch { /* surface via refresh */ }
    setTogglingTool(null);
    invalidate();
  }

  async function toggleBinding(agentType: string, bind: boolean) {
    setBindingBusy(agentType);
    setBindingError(null);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentType, enabled: bind }),
      });
      const data = await res.json();
      if (!data.ok) {
        setBindingError(data.error ?? 'Binding failed');
        notify.error('Binding failed', data.error ?? 'Could not bind agent');
      } else {
        if (bind) {
          notify.success(`Installed to ${agentType}`, 'MCP server configured and routed through Context Fence proxy');
        } else {
          notify.info(`Unbound from ${agentType}`, 'Agent configuration unlinked');
        }
        if (bind && data.protectError) {
          setBindingError(`Bound, but config rewrite warning: ${data.protectError}`);
        }
      }
    } catch {
      setBindingError('Failed to reach the backend');
      notify.error('Binding failed', 'Could not reach backend');
    }
    setBindingBusy(null);
    invalidate();
  }

  async function saveAuth() {
    setAuthSaving(true);
    setAuthMsg(null);
    const headers: Record<string, string> = {};
    if (authType === 'apikey') {
      if (apiKeyHeader.trim()) headers[apiKeyHeader.trim()] = apiKeyValue;
    } else if (authType === 'bearer') {
      headers.Authorization = bearerValue ? `Bearer ${bearerValue.trim()}` : '';
    } else if (authType === 'oauth2') {
      if (oauthUrl.trim() && oauthClientId.trim()) {
        const block: Record<string, string> = {
          token_url: oauthUrl.trim(),
          client_id: oauthClientId.trim(),
          client_secret: oauthSecret,
          use_pkce: 'true',
        };
        if (oauthAuthUrl.trim()) block.authorization_url = oauthAuthUrl.trim();
        if (oauthScope.trim()) block.scope = oauthScope.trim();
        headers.__oauth = JSON.stringify(block);
      }
      // fields empty → keep stored config (omitting __oauth means no change)
    }
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ auth_type: authType, headers }),
      });
      const data = await res.json();
      if (res.ok) {
        setAuthMsg({ ok: true, text: authType === 'none' ? 'Auth cleared' : 'Credentials saved (values never echoed back)' });
        setBearerValue('');
        setApiKeyValue('');
        setOauthSecret('');
      } else {
        setAuthMsg({ ok: false, text: data.error ?? 'Failed to save' });
      }
    } catch {
      setAuthMsg({ ok: false, text: 'Failed to reach the backend' });
    }
    setAuthSaving(false);
    invalidate();
  }

  // MCP-spec discovery (RFC 9728 → RFC 8414): ask the provider for its
  // authorization/token endpoints and prefill the form.
  async function discoverOauth() {
    if (discovering) return;
    setDiscovering(true);
    setAuthMsg(null);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}/oauth/discover`, { method: 'POST' });
      const data = await res.json();
      if (data.ok) {
        setOauthAuthUrl(data.authorization_url);
        setOauthUrl(data.token_url);
        if (data.scope) setOauthScope(data.scope);
        setAuthMsg({ ok: true, text: 'Provider metadata found — endpoints populated' });
      } else {
        setAuthMsg({ ok: false, text: data.error ?? 'Discovery failed — enter endpoints manually' });
      }
    } catch {
      setAuthMsg({ ok: false, text: 'Failed to reach the backend' });
    }
    setDiscovering(false);
  }

  async function handleOauthConnect() {
    setAuthMsg(null);
    const ok = await oauthConnect();
    if (ok) {
      setAuthMsg({ ok: true, text: 'Authorized — token stored, connectors can now sync' });
      invalidate();
    }
  }

  const fallbackDetect = useCachedFetch<{ agents: DetectedAgentItem[] }>('detect', () =>
    fetch('/api/detect').then((r) => r.json()), { maxAgeMs: 30_000 }
  );

  const normalizedAgents: { name: string; type: string; icon?: string; configPath?: string }[] = useMemo(() => {
    const rawList: DetectedAgentItem[] = (detectedAgents && detectedAgents.length > 0)
      ? detectedAgents
      : (fallbackDetect.data?.agents ?? []);

    const KNOWN_NAMES: Record<string, string> = {
      opencode: 'OpenCode',
      claude: 'Claude Desktop',
      'claude-desktop': 'Claude Desktop',
      'claude-code': 'Claude Code',
      cursor: 'Cursor',
      cline: 'Cline',
      windsurf: 'Windsurf',
      gemini: 'Gemini CLI (Antigravity)',
      antigravity: 'Gemini CLI (Antigravity)',
      codex: 'Codex',
      copilot: 'GitHub Copilot',
      continue: 'Continue',
      aider: 'Aider',
      project: 'Project Local',
    };

    const map = new Map<string, { name: string; type: string; icon?: string; configPath?: string }>();

    for (const a of rawList) {
      const type = (a.type || a.agentType || '').trim();
      if (!type) continue;
      let name = (a.name || a.agentName || '').trim();
      if (!name) {
        name = KNOWN_NAMES[type.toLowerCase()] || type.charAt(0).toUpperCase() + type.slice(1);
      }
      map.set(type.toLowerCase(), {
        name,
        type,
        icon: (a as { iconPath?: string; icon?: string }).iconPath || (a as { iconPath?: string; icon?: string }).icon,
        configPath: (a as { configPath?: string }).configPath,
      });
    }

    return Array.from(map.values());
  }, [detectedAgents, fallbackDetect.data]);

  const currentSelectedAgent = useMemo(() => {
    if (!normalizedAgents.length) return null;
    const found = normalizedAgents.find((a) => a.type === selectedAgentToAdd);
    return found || normalizedAgents[0];
  }, [normalizedAgents, selectedAgentToAdd]);

  const boundTypes = useMemo(() => {
    const set = new Set<string>();
    for (const b of server?.boundAgents ?? []) {
      if (b.enabled && b.agentType) {
        set.add(b.agentType.toLowerCase());
      }
    }
    return set;
  }, [server?.boundAgents]);

  const oauthActionName = server ? oauthAction(server) : null;

  const panel = (
    <motion.div
      key="cd-panel"
      className={`cd-panel${embedded ? ' cd-panel--page' : ''}`}
      initial={embedded ? false : { x: '100%' }}
      animate={{ x: 0 }}
      exit={embedded ? undefined : { x: '100%' }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
          {!server ? (
            <div className="cd-loading">{loading ? 'Loading connector…' : 'Connector not found'}</div>
          ) : (
            <>
              <div className="cd-head">
                <div className="cd-head-main">
                  <div className="cd-head-icon">
                    {serverType === 'http' ? <Globe size={20} strokeWidth={1.75} /> : <Terminal size={20} strokeWidth={1.75} />}
                  </div>
                  <div className="cd-head-text">
                    <h2 className="cd-title">{server.name}</h2>
                    <p className="cd-origin">
                      {serverType === 'http' ? server.url : server.command}
                      {server.envSet && <span className="cd-env-chip">{(server.envKeys ?? []).length} env vars (masked)</span>}
                    </p>
                  </div>
                  <button className="cd-close" onClick={onClose} title="Close">✕</button>
                </div>
                <div className="cd-head-actions">
                  <button className="cd-btn cd-btn-sync" onClick={handleSync} disabled={syncing}>
                    <RefreshCw size={12} className={syncing ? 'cd-spin' : ''} />
                    {syncing ? 'Syncing…' : 'Sync tools'}
                  </button>
                  <button className="cd-btn cd-btn-test" onClick={() => setTestOpen(true)}>
                    <Play size={12} /> Test call
                  </button>
                  <button className="cd-btn cd-btn-danger" onClick={handleRemove} disabled={removing}>
                    <Trash2 size={12} /> {removing ? 'Removing…' : 'Remove'}
                  </button>
                </div>
              </div>

              {syncError && (
                <div className="cd-banner cd-banner-error">
                  <AlertTriangle size={13} />
                  <div>
                    <p className="cd-banner-title">Connection failed — tools not synced</p>
                    <p className="cd-banner-text">{syncError}</p>
                    <div className="cd-banner-actions">
                      <button className="cd-btn cd-btn-small" onClick={handleSync} disabled={syncing}>Retry sync</button>
                      <button
                        className="cd-btn cd-btn-small"
                        onClick={() => document.getElementById('cd-auth-section')?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
                      >Edit credentials</button>
                    </div>
                  </div>
                </div>
              )}

              <div className="cd-body">
                {show.tools && (
                <section className="cd-section">
                  <div className="cd-section-head">
                    <h3 className="cd-section-title">Tools <span className="cd-count">{tools.length}</span></h3>
                    <span className="cd-section-meta">
                      {server.lastSync ? `synced ${server.lastSync}` : 'not synced yet'}
                      {tools.length === 0 && !server.lastSync && ' — run Sync tools'}
                    </span>
                  </div>
                  {tools.length === 0 ? (
                    <div className="cd-empty-tools">
                      <Shield size={22} strokeWidth={1.5} />
                      <p>No tools discovered yet. Run a sync to pull the live tool list from the connector.</p>
                    </div>
                  ) : (
                    <div className="cd-tools">
                      {tools.map((t, i) => {
                        const action = t.policy?.action ?? null;
                        const meta = action ? ACTION_META[action] : null;
                        const ActiveIcon = meta?.icon ?? ShieldCheck;
                        return (
                          <div key={`${t.name}-${i}`} className="cd-tool">
                            <div className="cd-tool-main">
                              <div className="cd-tool-name-row">
                                <p className="cd-tool-name">{t.name}</p>
                                {action && meta && (
                                  <span className="cd-tool-action" style={{ color: meta.color, background: meta.bg }}>
                                    <ActiveIcon size={10} /> {action}
                                  </span>
                                )}
                              </div>
                              {t.schema.description && <p className="cd-tool-desc">{t.schema.description}</p>}
                            </div>
                            <div className="cd-tool-controls">
                              <div className="cd-toggle" role="group" aria-label={`Policy for ${t.name}`}>
                                {(['allow', 'deny', 'log'] as const).map((a) => (
                                  <button
                                    key={a}
                                    className={`cd-toggle-btn ${action === a ? `active-${a}` : ''}`}
                                    disabled={togglingTool === t.name}
                                    onClick={() => setToolPolicy(t, a)}
                                    title={`${a === 'deny' ? 'Block' : a === 'log' ? 'Log only' : 'Allow'} ${t.name}`}
                                  >{a}</button>
                                ))}
                              </div>
                              <button
                                className="cd-tool-edit"
                                title="Edit as rule (Policies page)"
                                onClick={() => navigate('/policies', { state: {
                                  new: true,
                                  prefill: {
                                    name: `connector:${serverName}:${t.name}`,
                                    description: `Per-tool policy for ${t.name} on connector ${serverName}`,
                                    action: t.policy?.action ?? 'allow',
                                    reason: t.policy?.action ? '' : `Tool ${t.name} on ${serverName}`,
                                    methods: 'tools/call',
                                    tools: t.name,
                                  },
                                } })}
                              ><PencilLine size={11} /> Rule</button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
                )}

                {show.agents && (
                <section className="cd-section">
                  <div className="cd-section-head">
                    <div>
                      <h3 className="cd-section-title">
                        Agent Protection
                        <span className="cd-count">{boundTypes.size}</span>
                      </h3>
                      <span className="cd-section-meta">Route tool calls through the Context Fence proxy (:3001)</span>
                    </div>
                  </div>
                  {bindingError && <div className="cd-banner cd-banner-error cd-banner-inline"><AlertTriangle size={12} /> {bindingError}</div>}
                  
                  {boundTypes.size === 0 ? (
                    <div className="cd-add-agent-card">
                      <div className="cd-add-agent-header">
                        <div className="cd-add-agent-icon-stage">
                          {currentSelectedAgent && (LOGOS[currentSelectedAgent.type.toLowerCase()] || LOGOS[currentSelectedAgent.name.toLowerCase()]) ? (
                            <img
                              src={LOGOS[currentSelectedAgent.type.toLowerCase()] || LOGOS[currentSelectedAgent.name.toLowerCase()]}
                              alt={currentSelectedAgent.name}
                              className="cd-add-agent-brand-logo"
                            />
                          ) : (
                            <Cpu size={24} className="cd-add-agent-brand-fallback" />
                          )}
                        </div>

                        <div className="cd-add-agent-info">
                          <div className="cd-add-agent-title-row">
                            <h4 className="cd-add-agent-name">{currentSelectedAgent?.name ?? 'Select Agent'}</h4>
                            <span className="cd-add-agent-tag">Installed on Machine</span>
                          </div>
                          <p className="cd-add-agent-sub">
                            {currentSelectedAgent?.configPath ? (
                              <code className="cd-agent-path-code">{currentSelectedAgent.configPath}</code>
                            ) : (
                              'Auto-injects MCP configuration and routes all tool calls through the Context Fence proxy (:3001).'
                            )}
                          </p>
                        </div>
                      </div>

                      {normalizedAgents.length === 0 ? (
                        <p className="cd-note">
                          No supported AI agents currently detected on this machine. Launch an agent (such as OpenCode, Claude Desktop, or Cursor) to bind connectors.
                        </p>
                      ) : (
                        <div className="cd-add-agent-actions">
                          {normalizedAgents.length > 1 && (
                            <div className="cd-agent-picker-wrap">
                              <label className="cd-agent-picker-label">Target Agent</label>
                              <select
                                className="glass-select cd-agent-select"
                                value={currentSelectedAgent?.type ?? ''}
                                onChange={(e) => setSelectedAgentToAdd(e.target.value)}
                              >
                                {normalizedAgents.map((a) => (
                                  <option key={a.type} value={a.type}>
                                    {a.name} ({a.type})
                                  </option>
                                ))}
                              </select>
                            </div>
                          )}

                          <button
                            type="button"
                            className="cd-btn cd-btn-primary cd-btn-install"
                            disabled={bindingBusy !== null || !currentSelectedAgent}
                            onClick={() => {
                              if (currentSelectedAgent) toggleBinding(currentSelectedAgent.type, true);
                            }}
                          >
                            {bindingBusy ? (
                              <><RefreshCw size={13} className="cd-spin" /> Installing to {currentSelectedAgent?.name}…</>
                            ) : (
                              <><Plus size={14} strokeWidth={2.4} /> Install to {currentSelectedAgent?.name ?? 'Agent'}</>
                            )}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="cd-bound-agents-container">
                      <div className="cd-agents">
                        {normalizedAgents
                          .filter((a) => boundTypes.has(a.type.toLowerCase()))
                          .map((a, ai) => {
                            const logo = LOGOS[a.type.toLowerCase()] || LOGOS[a.name.toLowerCase()];
                            return (
                              <div key={`${a.type}-${ai}`} className="cd-agent-bound-card">
                                <div className="cd-agent-bound-left">
                                  <div className="cd-agent-icon-box">
                                    {logo ? (
                                      <img src={logo} alt="" className="cd-agent-bound-logo" />
                                    ) : (
                                      <Cpu size={16} />
                                    )}
                                  </div>
                                  <div className="cd-agent-bound-meta">
                                    <div className="cd-agent-bound-name-row">
                                      <span className="cd-agent-bound-name">{a.name}</span>
                                      <span className="cd-agent-routed-badge">
                                        <span className="cd-badge-pulse" /> Routed via Proxy :3001
                                      </span>
                                    </div>
                                    <span className="cd-agent-bound-path">
                                      {a.configPath || `${a.type} configuration rewired`}
                                    </span>
                                  </div>
                                </div>

                                <button
                                  type="button"
                                  className="cd-btn-unbind"
                                  disabled={bindingBusy === a.type}
                                  onClick={() => toggleBinding(a.type, false)}
                                  title="Unbind from agent"
                                >
                                  {bindingBusy === a.type ? 'Unbinding…' : 'Unbind'}
                                </button>
                              </div>
                            );
                          })}
                      </div>

                      {normalizedAgents.some((a) => !boundTypes.has(a.type.toLowerCase())) && (
                        <div className="cd-add-more-card">
                          <span className="cd-add-more-label">Connect another installed agent:</span>
                          <select
                            className="glass-select cd-add-more-select"
                            value={
                              selectedAgentToAdd ||
                              normalizedAgents.find((a) => !boundTypes.has(a.type.toLowerCase()))?.type ||
                              ''
                            }
                            onChange={(e) => setSelectedAgentToAdd(e.target.value)}
                          >
                            {normalizedAgents
                              .filter((a) => !boundTypes.has(a.type.toLowerCase()))
                              .map((a) => (
                                <option key={a.type} value={a.type}>
                                  {a.name} ({a.type})
                                </option>
                              ))}
                          </select>
                          <button
                            type="button"
                            className="cd-btn cd-btn-small cd-btn-primary"
                            disabled={bindingBusy !== null}
                            onClick={() => {
                              const fallback = normalizedAgents.find((a) => !boundTypes.has(a.type.toLowerCase()))?.type;
                              const target = selectedAgentToAdd || fallback;
                              if (target) toggleBinding(target, true);
                            }}
                          >
                            <Plus size={11} strokeWidth={2.4} /> Add
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </section>
                )}

                {show.auth && (
                <section className="cd-section" id="cd-auth-section">
                  <div className="cd-section-head">
                    <h3 className="cd-section-title">Authentication</h3>
                    <span className="cd-section-meta">
                      <Lock size={10} />
                      {server.hasCredentials ? 'credentials saved (masked)' : 'no credentials stored'}
                    </span>
                  </div>
                  <div className="cd-auth-type">
                    {AUTH_OPTIONS.map((o) => (
                      <button
                        key={o.value}
                        className={`cd-auth-opt ${authType === o.value ? 'active' : ''}`}
                        onClick={() => setAuthType(o.value)}
                        title={o.hint}
                      >{o.label}</button>
                    ))}
                  </div>

                  {authType === 'none' && (
                    <p className="cd-note">No auth sent. Stored credentials are cleared when you save.</p>
                  )}
                  {authType === 'apikey' && (
                    <>
                      <label className="cd-label">Header name</label>
                      <input className="glass-input cd-input" value={apiKeyHeader} onChange={(e) => setApiKeyHeader(e.target.value)} placeholder="X-API-Key" />
                      <label className="cd-label">Key value</label>
                      <input
                        className="glass-input cd-input" type="password"
                        value={apiKeyValue} onChange={(e) => setApiKeyValue(e.target.value)}
                        placeholder={server.hasCredentials ? '•••••••• saved — type to replace' : 'API key (stored, never echoed back)'}
                      />
                    </>
                  )}
                  {authType === 'bearer' && (
                    <>
                      <label className="cd-label">Bearer token</label>
                      <input
                        className="glass-input cd-input" type="password"
                        value={bearerValue} onChange={(e) => setBearerValue(e.target.value)}
                        placeholder={server.hasCredentials ? '•••••••• saved — type to replace' : 'Token (stored, never echoed back)'}
                      />
                    </>
                  )}
                  {authType === 'oauth2' && (
                    <>
                      <p className="cd-note">
                        One-click sign-in (OAuth 2.1 + PKCE, per the MCP spec): <b>Connect</b> opens the
                        provider's page in your browser, and the app finishes the rest — the token is stored
                        and refreshed silently. Client credentials are optional — only used as a fallback for
                        token services.
                      </p>

                      {oauthActionName && (
                        <div className="cd-oauth-actions">
                          <button
                            className="cd-btn cd-btn-oauth"
                            onClick={handleOauthConnect}
                            disabled={oauthConnecting}
                          >
                            {oauthConnecting
                              ? <><RefreshCw size={12} className="cd-spin" /> Waiting for browser…</>
                              : oauthActionName === 'reauthorize'
                                ? <><ShieldAlert size={12} /> Reauthorize</>
                                : <><Link2 size={12} /> Connect</>}
                          </button>
                          {oauthConnecting && (
                            <span className="cd-auth-msg ok">
                              Open the browser tab that just appeared, approve access, then come back here.
                            </span>
                          )}
                          {!oauthConnecting && oauthError && (
                            <span className="cd-auth-msg fail">{oauthError}</span>
                          )}
                        </div>
                      )}
                      {server.oauth?.hasToken && !oauthActionName && (
                        <span className={`cd-oauth-status ok`}>
                          <ShieldCheck size={11} /> Authorized — token expires {server.oauth.expiresAt
                            ? new Date(server.oauth.expiresAt).toLocaleString()
                            : 'unknown'}
                        </span>
                      )}
                      {server.oauth?.hasToken && server.oauth.expired && server.oauth.hasRefreshToken && (
                        <span className="cd-oauth-status fail">
                          Token expired — will refresh automatically on the next sync.
                        </span>
                      )}

                      <label className="cd-label">Authorization URL</label>
                      <input
                        className="glass-input cd-input"
                        value={oauthAuthUrl}
                        onChange={(e) => setOauthAuthUrl(e.target.value)}
                        placeholder="https://auth.example.com/oauth/authorize"
                      />
                      <div className="cd-discover-row">
                        <label className="cd-label">Token URL</label>
                        <button className="cd-btn cd-btn-small" onClick={discoverOauth} disabled={discovering}>
                          <Sparkles size={11} />
                          {discovering ? 'Discovering…' : 'Discover from provider'}
                        </button>
                      </div>
                      <input
                        className="glass-input cd-input"
                        value={oauthUrl}
                        onChange={(e) => setOauthUrl(e.target.value)}
                        placeholder="https://auth.example.com/oauth/token"
                      />
                      <label className="cd-label">Client ID</label>
                      <input className="glass-input cd-input" value={oauthClientId} onChange={(e) => setOauthClientId(e.target.value)} placeholder="client_id" />
                      <label className="cd-label">Client secret <span className="cd-label-optional">optional — PKCE protects public clients</span></label>
                      <input
                        className="glass-input cd-input" type="password"
                        value={oauthSecret} onChange={(e) => setOauthSecret(e.target.value)}
                        placeholder={server.hasCredentials ? '•••••••• saved — type to replace' : 'client_secret (stored, never echoed back)'}
                      />
                      <label className="cd-label">Scope</label>
                      <input
                        className="glass-input cd-input"
                        value={oauthScope}
                        onChange={(e) => setOauthScope(e.target.value)}
                        placeholder="mcp.read files.read (space-separated)"
                      />
                    </>
                  )}

                  <div className="cd-auth-foot">
                    <button className="cd-btn cd-btn-primary" onClick={saveAuth} disabled={authSaving}>
                      <KeyRound size={12} /> {authSaving ? 'Saving…' : 'Save credentials'}
                    </button>
                    {authMsg && (
                      <span className={`cd-auth-msg ${authMsg.ok ? 'ok' : 'fail'}`}>{authMsg.text}</span>
                    )}
                  </div>
                </section>
                )}

                {show.activity && (
                <section className="cd-section">
                  <div className="cd-section-head">
                    <h3 className="cd-section-title">Activity</h3>
                  </div>
                  <div className="cd-activity">
                    <div className="cd-activity-nums">
                      <div className="cd-activity-num">
                        <span className="cd-activity-value">{stats?.today ?? 0}</span>
                        <span className="cd-activity-label">calls today</span>
                      </div>
                      <div className="cd-activity-num">
                        <span className="cd-activity-value cd-blocked">{stats?.blockedToday ?? 0}</span>
                        <span className="cd-activity-label">blocked today</span>
                      </div>
                    </div>
                    <HourSparkline hours={(stats?.hourly ?? []).map((h) => ({ hour: h.hour, count: h.count }))} />
                  </div>
                </section>
                )}

                {show.config && (
                <ConfigurationSection
                  serverName={serverName}
                  type={serverType}
                  command={server.command}
                  url={server.url ?? null}
                  envKeys={server.envKeys ?? []}
                  lastSync={data.lastSync ?? server.lastSync}
                />
                )}
              </div>
            </>
          )}
        </motion.div>
  );

  const styles = (
      <style>{`
.cd-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(0,0,0,0.35);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
/* Routed (embedded) variant — fills the page instead of overlaying */
.cd-page { animation: cdPageIn 0.3s cubic-bezier(0.22,1,0.36,1); padding: 4px 2px 24px; }
@keyframes cdPageIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
.cd-panel.cd-panel--page {
  position: static;
  width: 100%; max-width: 860px; height: auto; min-height: 0;
  margin: 0 auto;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  overflow: visible;
}
.cd-panel {
  position: absolute; top: 0; right: 0; bottom: 0;
  width: 560px; max-width: 94vw;
  background: var(--bg-surface-elevated);
  border-left: 1px solid var(--border-strong);
  box-shadow: -24px 0 64px rgba(0,0,0,0.18);
  display: flex; flex-direction: column;
  overflow: hidden;
}
.cd-loading { padding: 48px; text-align: center; color: var(--text-muted); font-size: 13px; font-weight: 600; }
.cd-head {
  padding: 22px 26px 16px;
  border-bottom: 1px solid var(--border-default);
  display: flex; flex-direction: column; gap: 12px;
}
.cd-head-main { display: flex; align-items: flex-start; gap: 12px; }
.cd-head-icon {
  width: 42px; height: 42px; border-radius: 13px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, rgba(255,90,95,0.14), rgba(255,90,95,0.05));
  color: var(--accent-coral);
}
.cd-head-text { flex: 1; min-width: 0; }
.cd-title { font-size: 18px; font-weight: 750; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.cd-origin {
  font-size: 11px; font-weight: 500; font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-muted); margin: 3px 0 0; word-break: break-all;
}
.cd-env-chip {
  margin-left: 6px; padding: 1px 8px; border-radius: 100px;
  background: rgba(252,180,0,0.1); color: #b8860b; font-size: 10px; font-weight: 700;
}
.cd-close {
  width: 30px; height: 30px; border-radius: 50%; flex-shrink: 0;
  border: none; cursor: pointer;
  background: var(--bg-inset); color: var(--text-muted); font-size: 12px;
}
.cd-close:hover { color: var(--text-primary); }
.cd-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.cd-btn {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11.5px; font-weight: 700; padding: 7px 14px;
  border-radius: 9999px; border: none; cursor: pointer;
  transition: all 200ms ease;
}
.cd-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.cd-btn-sync { background: var(--bg-inset); color: var(--text-muted); }
.cd-btn-sync:hover:not(:disabled) { color: var(--text-primary); }
.cd-btn-test {
  background: linear-gradient(135deg, var(--accent-coral), #e0484d);
  color: #fff; box-shadow: 0 2px 12px rgba(255,90,95,0.2);
}
.cd-btn-test:hover:not(:disabled) { transform: translateY(-1px); }
.cd-btn-danger { background: transparent; color: var(--text-muted); border: 1px solid var(--border-default); }
.cd-btn-danger:hover:not(:disabled) { color: #ff5a5f; border-color: rgba(255,90,95,0.4); }
.cd-btn-primary {
  background: linear-gradient(135deg, var(--accent-coral), #e0484d);
  color: #fff; box-shadow: 0 2px 12px rgba(255,90,95,0.2);
}
.cd-btn-primary:hover:not(:disabled) { transform: translateY(-1px); }
.cd-btn-small { padding: 5px 12px; font-size: 11px; background: var(--bg-inset); color: var(--text-primary); }
.cd-banner {
  margin: 14px 26px 0; padding: 12px 14px; border-radius: 12px;
  display: flex; gap: 10px; align-items: flex-start;
}
.cd-banner-error { background: rgba(255,90,95,0.07); border: 1px solid rgba(255,90,95,0.2); color: #ff5a5f; }
.cd-banner-inline { margin: 8px 0 0; padding: 8px 12px; font-size: 11.5px; font-weight: 600; align-items: center; }
.cd-banner-title { margin: 0; font-size: 12px; font-weight: 750; }
.cd-banner-text { margin: 3px 0 0; font-size: 11.5px; font-weight: 500; color: var(--text-secondary); }
.cd-banner-actions { margin-top: 8px; display: flex; gap: 6px; }
.cd-body { flex: 1; overflow-y: auto; padding: 6px 26px 32px; }
.cd-section { padding: 18px 0; border-bottom: 1px solid var(--border-default); }
.cd-section:last-child { border-bottom: none; }
.cd-section-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 12px; }
.cd-section-title { font-size: 13px; font-weight: 750; color: var(--text-primary); margin: 0; display: flex; align-items: center; gap: 7px; }
.cd-count {
  font-size: 10px; font-weight: 700; color: var(--text-muted);
  background: var(--bg-inset); padding: 2px 8px; border-radius: 100px;
}
.cd-section-meta { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 600; color: var(--text-muted); }
.cd-tools { display: flex; flex-direction: column; gap: 8px; }
.cd-tool {
  display: flex; align-items: center; gap: 12px;
  padding: 11px 14px; border-radius: 14px;
  background: var(--card-bg); border: 1px solid var(--card-border);
  transition: all 200ms ease;
}
.cd-tool:hover { border-color: var(--border-strong); }
.cd-tool-main { flex: 1; min-width: 0; }
.cd-tool-name-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cd-tool-name {
  margin: 0; font-size: 12.5px; font-weight: 700; color: var(--text-primary);
  font-family: 'SF Mono', 'Fira Code', monospace;
}
.cd-tool-action {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 2px 8px; border-radius: 9999px;
}
.cd-tool-desc { margin: 3px 0 0; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.cd-tool-controls { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.cd-toggle {
  display: flex; gap: 2px; background: var(--bg-inset);
  padding: 3px; border-radius: 10px;
}
.cd-toggle-btn {
  padding: 4px 9px; font-size: 9.5px; font-weight: 800; text-transform: uppercase;
  letter-spacing: 0.03em; border: none; border-radius: 8px; cursor: pointer;
  background: transparent; color: var(--text-muted); transition: all 200ms ease;
}
.cd-toggle-btn:disabled { opacity: 0.5; cursor: wait; }
.cd-toggle-btn.active-allow { background: rgba(0,166,153,0.15); color: #00a699; }
.cd-toggle-btn.active-deny { background: rgba(255,90,95,0.15); color: #ff5a5f; }
.cd-toggle-btn.active-log { background: rgba(252,180,0,0.15); color: #b8860b; }
.cd-tool-edit {
  display: inline-flex; align-items: center; gap: 4px;
  border: none; cursor: pointer; background: transparent;
  color: var(--text-muted); font-size: 10px; font-weight: 700;
  padding: 4px 6px; border-radius: 8px; transition: all 200ms ease;
}
.cd-tool-edit:hover { color: var(--accent-coral); background: rgba(255,90,95,0.08); }
.cd-empty-tools {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 24px; text-align: center;
  color: var(--text-muted); font-size: 12px; font-weight: 500;
  border: 1px dashed var(--border-strong); border-radius: 14px;
}
.cd-agents { display: flex; flex-direction: column; gap: 8px; }

/* ───── Add to Agent Card (Redesigned Hero Style) ───── */
.cd-add-agent-card {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.01));
  border: 1.5px solid var(--border-default);
  border-radius: 18px;
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.04);
}

.cd-add-agent-header {
  display: flex;
  align-items: center;
  gap: 16px;
}

.cd-add-agent-icon-stage {
  width: 52px;
  height: 52px;
  border-radius: 14px;
  background: var(--bg-inset);
  border: 1.5px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.06);
}

.cd-add-agent-brand-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.cd-add-agent-brand-fallback {
  color: var(--accent-coral);
}

.cd-add-agent-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.cd-add-agent-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.cd-add-agent-name {
  font-size: 15px;
  font-weight: 750;
  color: var(--text-primary);
  margin: 0;
  letter-spacing: -0.01em;
}

.cd-add-agent-tag {
  font-size: 10px;
  font-weight: 750;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 999px;
  background: rgba(0, 166, 153, 0.12);
  color: #00a699;
}

.cd-add-agent-sub {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-muted);
  margin: 0;
  line-height: 1.4;
}

.cd-agent-path-code {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 11px;
  background: var(--bg-inset);
  padding: 2px 6px;
  border-radius: 5px;
  color: var(--text-secondary);
}

.cd-add-agent-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border-default);
  flex-wrap: wrap;
}

.cd-agent-picker-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cd-agent-picker-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
}

.cd-agent-select {
  height: 36px;
  font-size: 12px;
  font-weight: 600;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  color: var(--text-primary);
}

.cd-btn-install {
  height: 38px;
  padding: 0 20px;
  font-size: 12.5px;
  font-weight: 750;
  border-radius: 999px;
  margin-left: auto;
}

/* ───── Bound Agents List ───── */
.cd-bound-agents-container {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.cd-agent-bound-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 16px;
  border-radius: 14px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  transition: all 0.2s ease;
}

.cd-agent-bound-card:hover {
  border-color: var(--border-strong);
}

.cd-agent-bound-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.cd-agent-icon-box {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.cd-agent-bound-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
}

.cd-agent-bound-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.cd-agent-bound-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.cd-agent-bound-name {
  font-size: 13px;
  font-weight: 700;
  color: var(--text-primary);
}

.cd-agent-bound-path {
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
  font-family: 'SF Mono', 'Fira Code', monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 380px;
}

.cd-agent-routed-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10.5px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 999px;
  background: rgba(57, 126, 112, 0.12);
  color: var(--accent-teal);
}

.cd-badge-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent-teal);
  box-shadow: 0 0 6px var(--accent-teal);
}

.cd-btn-unbind {
  background: transparent;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 11px;
  font-weight: 650;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.18s ease;
}

.cd-btn-unbind:hover:not(:disabled) {
  color: var(--accent-coral);
  border-color: rgba(255, 49, 68, 0.35);
  background: rgba(255, 49, 68, 0.06);
}

.cd-add-more-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--bg-inset);
  font-size: 11.5px;
}

.cd-add-more-label {
  font-weight: 650;
  color: var(--text-secondary);
}

.cd-add-more-select {
  height: 32px;
  font-size: 11.5px;
  font-weight: 600;
  padding: 0 10px;
  border-radius: 8px;
  border: 1px solid var(--border-default);
  background: var(--card-bg);
  color: var(--text-primary);
}

.cd-note { font-size: 11.5px; font-weight: 500; color: var(--text-muted); margin: 0 0 10px; line-height: 1.5; }
.cd-oauth-actions { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; }
.cd-btn-oauth {
  align-self: flex-start; display: inline-flex; align-items: center; gap: 6px;
  font-size: 12px; font-weight: 750; padding: 8px 16px; border-radius: 9999px; border: none; cursor: pointer;
  background: linear-gradient(135deg, #5b8cff, #7a5bff); color: #fff;
  box-shadow: 0 2px 10px rgba(91,140,255,0.25);
}
.cd-btn-oauth:hover:not(:disabled) { transform: translateY(-1px); }
.cd-btn-oauth:disabled { opacity: 0.55; cursor: not-allowed; }
.cd-oauth-status {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 11px; font-weight: 650; margin-bottom: 10px; padding: 5px 10px; border-radius: 8px;
}
.cd-oauth-status.ok { color: #00a699; background: rgba(0,166,153,0.08); }
.cd-oauth-status.fail { color: #ff5a5f; background: rgba(255,90,95,0.08); }
.cd-discover-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cd-label-optional { font-weight: 500; color: var(--text-muted); }
.cd-code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 10.5px; background: var(--bg-inset); padding: 1px 5px; border-radius: 5px; }
.cd-auth-type { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 12px; }
.cd-auth-opt {
  padding: 6px 14px; border-radius: 9999px; cursor: pointer;
  font-size: 11.5px; font-weight: 700;
  background: var(--bg-inset); color: var(--text-muted);
  border: 1px solid transparent; transition: all 200ms ease;
}
.cd-auth-opt.active { background: rgba(255,90,95,0.1); color: var(--accent-coral); border-color: rgba(255,90,95,0.35); }
.cd-label {
  display: block; font-size: 10.5px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin: 10px 0 6px;
}
.cd-input { width: 100%; }
.cd-auth-foot { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.cd-auth-msg { font-size: 11.5px; font-weight: 600; }
.cd-auth-msg.ok { color: #00a699; }
.cd-auth-msg.fail { color: #ff5a5f; }
.cd-activity { display: flex; flex-direction: column; gap: 12px; }
.cd-activity-nums { display: flex; gap: 32px; }
.cd-activity-num { display: flex; flex-direction: column; gap: 2px; }
.cd-activity-value { font-size: 22px; font-weight: 800; letter-spacing: -0.02em; color: var(--text-primary); line-height: 1; }
.cd-activity-value.cd-blocked { color: #ff5a5f; }
.cd-activity-label { font-size: 10px; font-weight: 650; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }
.cd-spark {
  display: flex; align-items: flex-end; gap: 2px;
  height: 56px; padding: 6px;
  background: var(--bg-inset); border-radius: 12px;
}
.cd-spark-bar { flex: 1; border-radius: 2px 2px 0 0; min-width: 2px; transition: background 300ms ease; }
@keyframes cdSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.cd-spin { animation: cdSpin 1s linear infinite; }
/* Configuration section (General / Per-Agent tabs) */
.cd-tabs { display: inline-flex; gap: 2px; }
.cd-tab {
  padding: 5px 12px; font-size: 11px; font-weight: 700;
  background: transparent; color: var(--text-muted);
  border: none; border-bottom: 2px solid transparent;
  cursor: pointer; transition: all 150ms ease;
}
.cd-tab:hover { color: var(--text-primary); }
.cd-tab.active { color: var(--accent-coral); border-bottom-color: var(--accent-coral); }
.cd-config-grid {
  display: grid; grid-template-columns: 110px 1fr; gap: 10px 14px;
  align-items: baseline;
}
.cd-config-key {
  font-size: 10px; font-weight: 750; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
}
.cd-config-val { font-size: 12px; font-weight: 550; color: var(--text-primary); min-width: 0; word-break: break-all; }
.cd-config-mono { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; margin-left: 6px; }
.cd-config-dim { color: var(--text-muted); font-weight: 500; }
.cd-env-list { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
.cd-env-row { display: flex; align-items: center; gap: 8px; }
.cd-env-val { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px; color: var(--text-muted); word-break: break-all; }
.cd-config-loading { display: flex; align-items: center; gap: 8px; font-size: 12px; font-weight: 600; color: var(--text-muted); padding: 14px 0; }
.cd-agentcfg-list { display: flex; flex-direction: column; gap: 10px; }
.cd-agentcfg {
  padding: 12px 14px; border-radius: 14px;
  background: var(--card-bg); border: 1px solid var(--card-border);
}
.cd-agentcfg-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.cd-sync-badge {
  display: inline-flex; align-items: center; gap: 4px;
  font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 3px 9px; border-radius: 9999px; white-space: nowrap;
}
.cd-sync-badge.ok { color: #00a699; background: rgba(0,166,153,0.12); border: 1px solid rgba(0,166,153,0.25); }
.cd-sync-badge.warn { color: #b7791f; background: rgba(252,180,0,0.12); border: 1px solid rgba(252,180,0,0.35); }
.cd-agentcfg-path {
  margin: 4px 0 8px; font-size: 10px; font-weight: 550;
  font-family: 'SF Mono', 'Fira Code', monospace; color: var(--text-muted);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cd-agentcfg-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.cd-config-pre {
  margin: 4px 0 0; padding: 7px 9px; border-radius: 8px;
  background: var(--bg-inset); font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 10.5px; line-height: 1.5; color: var(--text-primary);
  white-space: pre-wrap; word-break: break-all;
}
.cd-agentcfg-env { margin: 8px 0 0; font-size: 10px; font-weight: 600; color: var(--text-muted); }
      `}</style>
  );

  if (embedded) {
    return (
      <div className="cd-page">
        {styles}
        {panel}
        {server && (
          <TestCallModal
            serverName={serverName}
            serverType={serverType}
            open={testOpen}
            onClose={() => setTestOpen(false)}
          />
        )}
      </div>
    );
  }

  return (
    <AnimatePresence>
      <motion.div
        key="cd-overlay"
        className="cd-overlay"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
      >
        {panel}
      </motion.div>

      {server && (
        <TestCallModal
          serverName={serverName}
          serverType={serverType}
          open={testOpen}
          onClose={() => setTestOpen(false)}
        />
      )}

      {styles}
    </AnimatePresence>
  );
}
