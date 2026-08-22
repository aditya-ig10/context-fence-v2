import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import { useCachedFetch } from '../hooks/useCachedFetch';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';
import {
  BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from 'recharts';
import { LOGOS } from '../lib/agentLogos';

// InsightHub-style AgentDetail — full structural rebuild (mirrors Dashboard):
//   hero row (identity + protect CTA)
//   -> KPI band (orange -> teal -> white tiles, count-up)
//   -> 2fr/1fr main split: big Activity chart | Protection dial + Lifecycle rail
//   -> bottom triptych: token split | model mix | MCP servers
//   -> slim paths strip.

interface DailyUsage {
  day: string;
  tokens: number;
  input?: number;
  output?: number;
}

interface HourlyUsage {
  hour: number;
  tokens: number;
}

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
  modelUsage?: { model: string; tokens: number; sessions: number }[];
  installDate?: string;
  lastActive?: string;
  configFiles?: number;
  dotEnvReads?: number;
  dailyUsage?: DailyUsage[];
  last24h?: HourlyUsage[];
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
  backupExists?: boolean;
}

const CHART_COLORS = ['#ff3144', '#397e70', '#de911d', '#6366f1', '#7c3aed', '#f97316', '#06b6d4', '#22c55e'];

// Card pop-in — same stagger language as the Agents page and Dashboard.
const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
};

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
  if (!Number.isFinite(n)) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function timeAgo(ts: string): string {
  const secs = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatDate(ts: string): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// One animated KPI tile — own component so the count-up hook is legal here.
function StatTile({ label, value, variant }: { label: string; value: number; variant: 'orange' | 'teal' | 'white' }) {
  const n = useCountUp(value);
  const cls = variant === 'orange' ? ' ad-tile-orange' : variant === 'teal' ? ' ad-tile-teal' : '';
  return (
    <motion.div className={`ad-card ad-tile${cls}`} variants={cardVariants}>
      <p className="ad-tile-label">{label}</p>
      <p className="ad-tile-value">{formatNumber(n)}</p>
    </motion.div>
  );
}

// Protection status dial: full teal ring when protected, a small amber
// sliver when not — the firewall state readable at a glance.
function StatusDial({ on }: { on: boolean }) {
  const r = 33;
  const c = 2 * Math.PI * r;
  const frac = on ? 1 : 0.1;
  const color = on ? 'var(--accent-teal)' : 'var(--accent-amber)';
  return (
    <div className="ad-dial" data-on={on}>
      <svg width="86" height="86" viewBox="0 0 86 86">
        <circle cx="43" cy="43" r={r} fill="none" stroke="var(--bg-inset)" strokeWidth="7" />
        <circle
          cx="43" cy="43" r={r} fill="none"
          stroke={color} strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${c * frac} ${c}`}
          transform="rotate(-90 43 43)"
          style={{ transition: 'stroke-dasharray 700ms cubic-bezier(0.22,1,0.36,1), stroke 300ms ease' }}
        />
      </svg>
      <span className="ad-dial-icon" style={{ color }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          {on
            ? <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
            : <><path d="M19.69 14a6.9 6.9 0 0 0 .31-2V5l-8-3-3.16 1.18M4.73 4.73L4 5v7c0 6 8 10 8 10a20.3 20.3 0 0 0 5.62-4.38"/><line x1="1" y1="1" x2="23" y2="23"/></>}
        </svg>
      </span>
    </div>
  );
}

function DetailTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="ad-tooltip">
      {label !== undefined && <p className="ad-tooltip-label">{label}</p>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="ad-tooltip-row">
          <span className="ad-tooltip-dot" style={{ background: p.color || p.stroke }} />
          <span className="ad-tooltip-name">{p.name}</span>
          <span className="ad-tooltip-val">{formatNumber(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

export default function AgentDetail() {
  const { type } = useParams<{ type: string }>();
  const navigate = useNavigate();
  const [period, setPeriod] = useState<'today' | '7d' | '90d'>('7d');
  const [protectionBusy, setProtectionBusy] = useState(false);
  const [protectionError, setProtectionError] = useState<string | null>(null);
  const [protectionResult, setProtectionResult] = useState<string | null>(null);
  const [noMcpModal, setNoMcpModal] = useState(false);

  const { data: agentData, loading, refresh: refreshAgent } = useCachedFetch<{ agent: DetectedAgent | null }>(`detect:${type ?? ''}`, () =>
    type ? fetch(`/api/detect/${type}`).then((r) => r.json()) : Promise.resolve({ agent: null }),
  );
  const agent = agentData?.agent ?? null;

  const noMcpsDetected = !!agent && (agent.mcpCount === 0 || (agent.mcpServers !== undefined && agent.mcpServers.length === 0));

  async function handleProtectToggle() {
    if (!type || protectionBusy) return;
    setProtectionBusy(true);
    setProtectionError(null);
    setProtectionResult(null);
    try {
      // Nothing to protect — surface the "install an MCP first" popup instead
      // of an error string. (Local gate: detected config has no MCP entries.)
      if (!agent?.protected && noMcpsDetected) {
        setNoMcpModal(true);
        return;
      }
      const action = agent?.protected ? 'unprotect' : 'protect';
      const url = agent?.protected
        ? `/api/protect/${type}/unprotect`
        : `/api/protect/${type}`;
      const r = await fetch(url, { method: 'POST' });
      const body = await r.json();
      if (!r.ok || !body.ok) {
        throw new Error(body.error || `HTTP ${r.status}`);
      }
      setProtectionResult(
        action === 'protect'
          ? `Protected — MCP servers now route through the proxy. Backup saved to ${body.backupPath}`
          : 'Restored — original config recovered from backup',
      );
      if (action === 'protect') {
        notify.success(`${agent?.name ?? 'Agent'} protected`, 'MCP traffic now routes through the proxy');
      } else {
        notify.success('Config restored', `${agent?.name ?? 'Agent'}'s original config was recovered from backup`);
      }
      refreshAgent();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Backend gate (e.g. Windows configs the detector parsed differently):
      // a "no MCP servers" failure means the user must install an MCP first.
      if (/no .* mcp servers found|nothing to protect/i.test(msg)) {
        setNoMcpModal(true);
      } else {
        setProtectionError(msg);
        notify.error('Protection failed', msg);
      }
    } finally {
      setProtectionBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="ad-root">
        <button onClick={() => navigate('/agents')} className="ad-back">← Agents</button>
        <div className="ad-skel-hero">
          <div className="ad-skel-logo" />
          <div className="ad-skel-lines">
            <div className="ad-skel-line" style={{ width: '26%' }} />
            <div className="ad-skel-line" style={{ width: '16%' }} />
          </div>
        </div>
        <div className="ad-band">
          {Array.from({ length: 4 }).map((_, i) => (<div key={i} className="ad-card ad-skel-tile" />))}
        </div>
        <div className="ad-main">
          <div className="ad-card ad-skel-canvas" />
          <div className="ad-rail">
            <div className="ad-card ad-skel-tile" />
            <div className="ad-card ad-skel-tile" />
          </div>
        </div>
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="ad-root">
        <button onClick={() => navigate('/agents')} className="ad-back">← Agents</button>
        <div className="ad-card ad-missing">Agent not found</div>
      </div>
    );
  }

  const s = agent.stats;
  const logo = agent.iconPath || LOGOS[agent.type];

  // Server-side-metered agents (Gemini CLI / agy): tokens & cost never touch
  // the local disk — show what IS available and footnote the rest.
  const serverSideMetered = agent.type === 'gemini' || agent.type === 'antigravity';

  // KPI tiles in dashboard rhythm: first orange, second teal, rest white.
  type Tile = { label: string; value: number };
  const tiles: Tile[] = [];
  if (s) {
    if (s.sessions) tiles.push({ label: 'Sessions', value: s.sessions });
    if (s.tokensTotal) tiles.push({ label: 'Total Tokens', value: s.tokensTotal });
    if (s.messages) tiles.push({ label: 'Messages', value: s.messages });
    if (s.steps) tiles.push({ label: 'Steps', value: s.steps });
    if (s.conversations) tiles.push({ label: 'Conversations', value: s.conversations });
    if (s.dotEnvReads !== undefined && s.dotEnvReads > 0) tiles.push({ label: '.env Reads', value: s.dotEnvReads });
    if (agent.mcpCount !== undefined) tiles.push({ label: 'MCP Servers', value: agent.mcpCount });
  }
  const shownTiles = tiles.slice(0, 4);
  function tileVariant(i: number): 'orange' | 'teal' | 'white' {
    if (i === 0) return 'orange';
    if (i === 1) return 'teal';
    return 'white';
  }

  const tokenChartData: { name: string; tokens: number }[] = [];
  if (s?.tokensInput || s?.tokensOutput || s?.tokensReasoning) {
    if (s.tokensInput) tokenChartData.push({ name: 'Input', tokens: s.tokensInput });
    if (s.tokensOutput) tokenChartData.push({ name: 'Output', tokens: s.tokensOutput });
    if (s.tokensReasoning) tokenChartData.push({ name: 'Reasoning', tokens: s.tokensReasoning });
  }

  const modelChartData: { name: string; value: number }[] = [];
  // Real per-model weighting from the backend parser (tokens per model).
  // The chart is only rendered when real weighted data exists — no
  // fabricated proportions are ever plotted.
  if (s?.modelUsage && s.modelUsage.length > 0) {
    s.modelUsage.forEach((m) => {
      const short = m.model.split('/').pop() || m.model;
      modelChartData.push({
        name: short.length > 14 ? short.slice(0, 14) + '…' : short,
        value: Math.max(1, m.tokens),
      });
    });
  }

  const periodDays: Record<string, number> = { 'today': 1, '7d': 7, '90d': 90 };

  function dayLabel(d: Date, p: string): string {
    if (p === '7d') return d.toLocaleDateString('en-US', { weekday: 'short' });
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  const usageData: { day: string; tokens: number }[] = [];
  if (period === 'today' && s?.last24h) {
    for (const slot of s.last24h) {
      usageData.push({
        day: `${slot.hour.toString().padStart(2, '0')}:00`,
        tokens: slot.tokens,
      });
    }
  } else if (s?.dailyUsage && s.dailyUsage.length > 0) {
    const cutoff = Date.now() - (periodDays[period] || 7) * 86400000;
    const filtered = s.dailyUsage.filter(d => new Date(d.day).getTime() >= cutoff);
    usageData.push(...filtered.map(d => ({
      day: dayLabel(new Date(d.day), period),
      tokens: d.tokens,
    })));
  }
  const hasUsage = period === 'today' ? usageData.length > 0 : usageData.some(d => d.tokens > 0);
  const hasUsageSeries = !!(s?.dailyUsage?.length || s?.last24h?.length);

  const hasMcps = !!agent.mcpServers && agent.mcpServers.length > 0;
  const bottomCount = (tokenChartData.length > 0 ? 1 : 0) + (modelChartData.length > 0 ? 1 : 0) + (hasMcps ? 1 : 0);

  return (
    <motion.div
      className="ad-root"
      variants={containerVariants}
      initial="hidden"
      animate="visible"
    >
      <button onClick={() => navigate('/agents')} className="ad-back">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
        Agents
      </button>

      {/* Hero row: identity left, primary action right */}
      <motion.header className="ad-hero" variants={cardVariants}>
        <div className="ad-hero-logo">
          {logo ? (
            <img src={logo} alt={agent.name} referrerPolicy="no-referrer" />
          ) : (
            <span>{(agent.name.charAt(0) || '?').toUpperCase()}</span>
          )}
        </div>
        <div className="ad-hero-id">
          <div className="ad-hero-name-row">
            <h1 className="ad-hero-name">{agent.name}</h1>
            {agent.protected ? (
              <span className="ad-state ad-state-on" title={`Rewired to the proxy since ${agent.protectedAt}`}>
                <span className="ad-state-dot" />
                Protected
              </span>
            ) : (
              <span className="ad-state ad-state-off" title="Agent is visible to Context Fence but its real MCP traffic still bypasses the proxy entirely.">
                <span className="ad-state-dot" />
                Not protected
              </span>
            )}
          </div>
          <p className="ad-hero-type">{AGENT_DESCRIPTIONS[agent.type] || agent.type} · <span className="ad-hero-mono">{agent.type}</span></p>
        </div>
      </motion.header>

      {/* KPI band — orange -> teal -> white rhythm, count-up figures */}
      {shownTiles.length > 0 && (
        <section className="ad-band">
          {shownTiles.map((t, i) => (
            <StatTile key={t.label} label={t.label} value={t.value} variant={tileVariant(i)} />
          ))}
        </section>
      )}

      {serverSideMetered && (
        <p className="ad-footnote">
          * Tokens &amp; cost are metered server-side by Google — only sessions, steps and activity timestamps are stored on this machine.
        </p>
      )}

      {/* Main split: big activity canvas | protection + lifecycle rail */}
      <section className="ad-main">
        <div className="ad-card ad-activity">
          <div className="ad-card-head">
            <div>
              <h3 className="ad-h3">{serverSideMetered ? 'Activity*' : 'Activity'}</h3>
              <p className="ad-h3-sub">{serverSideMetered ? 'Steps per day — labelled as steps, not tokens' : 'Tokens over time'}</p>
            </div>
            <div className="ad-range">
              {(['today', '7d', '90d'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`ad-range-btn ${period === p ? 'active' : ''}`}
                >{p === 'today' ? 'Today' : p === '7d' ? '7 Days' : '90 Days'}</button>
              ))}
            </div>
          </div>
          {hasUsage ? (
            <div className="ad-chart-body">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={usageData} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
                  <defs>
                    <linearGradient id="adFillTokens" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff3144" stopOpacity={0.16} />
                      <stop offset="95%" stopColor="#ff3144" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#999999' }}
                    minTickGap={period === 'today' ? 20 : 40}
                    interval={period === 'today' ? 0 : 'preserveStartEnd'}
                  />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: '#999999' }}
                    tickFormatter={(v: number) => formatNumber(v)}
                    width={56}
                  />
                  <Tooltip content={<DetailTooltip />} cursor={{ stroke: '#b9bfc5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                  <Area
                    type="monotone"
                    dataKey="tokens"
                    name={serverSideMetered ? 'Steps*' : 'Tokens'}
                    stroke="#ff3144"
                    strokeWidth={2.4}
                    fill="url(#adFillTokens)"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }}
                    isAnimationActive
                    animationBegin={180}
                    animationDuration={700}
                    animationEasing="ease-out"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="ad-noactivity">
              <p className="ad-noactivity-title">{hasUsageSeries ? 'No activity in this period' : 'No activity recorded yet'}</p>
              <p className="ad-noactivity-sub">Usage appears once this agent runs through a tracked period.</p>
            </div>
          )}
        </div>

        <div className="ad-rail">
          {/* Protection card */}
          <div className={`ad-card ad-prot-card${agent.protected ? ' ad-prot-card--on' : ''}`}>
            <p className="ad-microlabel">Proxy Protection</p>
            <div className="ad-prot-body">
              <StatusDial on={!!agent.protected} />
              <div className="ad-prot-copy">
                <p className="ad-prot-state">{agent.protected ? 'Routed through the firewall' : 'Bypassing the firewall'}</p>
                <p className="ad-prot-desc">
                  {agent.protected
                    ? 'MCP config is rewired to the proxy — every call is policy-checked and audited.'
                    : 'This agent\u2019s real MCP traffic never touches Context Fence.'}
                </p>
              </div>
            </div>
            {agent.configPath && (!agent.protected || agent.backupExists) && (
              <button
                onClick={handleProtectToggle}
                disabled={protectionBusy}
                className={`ad-protect-btn ${agent.protected ? 'ad-protect-btn--restore' : 'ad-protect-btn--protect'}`}
              >
                {protectionBusy ? 'Working…' : agent.protected ? 'Restore original config' : 'Protect this agent'}
              </button>
            )}
            {agent.protected && !agent.backupExists && (
              <p className="ad-warn">Backup file is missing on disk — restoring byte-for-byte is not possible.</p>
            )}
            {protectionError && <p className="ad-fail">Failed: {protectionError}</p>}
            {protectionResult && <p className="ad-ok">{protectionResult}</p>}
          </div>

          {/* Lifecycle card */}
          <div className="ad-card ad-life">
            <p className="ad-microlabel">Lifecycle</p>
            <div className="ad-life-rows">
              {s?.installDate && (
                <div className="ad-life-row">
                  <span className="ad-life-key">Installed</span>
                  <span className="ad-life-val">{formatDate(s.installDate)}</span>
                </div>
              )}
              {s?.lastActive && (
                <div className="ad-life-row">
                  <span className="ad-life-key">Last active</span>
                  <span className="ad-life-val" title={formatDate(s.lastActive)}>{timeAgo(s.lastActive)}</span>
                </div>
              )}
              <div className="ad-life-row">
                <span className="ad-life-key">First seen</span>
                <span className="ad-life-val">{timeAgo(agent.firstSeen)}</span>
              </div>
              {s?.models && s.models.length > 0 && (
                <div className="ad-life-row">
                  <span className="ad-life-key">Model{s.models.length === 1 ? '' : 's'}</span>
                  <span className="ad-life-val" title={s.models.join(', ')}>
                    {s.models.length === 1 ? (s.models[0].length > 26 ? s.models[0].slice(0, 26) + '…' : s.models[0]) : `${s.models.length} tracked`}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* Bottom triptych: token split | model mix | MCP servers */}
      {bottomCount > 0 && (
        <section className={`ad-bottom${bottomCount === 1 ? ' ad-bottom--one' : ''}`}>
          {tokenChartData.length > 0 && (
            <div className="ad-card">
              <div className="ad-card-head">
                <div>
                  <h3 className="ad-h3">Token Split</h3>
                  <p className="ad-h3-sub">Input vs output vs reasoning</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={228}>
                <BarChart data={tokenChartData} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
                  <defs>
                    {CHART_COLORS.map((c, i) => (
                      <linearGradient key={i} id={`adCellGrad${i}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={c} stopOpacity={1} />
                        <stop offset="100%" stopColor={c} stopOpacity={0.25} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} tickFormatter={(v: number) => formatNumber(v)} width={56} />
                  <Tooltip content={<DetailTooltip />} cursor={{ fill: 'rgba(17,17,17,0.03)' }} />
                  <Bar dataKey="tokens" name="Tokens" radius={[6, 6, 0, 0]} isAnimationActive animationDuration={700} animationEasing="ease-out">
                    {tokenChartData.map((_, i) => (
                      <Cell key={i} fill={`url(#adCellGrad${i % CHART_COLORS.length})`} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {modelChartData.length > 0 && (
            <div className="ad-card">
              <div className="ad-card-head">
                <div>
                  <h3 className="ad-h3">Model Mix</h3>
                  <p className="ad-h3-sub">Tokens per model</p>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={228}>
                <BarChart data={modelChartData} layout="vertical" margin={{ top: 4, right: 18, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" horizontal={false} />
                  <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} tickFormatter={(v: number) => formatNumber(v)} />
                  <YAxis type="category" dataKey="name" width={112} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: 'var(--text-secondary)' }} />
                  <Tooltip content={<DetailTooltip />} cursor={{ fill: 'rgba(17,17,17,0.03)' }} />
                  <Bar dataKey="value" name="Tokens" radius={[0, 6, 6, 0]} isAnimationActive animationDuration={700} animationEasing="ease-out">
                    {modelChartData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {hasMcps && (
            <div className="ad-card">
              <div className="ad-card-head">
                <div>
                  <h3 className="ad-h3">MCP Servers</h3>
                  <p className="ad-h3-sub">{agent.mcpCount ?? agent.mcpServers!.length} declared in this agent&apos;s config</p>
                </div>
              </div>
              <div className="ad-mcps">
                {agent.mcpServers!.map((mcp) => (
                  <div key={mcp.name} className="ad-mcp-row">
                    <div className="ad-mcp-id">
                      <p className="ad-mcp-name">{mcp.name}</p>
                      <p className="ad-mcp-type">{mcp.type}</p>
                    </div>
                    <span className="ad-mcp-target">{mcp.url || mcp.command || ''}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {/* Slim paths strip */}
      {(agent.configPath || agent.dataPath) && (
        <section className="ad-card ad-paths">
          {agent.configPath && (
            <div className="ad-path-cell">
              <p className="ad-microlabel">Config Path</p>
              <p className="ad-path">{agent.configPath}</p>
            </div>
          )}
          {agent.dataPath && (
            <div className="ad-path-cell">
              <p className="ad-microlabel">Data Path</p>
              <p className="ad-path">{agent.dataPath}</p>
            </div>
          )}
        </section>
      )}

      {noMcpModal && agent && (
        <div className="ad-modal-overlay" onClick={() => setNoMcpModal(false)}>
          <div className="ad-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ad-modal-head">
              <div className="ad-modal-icon">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>
              </div>
              <div>
                <h3 className="ad-modal-title">No MCP servers found</h3>
                <p className="ad-modal-desc">{agent.name} has nothing to protect yet</p>
              </div>
              <button className="ad-modal-close" onClick={() => setNoMcpModal(false)} aria-label="Close">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>
            <div className="ad-modal-body">
              <p>
                Please install an MCP server in {agent.name}&apos;s config before activating protection.
                Context Fence protects HTTP/remote MCP servers by routing them through its proxy —
                with no MCP servers configured there is nothing to protect.
              </p>
              {agent.configPath && (
                <p className="ad-modal-path">{agent.configPath}</p>
              )}
            </div>
            <div className="ad-modal-foot">
              <button className="ad-modal-btn" onClick={() => setNoMcpModal(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
.ad-root { position: relative; display: flex; flex-direction: column; gap: 18px; }
/* Ambient background glow — sits behind every card, never intercepts input */
.ad-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.ad-root > * { position: relative; z-index: 1; }
:root[data-theme="dark"] .ad-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ad-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
  }
}

.ad-back {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 7px;
  font: inherit; cursor: pointer;
  font-size: 12.5px; font-weight: 650; color: var(--text-secondary);
  background: var(--bg-inset); border: none; border-radius: 999px;
  padding: 9px 16px;
  transition: background 160ms ease, color 160ms ease;
}
.ad-back:hover { background: #e9ebec; color: var(--text-primary); }

.ad-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 28px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}

/* ── Hero row ──────────────────────────────────────────────────────────────*/
.ad-hero { display: flex; align-items: center; gap: 20px; padding: 2px 2px 0; flex-wrap: wrap; }
.ad-hero-logo {
  width: 76px; height: 76px; border-radius: 22px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}
.ad-hero-logo img { width: 42px; height: 42px; object-fit: contain; }
.ad-hero-logo span { font-size: 28px; font-weight: 650; color: var(--text-muted); }
.ad-hero-id { flex: 1; min-width: 240px; }
.ad-hero-name-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ad-hero-name { font-size: 28px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.ad-hero-type { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 5px 0 0; }
.ad-hero-mono { font-family: SF Mono, Menlo, monospace; font-size: 11.5px; }

.ad-state {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 11px; border-radius: 999px;
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.02em;
}
.ad-state-dot { width: 6px; height: 6px; border-radius: 50%; }
.ad-state-on { background: rgba(57,126,112,0.1); color: #2f6d60; border: 1px solid rgba(57,126,112,0.25); }
.ad-state-on .ad-state-dot { background: var(--accent-teal); box-shadow: 0 0 6px rgba(47,230,176,0.7); }
.ad-state-off { background: rgba(252,180,0,0.09); color: #a1741f; border: 1px solid rgba(222,145,29,0.28); }
.ad-state-off .ad-state-dot { background: var(--accent-amber); }

/* Protect CTA — single solid fill, full-radius pill */
.ad-protect-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 100%;
  padding: 12px 20px;
  border-radius: 999px;
  cursor: pointer; border: none;
  font-family: inherit;
  font-size: 13px; font-weight: 700; letter-spacing: -0.01em;
  color: #fff;
  transition: all 0.25s cubic-bezier(0.22,1,0.36,1);
}
.ad-protect-btn:disabled {
  opacity: 0.6; cursor: not-allowed;
  transform: none !important; box-shadow: none !important;
}
.ad-protect-btn--protect {
  background: #ff3144;
  box-shadow: 0 6px 18px rgba(255,49,68,0.28);
}
.ad-protect-btn--protect:hover {
  transform: translateY(-1px);
  box-shadow: 0 10px 26px rgba(255,49,68,0.38);
}
.ad-protect-btn--restore {
  background: #397e70;
  box-shadow: 0 6px 18px rgba(57,126,112,0.24);
}
.ad-protect-btn--restore:hover {
  background: #43907f;
  box-shadow: 0 10px 26px rgba(57,126,112,0.36);
}

/* Micro label used across cards */
.ad-microlabel {
  font-size: 10.5px; font-weight: 700; letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-muted); margin: 0 0 6px;
}

/* ── KPI band ──────────────────────────────────────────────────────────────*/
.ad-band { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); }
.ad-tile { padding: 22px 24px; display: flex; flex-direction: column; min-height: 118px; }
.ad-tile-label {
  font-size: 12.5px; font-weight: 550; letter-spacing: -0.01em;
  margin: 0; opacity: 0.85;
}
.ad-tile-value {
  font-size: clamp(30px, 3vw, 38px); font-weight: 400;
  letter-spacing: -0.03em; line-height: 1.05; margin: auto 0 0;
  padding-top: 14px;
  font-variant-numeric: tabular-nums;
}
.ad-tile-orange { background: linear-gradient(160deg, #ff5163, #ff3144); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(255,49,68,0.28); }
.ad-tile-teal   { background: linear-gradient(160deg, #43907f, #397e70); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(57,126,112,0.26); }
.ad-tile-orange .ad-tile-label, .ad-tile-teal .ad-tile-label { opacity: 0.9; }
.ad-tile-white .ad-tile-label { color: var(--text-muted); opacity: 1; }

.ad-footnote { font-size: 12px; font-weight: 500; color: var(--text-muted); font-style: italic; margin: 0; padding: 0 4px; }

/* ── Main split: activity canvas | rail ────────────────────────────────────*/
.ad-main { display: grid; gap: 18px; grid-template-columns: 2fr 1fr; align-items: stretch; }
@media (max-width: 1080px) { .ad-main { grid-template-columns: 1fr; } }
.ad-activity { display: flex; flex-direction: column; min-width: 0; }
.ad-chart-body { flex: 1; min-height: 300px; }
.ad-rail { display: flex; flex-direction: column; gap: 18px; min-width: 0; }

.ad-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.ad-h3 { font-size: 21px; font-weight: 550; letter-spacing: -0.015em; color: var(--text-primary); margin: 0; line-height: 1.25; }
.ad-h3-sub { font-size: 12.5px; font-weight: 500; color: var(--text-muted); margin: 3px 0 0; }

/* Period range toggle */
.ad-range {
  display: flex; gap: 2px; padding: 3px;
  border-radius: 999px; background: var(--bg-inset); flex-shrink: 0;
}
.ad-range-btn {
  padding: 6px 14px; font-size: 11.5px; font-weight: 700;
  border: none; border-radius: 999px; cursor: pointer; font-family: inherit;
  background: transparent; color: var(--text-muted);
  transition: all 200ms cubic-bezier(0.22,1,0.36,1);
}
.ad-range-btn.active { background: #111111; color: #ffffff; }
.ad-range-btn:not(.active):hover { color: var(--text-primary); background: var(--bg-surface-hover); }

.ad-noactivity { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 56px 20px; text-align: center; }
.ad-noactivity-title { font-size: 14px; font-weight: 650; color: var(--text-secondary); margin: 0; }
.ad-noactivity-sub { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 5px 0 0; }

/* Protection card */
.ad-prot-card { display: flex; flex-direction: column; gap: 14px; }
.ad-prot-card--on { border-color: rgba(57,126,112,0.32); }
.ad-prot-body { display: flex; align-items: center; gap: 16px; }
.ad-dial { position: relative; width: 86px; height: 86px; flex-shrink: 0; }
.ad-dial-icon {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
}
.ad-prot-copy { min-width: 0; }
.ad-prot-state { font-size: 14.5px; font-weight: 700; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; line-height: 1.3; }
.ad-prot-desc { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 5px 0 0; line-height: 1.5; }
.ad-warn { font-size: 12px; font-weight: 600; color: var(--accent-amber); margin: 0; }
.ad-fail { font-size: 12px; font-weight: 600; color: var(--accent-coral); margin: 0; }
.ad-ok { font-size: 12px; font-weight: 600; color: var(--accent-teal); margin: 0; word-break: break-all; }

/* Lifecycle card */
.ad-life-rows { display: flex; flex-direction: column; }
.ad-life-row {
  display: flex; align-items: baseline; justify-content: space-between; gap: 16px;
  padding: 11px 0;
  border-bottom: 1px solid var(--border-default);
}
.ad-life-row:last-child { border-bottom: none; padding-bottom: 2px; }
.ad-life-row:first-child { padding-top: 2px; }
.ad-life-key { font-size: 12.5px; font-weight: 550; color: var(--text-muted); }
.ad-life-val { font-size: 13px; font-weight: 650; color: var(--text-primary); text-align: right; letter-spacing: -0.01em; }

/* ── Bottom triptych ───────────────────────────────────────────────────────*/
.ad-bottom { display: grid; gap: 18px; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.ad-bottom--one { grid-template-columns: 1fr; }
.ad-bottom .ad-card { min-width: 0; }

/* MCP servers list */
.ad-mcps { display: flex; flex-direction: column; gap: 8px; }
.ad-mcp-row {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
  padding: 12px 16px; border-radius: 14px;
  background: var(--bg-inset); border: 1px solid transparent;
  transition: border-color 160ms ease;
}
.ad-mcp-row:hover { border-color: var(--border-strong); }
.ad-mcp-id { min-width: 0; }
.ad-mcp-name { font-size: 13.5px; font-weight: 650; color: var(--text-primary); margin: 0; }
.ad-mcp-type { font-size: 11px; font-weight: 600; color: var(--text-muted); margin: 2px 0 0; }
.ad-mcp-target {
  font-size: 11px; font-family: SF Mono, Menlo, monospace; color: var(--text-muted);
  max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  flex-shrink: 1;
}
@media (max-width: 700px) { .ad-mcp-target { display: none; } }

/* ── Paths strip ───────────────────────────────────────────────────────────*/
.ad-paths { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; padding: 20px 28px; }
@media (max-width: 800px) { .ad-paths { grid-template-columns: 1fr; gap: 14px; } }
.ad-path-cell { min-width: 0; }
.ad-path { font-size: 11.5px; font-family: SF Mono, Menlo, monospace; color: var(--text-secondary); margin: 0; word-break: break-all; line-height: 1.5; }

/* Floating chart tooltip — matches the Dashboard's db-tooltip */
.ad-tooltip {
  background: #ffffff; border-radius: 12px; padding: 10px 12px;
  box-shadow: 0 10px 30px rgba(16,24,32,0.14), 0 1px 3px rgba(16,24,32,0.08);
  border: 1px solid var(--border-default); min-width: 130px;
}
.ad-tooltip-label { margin: 0 0 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); }
.ad-tooltip-row { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 2px 0; }
.ad-tooltip-dot { width: 7px; height: 7px; border-radius: 50%; }
.ad-tooltip-name { color: var(--text-secondary); font-weight: 550; }
.ad-tooltip-val { margin-left: auto; color: var(--text-primary); font-weight: 750; font-variant-numeric: tabular-nums; padding-left: 14px; }

/* Loading + missing states */
.ad-skel-hero { display: flex; align-items: center; gap: 20px; padding: 2px 2px 0; }
.ad-skel-logo { width: 76px; height: 76px; border-radius: 22px; background: var(--bg-inset); flex-shrink: 0; }
.ad-skel-lines { flex: 1; display: flex; flex-direction: column; gap: 10px; }
.ad-skel-line { height: 13px; border-radius: 6px; background: var(--bg-inset); }
.ad-skel-tile { min-height: 118px; }
.ad-skel-canvas { min-height: 380px; }
.ad-missing { text-align: center; font-size: 15px; font-weight: 650; color: var(--text-muted); padding: 56px 28px; }

/* ── Dark mode ──────────────────────────────────────────────────────────────*/
:root[data-theme="dark"] .ad-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .ad-hero-name, :root[data-theme="dark"] .ad-h3 { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
:root[data-theme="dark"] .ad-tile-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
:root[data-theme="dark"] .ad-tile-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
:root[data-theme="dark"] .ad-back:hover { background: #1c232e; }
:root[data-theme="dark"] .ad-range-btn.active { background: #f2f5f9; color: #0a0d13; }
:root[data-theme="dark"] .ad-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
:root[data-theme="dark"] .ad-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
:root[data-theme="dark"] .ad-prot-card--on { border-color: rgba(47,230,176,0.3); }
:root[data-theme="dark"] .ad-protect-btn--protect { background: #e51f33; box-shadow: var(--glow-red); }
:root[data-theme="dark"] .ad-protect-btn--restore { background: #0e8a6d; box-shadow: var(--glow-teal); }
:root[data-theme="dark"] .ad-protect-btn--restore:hover { background: #17b28c; }
:root[data-theme="dark"] .ad-tooltip { background: #161c26; border-color: rgba(255,255,255,0.09); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .ad-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .ad-hero-name, :root:not([data-theme]) .ad-h3 { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
  :root:not([data-theme]) .ad-tile-orange { background: linear-gradient(160deg, #ff4d5e, #e51f33); box-shadow: var(--glow-red); }
  :root:not([data-theme]) .ad-tile-teal { background: linear-gradient(160deg, #17b28c, #0e8a6d); box-shadow: var(--glow-teal); }
  :root:not([data-theme]) .ad-back:hover { background: #1c232e; }
  :root:not([data-theme]) .ad-range-btn.active { background: #f2f5f9; color: #0a0d13; }
  :root:not([data-theme]) .ad-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
  :root:not([data-theme]) .ad-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
  :root:not([data-theme]) .ad-prot-card--on { border-color: rgba(47,230,176,0.3); }
  :root:not([data-theme]) .ad-protect-btn--protect { background: #e51f33; box-shadow: var(--glow-red); }
  :root:not([data-theme]) .ad-protect-btn--restore { background: #0e8a6d; box-shadow: var(--glow-teal); }
  :root:not([data-theme]) .ad-protect-btn--restore:hover { background: #17b28c; }
  :root:not([data-theme]) .ad-tooltip { background: #161c26; border-color: rgba(255,255,255,0.09); }
}

@media (prefers-reduced-motion: reduce) {
  .ad-protect-btn { transition: none !important; }
}
      `}</style>

    </motion.div>
  );
}
