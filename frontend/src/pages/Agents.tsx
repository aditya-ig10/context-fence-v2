import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { loginWithGoogle, auth, hasFirebaseConfig } from '../lib/firebase';
import { setPersistence, browserLocalPersistence } from 'firebase/auth';
import { motion } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';
import { LOGOS } from '../lib/agentLogos';

// InsightHub-style Agents page (matches Dashboard):
//   slim header -> KPI row (orange -> teal -> white w/ progress)
//   -> editorial agent cards with light-weight stat figures.

interface AgentStats {
  sessions?: number;
  conversations?: number;
  messages?: number;
  steps?: number;
  tokensInput?: number;
  tokensOutput?: number;
  tokensTotal?: number;
  tokensReasoning?: number;
  cost?: number;
  models?: string[];
  installDate?: string;
  lastActive?: string;
  configFiles?: number;
  dotEnvReads?: number;
  proxyCalls?: number;
  proxyAllowed?: number;
  proxyBlocked?: number;
  proxyLogged?: number;
}

interface McpServerInfo {
  name: string;
  type: string;
  url?: string;
  command?: string;
}

interface DetectedAgent {
  id: string;
  name: string;
  type: string;
  configPath?: string;
  dataPath?: string;
  iconPath?: string;
  firstSeen: string;
  lastSeen: string;
  status: 'active' | 'inactive';
  stats?: AgentStats;
  mcpServers?: McpServerInfo[];
  mcpCount?: number;
  directoryContents?: string[];
  protected?: boolean;
  protectedAt?: string;
  backupPath?: string;
}

const AGENT_DESCRIPTIONS: Record<string, string> = {
  opencode: 'Open-source CLI agent for coding tasks',
  claude: 'Anthropic\u2019s AI assistant for desktop & terminal',
  cursor: 'AI-native code editor with MCP support',
  codex: 'Terminal AI agent by Open AI',
  copilot: 'GitHub\u2019s AI pair programmer',
  cline: 'Autonomous coding agent for VS Code',
  continue: 'Open-source AI code assistant',
  windsurf: 'Agentic IDE with deep context',
  aider: 'AI pair programming in the terminal',
  gemini: 'Google\u2019s Gemini CLI / Antigravity agent',
  antigravity: 'Google\u2019s Gemini CLI / Antigravity agent',
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function timeAgo(ts: string): string {
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1 },
};

export default function Agents() {
  const { user, mockSignIn } = useAuth();
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // C1: is the sequential-thinking MCP declared in any scanned config? When
  // it is missing AND opencode is actually in use (an opencode config exists),
  // surface a banner (reasoning quality may be reduced) with a confirmed
  // one-click injection into the opencode config. Users without opencode are
  // not nagged — the reasoning pipeline already falls back to local steps.
  const [reasoning, setReasoning] = useState<{ present: boolean; source: string | null } | null>(null);
  const [injecting, setInjecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/connectors/reasoning')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && typeof d?.present === 'boolean') setReasoning(d as { present: boolean; source: string | null }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  async function handleInject() {
    if (!window.confirm('Add the sequential-thinking MCP entry to your opencode config?\nContext Fence will write the entry and re-run discovery.')) return;
    setInjecting(true);
    try {
      const res = await fetch('/api/connectors/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'sequential-thinking' }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok) throw new Error(body?.error ?? `Injection failed (HTTP ${res.status})`);
      await fetch('/api/connectors/scan', { method: 'POST' }).catch(() => {});
      const check = (await fetch('/api/connectors/reasoning').catch(() => null)) as Response | null;
      if (check && check.ok) {
        const d = (await check.json()) as { present: boolean; source: string | null };
        setReasoning(d);
      }
      invalidateCache((k) => k === 'detect' || k === 'agents' || k === 'mcp-configs');
      refreshDetected();
      notify.success('sequential-thinking added', 'opencode config updated — discovery re-scanned');
    } catch (err) {
      notify.error('Injection failed', err instanceof Error ? err.message : String(err));
    } finally {
      setInjecting(false);
    }
  }

  const { data: detectedData, loading, refresh: refreshDetected } = useCachedFetch<{ agents: DetectedAgent[] }>('detect', () =>
    fetch('/api/detect').then((r) => r.json()),
  );
  const detected = detectedData?.agents ?? [];

  // Refresh (mirrors the Connectors page): full disk re-scan via
  // POST /api/connectors/scan, then re-fetch the detected-agents list so
  // freshly scanned agents render immediately. Same single-in-flight guard.
  const refreshingRef = useRef(false);
  async function handleRefresh() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const loadingId = notify.loading('Refreshing discovery…', 'Re-reading every agent config from disk');
    try {
      const res = await fetch('/api/connectors/scan', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error ?? `Discovery scan failed (HTTP ${res.status})`);
      }
      invalidateCache((k) => k === 'detect' || k === 'agents' || k === 'mcp-configs' || k === 'servers' || k.startsWith('server:'));
      await Promise.resolve(refreshDetected());
      notify.dismiss(loadingId);
      notify.success('Refreshed successfully', 'Every agent config was re-read from disk');
    } catch (err) {
      notify.dismiss(loadingId);
      notify.error('Refresh failed', err instanceof Error ? err.message : String(err));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }


  // Auto-arrange by most-recently-used: agents with a real lastActive (from
  // their stats) first, newest activity on top; agents with no activity sink
  // to the end. Fallback to lastSeen so freshly detected agents still sort.
  const detectedSorted = [...detected].sort((a, b) => {
    const ta = a.stats?.lastActive ? new Date(a.stats.lastActive).getTime() : a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
    const tb = b.stats?.lastActive ? new Date(b.stats.lastActive).getTime() : b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
    return tb - ta;
  });
  const protectedCount = detected.filter((a) => a.protected).length;

  async function handleSignIn() {
    localStorage.setItem('cf_onboarding_seen', 'true');
    localStorage.removeItem('cf_offline_mode');
    if (!hasFirebaseConfig) { mockSignIn(); return; }
    try {
      await setPersistence(auth!, browserLocalPersistence);
      await loginWithGoogle();
    } catch (err) {
      console.error('[Agents] Sign-in failed:', err);
    }
  }

  async function handleDelete(id: string) {
    const agent = detected.find((a) => a.id === id);
    await fetch(`/api/detect/${id}`, { method: 'DELETE' });
    setConfirmDelete(null);
    invalidateCache((k) => k === 'detect' || k === 'agents');
    refreshDetected();
    notify.success(`${agent?.name ?? 'Agent'} removed`, 'It will reappear if its config is detected again');
  }

  // KPI rollups — every figure is real data from /api/detect.
  const totalMcps = detected.reduce((sum, a) => sum + (a.mcpCount ?? 0), 0);
  const agentsCount = useCountUp(detected.length);
  const mcpsCount = useCountUp(totalMcps);
  const protectedAnim = useCountUp(protectedCount);
  const coveragePct = detected.length > 0 ? Math.round((protectedCount / detected.length) * 100) : 0;

  return (
    <div className="ag2-root">
      <header className="ag2-head">
        <div>
          <h1 className="ag2-heading">Agents</h1>
          <p className="ag2-subhead">Every AI agent on this machine, auto-detected from disk.</p>
        </div>
        <button className="ag2-refresh" type="button" onClick={handleRefresh} disabled={refreshing}
          title="Re-scan every agent config on disk (full disk read, no cache)">
          <RefreshCw size={14} className={refreshing ? 'ag2-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {!user && (
        <button type="button" onClick={handleSignIn} className="ag2-banner ag2-banner-local">
          <span className="ag2-banner-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </span>
          <span className="ag2-banner-text">
            <span className="ag2-banner-title">Local mode — sign in to sync agents, policies, and settings across devices.</span>
          </span>
          <span className="ag2-banner-cta">Sign In</span>
        </button>
      )}

      {reasoning && !reasoning.present && detected.some((a) => a.type === 'opencode') && (
        <div className="ag2-banner ag2-banner-reasoning">
          <span className="ag2-banner-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 3A2.5 2.5 0 0 1 12 5.5V21a2.5 2.5 0 0 1-2.5-2.5"/><path d="M14.5 3A2.5 2.5 0 0 0 12 5.5v6a2.5 2.5 0 0 0 2.5-2.5V5.5A2.5 2.5 0 0 0 12 3z"/><path d="M9.5 21a2.5 2.5 0 0 0 2.5-2.5"/></svg>
          </span>
          <span className="ag2-banner-text">
            <span className="ag2-banner-title">sequential-thinking MCP not found — reasoning quality may be reduced</span>
            <span className="ag2-banner-desc">Context Fence routes multi-step reasoning tasks through this MCP when it is configured in any scanned agent config.</span>
          </span>
          <button onClick={handleInject} disabled={injecting} className="ag2-banner-btn">
            {injecting ? 'Adding…' : 'Add to opencode'}
          </button>
        </div>
      )}

      {loading ? (
        <div className="ag2-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="ag2-card ag2-skeleton">
              <div className="ag2-skel-row">
                <div className="ag2-skel-logo" />
                <div className="ag2-skel-lines">
                  <div className="ag2-skel-line" style={{ width: '55%' }} />
                  <div className="ag2-skel-line" style={{ width: '80%' }} />
                </div>
              </div>
              <div className="ag2-skel-stats">
                <div className="ag2-skel-stat" /><div className="ag2-skel-stat" /><div className="ag2-skel-stat" />
              </div>
            </div>
          ))}
        </div>
      ) : detected.length === 0 ? (
        <div className="ag2-empty">
          <div className="ag2-empty-icon">
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </div>
          <p className="ag2-empty-title">No agents detected</p>
          <p className="ag2-empty-desc">Agents are auto-detected from their MCP configs on disk — hit Refresh to re-scan now.</p>
        </div>
      ) : (
        <>
          {/* KPI row: orange -> teal -> white (coverage w/ progress bar) */}
          <section className="ag2-kpis">
            <div className="ag2-card ag2-kpi ag2-kpi-orange">
              <p className="ag2-kpi-label">Agents<br />Detected</p>
              <p className="ag2-kpi-value">{formatNumber(agentsCount)}</p>
              <p className="ag2-kpi-sub">{protectedCount} protected through the proxy</p>
            </div>

            <div className="ag2-card ag2-kpi ag2-kpi-teal">
              <p className="ag2-kpi-label">MCP<br />Servers</p>
              <p className="ag2-kpi-value">{formatNumber(mcpsCount)}</p>
              <p className="ag2-kpi-sub">declared across all agents</p>
            </div>

            <div className="ag2-card ag2-kpi ag2-kpi-white">
              <p className="ag2-kpi-label">Proxy<br />Coverage</p>
              <p className="ag2-kpi-value">{protectedAnim}<span className="ag2-kpi-unit">/{detected.length}</span></p>
              <div className="ag2-meter" role="progressbar" aria-valuenow={coveragePct} aria-valuemin={0} aria-valuemax={100}>
                <div className="ag2-meter-fill" style={{ width: `${coveragePct}%` }} />
              </div>
              <p className="ag2-kpi-sub">agents routed through Context Fence</p>
            </div>
          </section>

          <motion.div
            className="ag2-grid"
            variants={containerVariants}
            initial="hidden"
            animate="visible"
          >
            {detectedSorted.map((agent) => {
              const logo = agent.iconPath || LOGOS[agent.type];
              const s = agent.stats;
              const serverSideMetered = agent.type === 'gemini' || agent.type === 'antigravity';

              // Editorial stat figures — most meaningful trio per agent.
              const figures: { label: string; value: string }[] = [];
              if (s) {
                if (s.sessions && s.sessions > 0) figures.push({ label: 'Sessions', value: formatNumber(s.sessions) });
                if (s.tokensTotal && s.tokensTotal > 0) figures.push({ label: 'Tokens', value: formatNumber(s.tokensTotal) });
                if (!serverSideMetered && s.models && s.models.length > 0) figures.push({ label: 'Models', value: String(s.models.length) });
                if (s.steps && s.steps > 0) figures.push({ label: 'Steps', value: formatNumber(s.steps) });
                if (s.conversations && s.conversations > 0) figures.push({ label: 'Chats', value: formatNumber(s.conversations) });
                if (s.messages && s.messages > 0) figures.push({ label: 'Messages', value: formatNumber(s.messages) });
                if (s.configFiles && s.configFiles > 0) figures.push({ label: 'Configs', value: String(s.configFiles) });
                if (s.dotEnvReads && s.dotEnvReads > 0) figures.push({ label: 'Env Reads', value: formatNumber(s.dotEnvReads) });
              }
              const shown = figures.slice(0, 3);

              return (
                <motion.div
                  key={agent.id}
                  variants={cardVariants}
                  className="ag2-card ag2-agent"
                  onClick={() => navigate(`/agents/${agent.type}`)}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); setConfirmDelete(confirmDelete === agent.id ? null : agent.id); }}
                    className="ag2-delete"
                    title="Remove agent"
                  >
                    {confirmDelete === agent.id ? (
                      <span className="ag2-delete-confirm" onClick={(e) => { e.stopPropagation(); handleDelete(agent.id); }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                      </span>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    )}
                  </button>

                  <div className="ag2-agent-top">
                    <div className="ag2-logo">
                      {logo ? (
                        <img src={logo} alt={agent.name} referrerPolicy="no-referrer" className="ag2-logo-img" />
                      ) : (
                        <span className="ag2-logo-fallback">{(agent.name.charAt(0) || '?').toUpperCase()}</span>
                      )}
                    </div>
                    <div className="ag2-agent-id">
                      <p className="ag2-agent-name">
                        {agent.name}
                        {serverSideMetered && (
                          <span className="ag2-ss" title="* Token & cost usage is metered server-side by Google — only sessions/steps are stored locally.">*</span>
                        )}
                      </p>
                      <p className="ag2-agent-desc">{AGENT_DESCRIPTIONS[agent.type] || agent.type}</p>
                    </div>
                    {agent.protected ? (
                      <span className="ag2-state ag2-state-on" title={`Config rewired to the proxy since ${agent.protectedAt}. Backup: ${agent.backupPath}`}>
                        <span className="ag2-state-dot" />
                        Protected
                      </span>
                    ) : (
                      <span className="ag2-state ag2-state-off" title="Detected only — this agent's real MCP traffic still bypasses Context Fence. Protect it from its detail page.">
                        <span className="ag2-state-dot" />
                        Detected only
                      </span>
                    )}
                  </div>

                  {shown.length > 0 ? (
                    <div className="ag2-figure-row">
                      {shown.map((f) => (
                        <div key={f.label} className="ag2-figure">
                          <p className="ag2-figure-value">{f.value}</p>
                          <p className="ag2-figure-label">{f.label}</p>
                        </div>
                      ))}
                      {figures.length > 3 && (
                        <div className="ag2-figure">
                          <p className="ag2-figure-value">+{figures.length - 3}</p>
                          <p className="ag2-figure-label">More</p>
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="ag2-figure-row ag2-figure-row--empty">
                      <p className="ag2-nostats">No usage recorded yet</p>
                    </div>
                  )}

                  <div className="ag2-agent-foot">
                    <span className="ag2-seen">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      Active {timeAgo(agent.stats?.lastActive ?? agent.lastSeen)}
                    </span>
                    <span className="ag2-view">
                      View Info
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>
                    </span>
                  </div>
                </motion.div>
              );
            })}
          </motion.div>
        </>
      )}

      <style>{`
.ag2-root { position: relative; display: flex; flex-direction: column; gap: 18px; }
/* Ambient background glow — sits behind every card, never intercepts input */
.ag2-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.ag2-root > * { position: relative; z-index: 1; }
:root[data-theme="dark"] .ag2-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ag2-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
  }
}

@keyframes ag2spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Slim header */
.ag2-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.ag2-heading { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.ag2-subhead { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.ag2-refresh {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px;
  border-radius: 999px; border: none; cursor: pointer; font: inherit;
  background: var(--bg-inset); color: var(--text-secondary); font-size: 12.5px; font-weight: 650;
  transition: background 160ms ease, color 160ms ease;
}
.ag2-refresh:hover { background: #e9ebec; color: var(--text-primary); }
.ag2-refresh:disabled { cursor: progress; }
.ag2-spin { animation: ag2spin 1s linear infinite; }

/* Banners */
.ag2-banner {
  display: flex; align-items: center; gap: 14px;
  padding: 14px 18px; border-radius: 18px;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  text-align: left;
}
button.ag2-banner { cursor: pointer; font: inherit; width: 100%; transition: border-color 160ms ease; }
button.ag2-banner:hover { border-color: rgba(252, 180, 0, 0.45); }
.ag2-banner-local .ag2-banner-icon { background: rgba(252,180,0,0.14); color: #b7791f; }
.ag2-banner-reasoning { border-color: rgba(91,140,255,0.28); }
.ag2-banner-reasoning .ag2-banner-icon { background: rgba(91,140,255,0.14); color: #4c6fce; }
.ag2-banner-icon {
  width: 34px; height: 34px; border-radius: 11px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
}
.ag2-banner-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.ag2-banner-title { font-size: 13px; font-weight: 650; color: var(--text-primary); }
.ag2-banner-desc { font-size: 12px; font-weight: 500; color: var(--text-muted); }
.ag2-banner-cta {
  flex-shrink: 0; font-size: 12.5px; font-weight: 650; color: #ffffff;
  background: #111111; padding: 9px 18px; border-radius: 999px;
  transition: opacity 160ms ease;
}
button.ag2-banner:hover .ag2-banner-cta { opacity: 0.85; }
.ag2-banner-btn {
  flex-shrink: 0; font-family: inherit; cursor: pointer;
  font-size: 12.5px; font-weight: 650; color: #ffffff;
  background: #111111; border: none; padding: 9px 18px; border-radius: 999px;
  transition: opacity 160ms ease;
}
.ag2-banner-btn:hover:not(:disabled) { opacity: 0.85; }
.ag2-banner-btn:disabled { opacity: 0.55; cursor: not-allowed; }

/* Cards */
.ag2-card {
  position: relative;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 26px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}

/* KPI row */
.ag2-kpis { display: grid; gap: 18px; grid-template-columns: 1fr 1fr 1fr; }
@media (max-width: 900px) { .ag2-kpis { grid-template-columns: 1fr; } }
.ag2-kpi { display: flex; flex-direction: column; justify-content: space-between; min-height: 190px; padding: 26px 28px; }
.ag2-kpi-label {
  font-size: clamp(19px, 1.7vw, 23px); font-weight: 400;
  letter-spacing: -0.02em; line-height: 1.16;
  margin: 0; opacity: 0.96;
}
.ag2-kpi-value {
  font-size: clamp(38px, 3.8vw, 48px); font-weight: 400;
  letter-spacing: -0.03em; line-height: 1.02; margin: 0;
  font-variant-numeric: tabular-nums;
}
.ag2-kpi-sub { font-size: 12.5px; font-weight: 550; margin: 6px 0 0; opacity: 0.78; }
.ag2-kpi-orange { background: linear-gradient(160deg, #ff5163, #ff3144); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(255,49,68,0.28); }
.ag2-kpi-teal   { background: linear-gradient(160deg, #43907f, #397e70); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(57,126,112,0.26); }
.ag2-kpi-white .ag2-kpi-label { color: var(--text-muted); }
.ag2-kpi-white .ag2-kpi-value { color: var(--text-primary); }
.ag2-kpi-white .ag2-kpi-sub { color: var(--text-secondary); opacity: 1; }
.ag2-kpi-unit { font-size: 0.45em; font-weight: 450; color: var(--text-muted); letter-spacing: -0.01em; margin-left: 2px; }
.ag2-meter { height: 6px; border-radius: 999px; background: var(--bg-inset); overflow: hidden; margin-top: 14px; }
.ag2-meter-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--accent-teal), #2fe6b0); transition: width 700ms cubic-bezier(0.22,1,0.36,1); }

/* Agent grid */
.ag2-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(380px, 1fr)); }
@media (max-width: 900px) { .ag2-grid { grid-template-columns: 1fr; } }

.ag2-agent { padding: 24px 26px 0; cursor: pointer; overflow: hidden; display: flex; flex-direction: column; transition: all 300ms cubic-bezier(0.22,1,0.36,1); }
.ag2-agent:hover { transform: translateY(-3px); border-color: rgba(255,49,68,0.22); box-shadow: 0 16px 44px rgba(16,24,32,0.09); }

.ag2-delete {
  position: absolute; top: 14px; right: 14px; z-index: 2;
  width: 28px; height: 28px; border-radius: 9px;
  border: 1px solid var(--border-default); background: var(--bg-surface);
  color: var(--text-muted); cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0; transition: all 0.2s;
}
.ag2-agent:hover .ag2-delete { opacity: 1; }
.ag2-delete:hover { border-color: rgba(255,49,68,0.35); color: var(--accent-coral); background: rgba(255,49,68,0.06); }
.ag2-delete-confirm { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--accent-teal); }

.ag2-agent-top { display: flex; align-items: center; gap: 16px; }
.ag2-logo {
  width: 58px; height: 58px; border-radius: 17px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-inset); border: 1px solid var(--border-default);
}
.ag2-logo-img { width: 34px; height: 34px; object-fit: contain; }
.ag2-logo-fallback { font-size: 20px; font-weight: 650; color: var(--text-muted); }
.ag2-agent-id { flex: 1; min-width: 0; }
.ag2-agent-name { font-size: 16.5px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ag2-ss { color: var(--accent-coral); font-weight: 700; margin-left: 2px; cursor: help; }
.ag2-agent-desc { font-size: 12px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.ag2-state {
  display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0;
  padding: 5px 11px; border-radius: 999px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
}
.ag2-state-dot { width: 6px; height: 6px; border-radius: 50%; }
.ag2-state-on { background: rgba(57,126,112,0.1); color: #2f6d60; border: 1px solid rgba(57,126,112,0.25); }
.ag2-state-on .ag2-state-dot { background: var(--accent-teal); box-shadow: 0 0 6px rgba(47,230,176,0.7); }
.ag2-state-off { background: rgba(252,180,0,0.09); color: #a1741f; border: 1px solid rgba(222,145,29,0.28); }
.ag2-state-off .ag2-state-dot { background: var(--accent-amber); }

.ag2-figure-row {
  flex: 1;
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px;
  margin-top: 22px; padding-top: 20px;
  border-top: 1px solid var(--border-default);
  align-content: start;
}
.ag2-figure-row--empty { grid-template-columns: 1fr; }
.ag2-figure-value {
  font-size: 24px; font-weight: 400; letter-spacing: -0.02em;
  color: var(--text-primary); margin: 0; line-height: 1.05;
  font-variant-numeric: tabular-nums;
}
.ag2-figure-label {
  font-size: 10px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-muted); margin: 4px 0 0;
}
.ag2-nostats { font-size: 12px; font-weight: 550; color: var(--text-muted); margin: 0; font-style: italic; }

.ag2-agent-foot {
  display: flex; align-items: center; justify-content: space-between;
  margin: 20px -26px 0; padding: 13px 26px;
  border-top: 1px solid var(--border-default);
  background: var(--bg-inset);
  border-radius: 0 0 26px 26px;
  flex-shrink: 0;
}
.ag2-seen { display: flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; color: var(--text-muted); }
.ag2-view {
  display: flex; align-items: center; gap: 5px;
  font-size: 11.5px; font-weight: 700; color: var(--accent-coral);
  opacity: 0; transform: translateX(-4px); transition: all 220ms cubic-bezier(0.22,1,0.36,1);
}
.ag2-agent:hover .ag2-view { opacity: 1; transform: translateX(0); }

/* Empty state */
.ag2-empty {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; padding: 72px 24px;
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px; text-align: center;
}
.ag2-empty-icon {
  width: 56px; height: 56px; border-radius: 17px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-muted); margin-bottom: 18px;
}
.ag2-empty-title { font-size: 17px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.ag2-empty-desc { font-size: 13px; font-weight: 500; color: var(--text-muted); margin: 6px 0 0; max-width: 30em; line-height: 1.55; }

/* Skeleton loading */
.ag2-skeleton { min-height: 208px; display: flex; flex-direction: column; gap: 22px; }
.ag2-skel-row { display: flex; align-items: center; gap: 16px; }
.ag2-skel-logo { width: 58px; height: 58px; border-radius: 17px; background: var(--bg-inset); flex-shrink: 0; }
.ag2-skel-lines { flex: 1; display: flex; flex-direction: column; gap: 9px; }
.ag2-skel-line { height: 11px; border-radius: 6px; background: var(--bg-inset); }
.ag2-skel-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; padding-top: 20px; border-top: 1px solid var(--border-default); }
.ag2-skel-stat { height: 34px; border-radius: 8px; background: var(--bg-inset); }

/* ── Dark mode ──────────────────────────────────────────────────────────────*/
:root[data-theme="dark"] .ag2-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .ag2-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
:root[data-theme="dark"] .ag2-kpi-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
:root[data-theme="dark"] .ag2-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
:root[data-theme="dark"] .ag2-refresh:hover { background: #232b38; }
:root[data-theme="dark"] .ag2-agent:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .ag2-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
:root[data-theme="dark"] .ag2-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
:root[data-theme="dark"] .ag2-banner-cta, :root[data-theme="dark"] .ag2-banner-btn { background: #f2f5f9; color: #0a0d13; }
:root[data-theme="dark"] button.ag2-banner:hover { border-color: rgba(255,176,32,0.4); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ag2-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .ag2-kpi-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
  :root:not([data-theme]) .ag2-kpi-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
  :root:not([data-theme]) .ag2-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
  :root:not([data-theme]) .ag2-refresh:hover { background: #232b38; }
  :root:not([data-theme]) .ag2-agent:hover { border-color: rgba(255,73,94,0.35); box-shadow: 0 0 0 1px rgba(255,73,94,0.08), 0 16px 44px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .ag2-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
  :root:not([data-theme]) .ag2-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
  :root:not([data-theme]) .ag2-banner-cta, :root:not([data-theme]) .ag2-banner-btn { background: #f2f5f9; color: #0a0d13; }
}
      `}</style>
    </div>
  );
}
