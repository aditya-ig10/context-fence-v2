import { useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { AreaChart, Area, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ArrowLeft, RefreshCw, Play, Trash2 } from 'lucide-react';
import ConnectorDetail from '../components/ConnectorDetail';
import TestCallModal from '../components/TestCallModal';
import { invalidateCache, useCachedFetch } from '../hooks/useCachedFetch';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';
import { getConnectorIcon } from '../lib/connectorIcons';
import type { ConnectorDetail as Detail, Connector } from '../types';

// Connector detail page — compact editorial layout:
//   hero (icon, name, status, actions)
//   -> one stat strip (all figures inline, hairline-divided)
//   -> activity chart | proxy card (with transport facts folded in)
//   -> tools (dense 2-col grid) + bindings/config via ConnectorDetail.

const containerVariants = { hidden: {}, visible: { transition: { staggerChildren: 0.05 } } };
const cardVariants = { hidden: { opacity: 0, y: 16, scale: 0.98 }, visible: { opacity: 1, y: 0, scale: 1 } };
const EASE = [0.22, 1, 0.36, 1] as const;

function formatNumber(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

const STATUS_META: Record<Connector['status'], { label: string; className: string }> = {
  connected: { label: 'Connected', className: 'cdp-state-on' },
  'needs-auth': { label: 'Needs auth', className: 'cdp-state-off' },
  error: { label: 'Failed', className: 'cdp-state-err' },
};

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="cdp-tooltip">
      <p className="cdp-tooltip-label">{String(label)}</p>
      {payload.map((p: any, i: number) => (
        <div key={i} className="cdp-tooltip-row">
          <span className="cdp-tooltip-dot" style={{ background: p.color || p.stroke }} />
          <span className="cdp-tooltip-name">{p.name}</span>
          <span className="cdp-tooltip-val">{formatNumber(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

export default function ConnectorDetailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { name = '' } = useParams<{ name: string }>();
  const serverType = (location.state as { type?: 'stdio' | 'http' } | null)?.type ?? 'stdio';
  const ConnectorIcon = getConnectorIcon(name);

  const { data, loading, refresh } = useCachedFetch<Detail>(`server:${name}`, () =>
    fetch(`/api/servers/${encodeURIComponent(name)}`).then((r) => r.json()), { maxAgeMs: 15_000 });

  const detectHook = useCachedFetch<{ agents: { name?: string; type?: string; agentName?: string; agentType?: string }[] }>('detect', () =>
    fetch('/api/detect').then(r => r.json()), { maxAgeMs: 60_000 });

  const [syncing, setSyncing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testOpen, setTestOpen] = useState(false);

  const server = data?.server;
  const tools = data?.tools ?? [];
  const stats = data?.stats;

  const callsToday = stats?.today ?? 0;
  const blockedToday = stats?.blockedToday ?? 0;
  const blockRate = callsToday > 0 ? Math.round((blockedToday / callsToday) * 100) : 0;
  const boundAgents = server?.boundAgents ?? [];
  const activeBindings = boundAgents.filter((b) => b.enabled).length;
  const deniedTools = tools.filter((t) => t.policy?.action === 'deny').length;

  const callsAnim = useCountUp(callsToday);
  const blockedAnim = useCountUp(blockedToday);
  const toolsAnim = useCountUp(tools.length);

  // Rolling last-24h window keyed to the system clock (same approach as
  // AgentDetail / stats.ts): buckets end at the CURRENT local hour and labels
  // are local wall time. The backend groups by UTC hour-of-day over
  // `timestamp >= datetime('now','-24 hours')`, so each point maps its local
  // instant back to that UTC hour number.
  const utcHourBuckets = new Map<number, { allowed: number; denied: number }>();
  for (const h of stats?.hourly ?? []) {
    const b = utcHourBuckets.get(h.hour) ?? { allowed: 0, denied: 0 };
    if (h.decision === 'deny') b.denied += h.count; else b.allowed += h.count;
    utcHourBuckets.set(h.hour, b);
  }
  const nowMs = Date.now();
  const activityData = Array.from({ length: 24 }, (_, i) => {
    const d = new Date(nowMs - (23 - i) * 3_600_000);
    const b = utcHourBuckets.get(d.getUTCHours()) ?? { allowed: 0, denied: 0 };
    return {
      hour: `${String(d.getHours()).padStart(2, '0')}:00`,
      allowed: b.allowed,
      denied: b.denied,
    };
  });
  const hasActivity = (stats?.hourly ?? []).length > 0;

  function invalidate() {
    invalidateCache((k) => k === 'servers' || k === 'stats' || k.startsWith('server:') || k.startsWith('policies'));
    refresh();
  }

  async function handleSync() {
    setSyncing(true);
    const loadingId = notify.loading('Syncing tools…', `Re-discovering the tool inventory for ${name}`);
    try {
      const res = await fetch(`/api/servers/${encodeURIComponent(name)}/sync-tools`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!body.ok) throw new Error(body.error ?? 'Sync failed');
      notify.dismiss(loadingId);
      notify.success('Tools synced', `${name}'s tool inventory is up to date`);
    } catch (err) {
      notify.dismiss(loadingId);
      notify.error('Sync failed', err instanceof Error ? err.message : String(err));
    }
    setSyncing(false);
    invalidate();
  }

  async function handleRemove() {
    setRemoving(true);
    try {
      await fetch(`/api/servers/${encodeURIComponent(name)}`, { method: 'DELETE' });
      notify.success(`${name} removed`, 'It will reappear if its config is detected again');
      invalidateCache((k) => k === 'servers' || k.startsWith('server:') || k.startsWith('policies'));
      navigate('/test-mcp');
    } catch {
      notify.error('Remove failed', 'Could not reach the backend');
    }
    setRemoving(false);
  }

  if (!name) {
    return <div className="cdp-root"><p className="cdp-missing">Connector not found.</p></div>;
  }

  const meta = server ? (STATUS_META[server.status] ?? STATUS_META.error) : null;
  const origin = server ? (server.type === 'http' ? server.url ?? '' : [server.command ?? '', ...(server as any).args ?? ''].join(' ')) : '';
  const lastSync = data?.lastSync ?? server?.lastSync;

  return (
    <div className="cdp-root">
      <button className="cdp-back" onClick={() => navigate('/test-mcp')}>
        <ArrowLeft size={14} />
        Connectors
      </button>

      {/* Hero */}
      <motion.header className="cdp-hero" variants={cardVariants} initial="hidden" animate="visible" transition={{ duration: 0.4, ease: EASE }}>
        <div className="cdp-hero-icon" title={name}>
          <ConnectorIcon size={26} strokeWidth={1.75} />
        </div>
        <div className="cdp-hero-id">
          <div className="cdp-hero-name-row">
            <h1 className="cdp-hero-name">{name}</h1>
            {meta && (
              <span className={`cdp-state ${meta.className}`}>
                <span className="cdp-state-dot" />
                {meta.label}
              </span>
            )}
          </div>
          <p className="cdp-hero-type">
            {serverType === 'http' ? 'Remote MCP endpoint' : 'Local stdio MCP server'}
            {origin ? <> · <span className="cdp-hero-mono">{origin.length > 64 ? origin.slice(0, 63) + '…' : origin}</span></> : null}
          </p>
        </div>
        <div className="cdp-hero-actions">
          <button className="cdp-act" onClick={handleSync} disabled={syncing}>
            <RefreshCw size={13} className={syncing ? 'cdp-spin' : ''} />
            {syncing ? 'Syncing…' : 'Sync'}
          </button>
          <button className="cdp-act cdp-act-primary" onClick={() => setTestOpen(true)}>
            <Play size={13} />
            Test call
          </button>
          <button className="cdp-act cdp-act-danger" onClick={handleRemove} disabled={removing}>
            <Trash2 size={13} />
            {removing ? '…' : 'Remove'}
          </button>
        </div>
      </motion.header>

      {/* Stat strip — every figure inline, hairline-divided */}
      <motion.section className="cdp-card cdp-strip" variants={cardVariants} initial="hidden" animate="visible" transition={{ duration: 0.4, ease: EASE }}>
        <div className="cdp-strip-cell">
          <p className="cdp-strip-key">Calls today</p>
          <p className="cdp-strip-val">{formatNumber(callsAnim)}</p>
        </div>
        <div className="cdp-strip-cell">
          <p className="cdp-strip-key">Blocked</p>
          <p className="cdp-strip-val cdp-strip-warn">{formatNumber(blockedAnim)} <em>{blockRate}%</em></p>
        </div>
        <div className="cdp-strip-cell">
          <p className="cdp-strip-key">Tools</p>
          <p className="cdp-strip-val">{formatNumber(toolsAnim)} <em>{deniedTools > 0 ? `${deniedTools} denied` : 'open'}</em></p>
        </div>
        <div className="cdp-strip-cell">
          <p className="cdp-strip-key">Agent Protection</p>
          <p className="cdp-strip-val">
            {activeBindings > 0 ? (
              <>{activeBindings}<em> bound</em></>
            ) : (
              <span className="cdp-strip-unbound">None bound</span>
            )}
          </p>
        </div>
        <div className="cdp-strip-cell cdp-strip-cell-last">
          <p className="cdp-strip-key">Last synced</p>
          <p className="cdp-strip-val cdp-strip-time">{lastSync ? timeAgoStr(lastSync) : 'never'}</p>
        </div>
      </motion.section>

      {/* Activity | Proxy */}
      <motion.section className="cdp-main" variants={containerVariants} initial="hidden" animate="visible">
        <motion.div className="cdp-card cdp-activity" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <div className="cdp-card-head">
            <div>
              <h3 className="cdp-h3">Activity</h3>
              <p className="cdp-h3-sub">Calls per hour — last 24h</p>
            </div>
            <div className="cdp-legend">
              <span><i className="cdp-li cdp-li-ok" /> Allowed</span>
              <span><i className="cdp-li cdp-li-err" /> Denied</span>
            </div>
          </div>
          {hasActivity ? (
            <div className="cdp-chart-body">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={activityData} margin={{ top: 8, right: 12, left: -6, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cdpFillAllowed" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#17b28c" stopOpacity={0.2} />
                      <stop offset="95%" stopColor="#17b28c" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="cdpFillDenied" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#ff3144" stopOpacity={0.22} />
                      <stop offset="95%" stopColor="#ff3144" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="var(--chart-grid)" vertical={false} />
                  <XAxis dataKey="hour" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} minTickGap={24} />
                  <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} tickFormatter={(v: number) => formatNumber(v)} width={44} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#b9bfc5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                  <Area type="monotone" dataKey="allowed" name="Allowed" stroke="#17b28c" strokeWidth={2.2} fill="url(#cdpFillAllowed)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} animationBegin={180} animationDuration={700} />
                  <Area type="monotone" dataKey="denied" name="Denied" stroke="#ff3144" strokeWidth={2.2} fill="url(#cdpFillDenied)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} animationBegin={260} animationDuration={700} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="cdp-noactivity">
              <p className="cdp-noactivity-title">No activity in the last 24 hours</p>
              <p className="cdp-noactivity-sub">Calls appear once an agent invokes this connector through the proxy.</p>
            </div>
          )}
        </motion.div>

        <motion.div className={`cdp-card cdp-proxy${server?.status === 'connected' ? ' cdp-proxy--on' : ''}`} variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <p className="cdp-microlabel">Proxy</p>
          <div className="cdp-proxy-state">
            <span className="cdp-proxy-dot" />
            <div>
              <p className="cdp-proxy-title">
                {server?.status === 'connected' ? 'Live through the proxy' : server?.status === 'needs-auth' ? 'Waiting for credentials' : 'Not reachable'}
              </p>
              <p className="cdp-proxy-sub">every call intercepted · policy-checked · audited</p>
            </div>
          </div>
          <div className="cdp-facts">
            <div className="cdp-fact"><span>Transport</span><b>{server?.type ?? serverType}</b></div>
            <div className="cdp-fact"><span>Auth</span><b>{server?.authType ?? 'none'}</b></div>
            <div className="cdp-fact"><span>Last check</span><b>{server?.lastCheck ?? '—'}</b></div>
          </div>
        </motion.div>
      </motion.section>

      {/* Tools (dense) + bindings + config */}
      <motion.div variants={containerVariants} initial="hidden" animate="visible">
        <ConnectorDetail
          key={name}
          serverName={name}
          serverType={serverType}
          embedded
          sections={['tools', 'agents', 'config']}
          onClose={() => navigate('/test-mcp')}
          onChanged={invalidate}
          detectedAgents={detectHook.data?.agents ?? []}
        />
      </motion.div>

      {server && (
        <TestCallModal serverName={name} serverType={serverType} open={testOpen} onClose={() => setTestOpen(false)} />
      )}

      {loading && !data && <div className="cdp-loading">Loading connector…</div>}

      <style>{`
.cdp-root { display: flex; flex-direction: column; gap: 16px; }
.cdp-back {
  align-self: flex-start;
  display: inline-flex; align-items: center; gap: 7px;
  font: inherit; font-size: 12.5px; font-weight: 650;
  padding: 7px 15px 7px 11px; border-radius: 999px; border: none; cursor: pointer;
  background: var(--bg-inset); color: var(--text-secondary);
  transition: background 160ms ease, color 160ms ease;
}
.cdp-back:hover { background: #e9ebec; color: var(--text-primary); }
.cdp-missing, .cdp-loading { font-size: 14px; font-weight: 600; color: var(--text-muted); padding: 40px; text-align: center; }

/* Hero */
.cdp-hero { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding: 2px 2px 0; }
.cdp-hero-icon {
  width: 58px; height: 58px; border-radius: 18px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--card-bg); border: 1px solid var(--card-border);
  box-shadow: 0 1px 2px rgba(16,24,32,0.04); color: var(--accent-coral);
}
.cdp-hero-id { flex: 1; min-width: 220px; }
.cdp-hero-name-row { display: flex; align-items: center; gap: 11px; flex-wrap: wrap; }
.cdp-hero-name { font-size: 25px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.cdp-hero-type { font-size: 12.5px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.cdp-hero-mono { font-family: 'SF Mono', Menlo, monospace; font-size: 11px; }
.cdp-hero-actions { display: flex; align-items: center; gap: 7px; }
.cdp-act {
  display: inline-flex; align-items: center; gap: 6px;
  font: inherit; font-size: 12px; font-weight: 650;
  padding: 8px 14px; border-radius: 999px; border: 1px solid var(--border-default);
  background: var(--card-bg); color: var(--text-secondary); cursor: pointer;
  transition: all 160ms ease;
}
.cdp-act:hover:not(:disabled) { color: var(--text-primary); border-color: var(--border-strong); }
.cdp-act:disabled { opacity: 0.55; cursor: not-allowed; }
.cdp-act-primary { background: #ff3144; border-color: #ff3144; color: #fff; box-shadow: 0 8px 20px rgba(255,49,68,0.25); }
.cdp-act-primary:hover:not(:disabled) { background: #e51f33; color: #fff; border-color: #e51f33; }
.cdp-act-danger:hover:not(:disabled) { color: #d92c3c; border-color: rgba(217,44,60,0.4); }
.cdp-spin { animation: cdpSpin 1s linear infinite; }
@keyframes cdpSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

/* Status pill */
.cdp-state {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 11px; font-weight: 650;
  padding: 5px 12px; border-radius: 999px; border: 1px solid transparent;
}
.cdp-state-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.cdp-state-on  { background: rgba(47,230,176,0.09); color: #128a6d; border-color: rgba(18,138,109,0.25); }
.cdp-state-off { background: rgba(255,176,32,0.09); color: #b7791f; border-color: rgba(183,121,31,0.28); }
.cdp-state-err { background: rgba(255,49,68,0.08); color: #d92c3c; border-color: rgba(217,44,60,0.25); }

/* Cards */
.cdp-card {
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 22px; box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}

/* Stat strip */
.cdp-strip { display: grid; grid-template-columns: repeat(5, auto); justify-content: space-between; gap: 8px; padding: 18px 26px; }
@media (max-width: 900px) { .cdp-strip { grid-template-columns: 1fr 1fr; } }
.cdp-strip-cell { display: flex; flex-direction: column; gap: 3px; padding-right: 22px; border-right: 1px solid var(--border-default); }
.cdp-strip-cell-last { border-right: none; padding-right: 0; }
@media (max-width: 900px) { .cdp-strip-cell { border-right: none; } }
.cdp-strip-key { font-size: 11px; font-weight: 650; letter-spacing: 0.02em; color: var(--text-muted); margin: 0; }
.cdp-strip-val { font-size: 24px; font-weight: 400; letter-spacing: -0.02em; line-height: 1.1; color: var(--text-primary); margin: 0; font-variant-numeric: tabular-nums; }
.cdp-strip-val em { font-style: normal; font-size: 12px; font-weight: 600; color: var(--text-muted); margin-left: 5px; letter-spacing: 0; }
.cdp-strip-warn em { color: #d92c3c; }
.cdp-strip-time { font-size: 24px; font-weight: 700; line-height: 1.1; letter-spacing: -0.02em; }

/* Main split */
.cdp-main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 16px; align-items: stretch; }
@media (max-width: 1000px) { .cdp-main { grid-template-columns: 1fr; } }
.cdp-activity { padding: 18px 22px; display: flex; flex-direction: column; min-width: 0; }
.cdp-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.cdp-h3 { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.cdp-h3-sub { font-size: 11.5px; font-weight: 550; color: var(--text-muted); margin: 2px 0 0; }
.cdp-legend { display: flex; gap: 12px; font-size: 11px; font-weight: 550; color: var(--text-muted); }
.cdp-legend span { display: inline-flex; align-items: center; gap: 5px; }
.cdp-li { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
.cdp-li-ok { background: #17b28c; }
.cdp-li-err { background: #ff3144; }
.cdp-chart-body { flex: 1; min-height: 264px; height: 100%; }
.cdp-noactivity {
  flex: 1; min-height: 240px;
  display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
}
.cdp-noactivity-title { font-size: 14px; font-weight: 650; color: var(--text-primary); margin: 0; }
.cdp-noactivity-sub { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 5px 0 0; max-width: 26em; line-height: 1.5; }
.cdp-tooltip {
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 12px; padding: 9px 11px;
  box-shadow: 0 10px 30px rgba(16,24,32,0.12);
}
.cdp-tooltip-label { margin: 0 0 4px; font-size: 11px; font-weight: 700; color: var(--text-primary); }
.cdp-tooltip-row { display: flex; align-items: center; gap: 7px; font-size: 11.5px; margin-top: 3px; }
.cdp-tooltip-dot { width: 8px; height: 8px; border-radius: 3px; }
.cdp-tooltip-name { color: var(--text-muted); font-weight: 550; }
.cdp-tooltip-val { margin-left: auto; font-weight: 750; color: var(--text-primary); font-variant-numeric: tabular-nums; padding-left: 12px; }

/* Proxy card */
.cdp-proxy { padding: 20px 22px; display: flex; flex-direction: column; gap: 14px; }
.cdp-proxy--on { border-color: rgba(57,126,112,0.35); }
.cdp-microlabel { font-size: 10.5px; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-muted); margin: 0; }
.cdp-proxy-state { display: flex; gap: 11px; align-items: flex-start; }
.cdp-proxy-dot {
  width: 11px; height: 11px; border-radius: 50%; margin-top: 4px; flex-shrink: 0;
  background: var(--accent-amber); box-shadow: 0 0 0 4px rgba(255,176,32,0.14);
}
.cdp-proxy--on .cdp-proxy-dot { background: var(--accent-teal); box-shadow: 0 0 0 4px rgba(47,230,176,0.16); animation: cdpPulse 2.4s ease-in-out infinite; }
@keyframes cdpPulse { 0%, 100% { box-shadow: 0 0 0 4px rgba(47,230,176,0.16); } 50% { box-shadow: 0 0 0 7px rgba(47,230,176,0.07); } }
.cdp-proxy-title { font-size: 14px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.cdp-proxy-sub { font-size: 11px; font-weight: 500; color: var(--text-muted); margin: 3px 0 0; line-height: 1.45; }
.cdp-facts { margin-top: auto; display: flex; flex-direction: column; }
.cdp-fact {
  display: flex; justify-content: space-between; align-items: baseline;
  font-size: 11.5px; padding: 8px 0; border-top: 1px solid var(--border-default);
}
.cdp-fact span { color: var(--text-muted); font-weight: 550; }
.cdp-fact b { color: var(--text-primary); font-weight: 650; }

/* Embedded ConnectorDetail: dense, carded, space-efficient */
.cdp-root .cd-head { display: none; }
.cdp-root .cd-close { display: none; }
.cdp-root .cd-panel.cd-panel--page {
  width: 100%; max-width: none; margin: 0;
  background: transparent; border: none; border-radius: 0;
  box-shadow: none; overflow: visible; display: block;
}
.cdp-root .cd-section {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 22px;
  padding: 16px 20px;
  margin: 0 0 16px;
  width: 100%;
  box-sizing: border-box;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}
.cdp-root .cd-section:last-child { margin-bottom: 0; }
.cdp-root .cd-section-head { margin-bottom: 12px; }
.cdp-root .cd-section-title { font-size: 14px; }
/* Dense tools grid */
.cdp-root .cd-tools {
  display: grid !important;
  grid-template-columns: 1fr 1fr !important;
  gap: 7px !important;
}
@media (max-width: 860px) { .cdp-root .cd-tools { grid-template-columns: 1fr !important; } }
.cdp-root .cd-tool {
  background: var(--bg-inset) !important;
  border-radius: 13px !important;
  padding: 10px 12px !important;
  display: flex !important;
  align-items: center !important;
  justify-content: space-between !important;
  gap: 10px;
  min-height: 0 !important;
}
.cdp-root .cd-tool-desc { display: none; }
.cdp-root .cd-tool-name { font-size: 12px !important; }
.cdp-root .cd-tool-main { min-width: 0; flex: 1; }
.cdp-root .cd-tool-name-row { flex-wrap: nowrap; }

/* Dark mode */
:root[data-theme="dark"] .cdp-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .cdp-hero-icon { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .cdp-hero-name { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
:root[data-theme="dark"] .cdp-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
:root[data-theme="dark"] .cdp-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
:root[data-theme="dark"] .cdp-state-err { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
:root[data-theme="dark"] .cdp-back:hover { background: #232b38; }
:root[data-theme="dark"] .cdp-act { background: var(--bg-inset); border-color: transparent; }
:root[data-theme="dark"] .cdp-act-primary { background: #ff3144; border-color: #ff3144; color: #fff; }
:root[data-theme="dark"] .cdp-strip-cell { border-right-color: rgba(255,255,255,0.08); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .cdp-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .cdp-hero-icon { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .cdp-hero-name { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
  :root:not([data-theme]) .cdp-state-on { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
  :root:not([data-theme]) .cdp-state-off { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.26); }
  :root:not([data-theme]) .cdp-state-err { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
  :root:not([data-theme]) .cdp-back:hover { background: #232b38; }
  :root:not([data-theme]) .cdp-act { background: var(--bg-inset); border-color: transparent; }
  :root:not([data-theme]) .cdp-act-primary { background: #ff3144; border-color: #ff3144; color: #fff; }
  :root:not([data-theme]) .cdp-strip-cell { border-right-color: rgba(255,255,255,0.08); }
}
      `}</style>
    </div>
  );
}

function timeAgoStr(iso: string): string {
  const t = new Date(iso.replace(' ', 'T') + 'Z').getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
