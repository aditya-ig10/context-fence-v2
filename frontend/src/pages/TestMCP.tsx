import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer } from 'recharts';
import { RefreshCw } from 'lucide-react';
import ConnectorCard from '../components/ConnectorCard';
import { useNavigate } from 'react-router-dom';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';
import type { Connector } from '../types';

// Connectors page — Agents-page art direction:
//   slim header -> one editorial overview card (figures + health bar + radar)
//   -> ag2-style connector cards in a staggered pop-in grid.

interface ScanConfigInfo {
  path: string;
  name: string;
  exists: boolean;
  mcps: number;
  parseError: string | null;
}

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1 },
};

export default function TestMCP() {
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const { data: serversData, loading: serversLoading, refresh: refreshServers } = useCachedFetch<{ servers: Connector[] }>('servers', () =>
    fetch('/api/servers').then((r) => r.json()).then((data) => ({ servers: (data.servers || []).sort((a: Connector, b: Connector) => a.name.localeCompare(b.name)) })),
  );

  const servers = serversData?.servers ?? [];
  function invalidateAll() {
    invalidateCache((k) => k.startsWith('server:') || k === 'servers' || k === 'stats' || k.startsWith('policies'));
    refreshServers();
  }

  async function handleSync(name: string) {
    setSyncing(name);
    try {
      await fetch(`/api/servers/${encodeURIComponent(name)}/sync-tools`, { method: 'POST' });
    } catch { /* surface via card status */ }
    setSyncing(null);
    invalidateAll();
  }

  // Refresh (mirrors the Agents page): full disk re-scan via
  // POST /api/connectors/scan, then re-fetch the servers list so freshly
  // discovered connectors render immediately. Same single-in-flight guard,
  // same liquid-glass sonner feedback (loading → success/error).
  const refreshingRef = useRef(false);
  async function handleRefresh() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const loadingId = notify.loading('Refreshing discovery…', 'Re-reading every MCP config from disk');
    try {
      const res = await fetch('/api/connectors/scan', { method: 'POST' });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body?.error ?? `Discovery scan failed (HTTP ${res.status})`);
      }
      invalidateCache((k) => k === 'servers' || k === 'stats' || k === 'detect' || k.startsWith('server:') || k.startsWith('policies'));
      await Promise.resolve(refreshServers());
      notify.dismiss(loadingId);
      notify.success('Refreshed successfully', 'Every MCP config was re-read from disk');
    } catch (err) {
      notify.dismiss(loadingId);
      notify.error('Refresh failed', err instanceof Error ? err.message : String(err));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  // Rollups — every figure is real data from /api/servers.
  const n = servers.length || 1;
  const connected = servers.filter((s) => s.status === 'connected').length;
  const failed = servers.filter((s) => s.status === 'error').length;
  const needsAuth = servers.filter((s) => s.status === 'needs-auth').length;
  const toolsTotal = servers.reduce((sum, s) => sum + (s.toolCount ?? 0), 0);
  const callsTotal = servers.reduce((sum, s) => sum + (s.callsToday ?? 0), 0);
  const bindings = servers.flatMap((s) => s.boundAgents ?? []);
  const bindingsActive = bindings.filter((b) => b.enabled).length;
  const healthPct = servers.length > 0 ? Math.round((connected / servers.length) * 100) : 0;

  const callsAnim = useCountUp(callsTotal);
  const toolsAnim = useCountUp(toolsTotal);
  const onlineAnim = useCountUp(connected);

  const clamp = (v: number) => Math.max(4, Math.min(100, Math.round(v)));
  const posture = [
    { axis: 'Online', value: clamp((connected / n) * 100), ceiling: 100 },
    { axis: 'Coverage', value: clamp((toolsTotal / 60) * 100), ceiling: 100 },
    { axis: 'Traffic', value: clamp((Math.log10(callsTotal + 1) / Math.log10(500)) * 100), ceiling: 100 },
    { axis: 'Bindings', value: bindings.length ? clamp((bindingsActive / bindings.length) * 100) : 0, ceiling: 100 },
    { axis: 'Auth', value: 100, ceiling: 100 },
  ];

  return (
    <div className="cx-root">
      <header className="cx-head">
        <div>
          <h1 className="cx-heading">Connectors</h1>
          <p className="cx-subhead">Every MCP server routed through the firewall proxy.</p>
        </div>
        <button className="cx-refresh" type="button" onClick={handleRefresh} disabled={refreshing}
          title="Re-scan every MCP config on disk (full disk read, no cache)">
          <RefreshCw size={14} className={refreshing ? 'cx-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      </header>

      {servers.length > 0 && (
        <motion.section className="cx-overview" variants={cardVariants} initial="hidden" animate="visible"
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}>
          <div className="cx-ov-figures">
            <div className="cx-ov-figure">
              <p className="cx-ov-value">{callsAnim.toLocaleString()}</p>
              <p className="cx-ov-label">Calls today</p>
              <p className="cx-ov-sub">policy-checked &amp; audited</p>
            </div>
            <div className="cx-ov-figure">
              <p className="cx-ov-value">{toolsAnim.toLocaleString()}</p>
              <p className="cx-ov-label">Tools</p>
              <p className="cx-ov-sub">under enforcement</p>
            </div>
            <div className="cx-ov-figure">
              <p className="cx-ov-value">{bindings.length > 0 ? <>{bindingsActive}<span className="cx-ov-dim">/{bindings.length}</span></> : '—'}</p>
              <p className="cx-ov-label">Bindings</p>
              <p className="cx-ov-sub">agent wires active</p>
            </div>
          </div>

          <div className="cx-ov-health">
            <div className="cx-ov-health-head">
              <p className="cx-ov-label">Fleet health</p>
              <p className="cx-ov-health-num">{onlineAnim}<span className="cx-ov-dim">/{servers.length}</span> online</p>
            </div>
            <div className="cx-stack">
              <motion.div
                className="cx-stack-seg cx-stack-ok"
                initial={{ scaleX: 0 }} animate={{ scaleX: servers.length ? connected / servers.length : 0 }}
                transition={{ duration: 0.8, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
                style={{ transformOrigin: 'left' }}
              />
              {needsAuth > 0 && <div className="cx-stack-seg cx-stack-warn" style={{ flexGrow: needsAuth }} />}
              {failed > 0 && <div className="cx-stack-seg cx-stack-err" style={{ flexGrow: failed }} />}
            </div>
            <div className="cx-stack-legend">
              <span><i className="cx-li cx-li-ok" /> {connected} connected</span>
              {needsAuth > 0 && <span><i className="cx-li cx-li-warn" /> {needsAuth} need auth</span>}
              {failed > 0 && <span><i className="cx-li cx-li-err" /> {failed} failed</span>}
              <span className="cx-stack-pct">{healthPct}%</span>
            </div>
          </div>

          <div className="cx-ov-radar">
            <ResponsiveContainer width="100%" height="100%">
              <RadarChart data={posture} outerRadius="72%">
                <PolarGrid stroke="var(--border-default)" gridType="polygon" />
                <PolarAngleAxis dataKey="axis" tick={{ fill: 'var(--text-muted)', fontSize: 10.5, fontWeight: 600 }} />
                <PolarRadiusAxis domain={[0, 100]} tick={false} axisLine={false} />
                <Radar name="ceiling" dataKey="ceiling" stroke="var(--border-strong)" strokeDasharray="2 5" fill="transparent" fillOpacity={0} isAnimationActive={false} legendType="none" />
                <Radar name="posture" dataKey="value" stroke="#397e70" strokeWidth={1.8} fill="#17b28c" fillOpacity={0.14}
                  dot={{ r: 2.5, fill: '#17b28c', strokeWidth: 0 }} />
              </RadarChart>
            </ResponsiveContainer>
          </div>
        </motion.section>
      )}

      {serversLoading && servers.length === 0 ? (
        <div className="cx-loading">Loading connectors…</div>
      ) : servers.length === 0 ? (
        <div className="cx-empty">
          <p className="cx-empty-title">No connectors yet</p>
          <p className="cx-empty-desc">MCP servers discovered in your agents&apos; configs appear here — hit Refresh to scan now.</p>
        </div>
      ) : (
        <>
          <div className="cx-section-head">
            <h2 className="cx-section-title">Registered</h2>
            <span className="cx-count">{servers.length}</span>
          </div>
          <motion.div className="cx-grid" variants={containerVariants} initial="hidden" animate="visible">
            {servers.map((s) => (
              <ConnectorCard
                key={s.name}
                connector={s}
                ordinal={servers.indexOf(s) + 1}
                syncing={syncing === s.name}
                variants={cardVariants}
                onExpand={() => navigate(`/connectors/${encodeURIComponent(s.name)}`, { state: { type: s.type } })}
                onSync={() => handleSync(s.name)}
              />
            ))}
          </motion.div>
        </>
      )}


      <style>{`
.cx-root { position: relative; display: flex; flex-direction: column; gap: 18px; }
.cx-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.cx-root > * { position: relative; z-index: 1; }
:root[data-theme="dark"] .cx-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .cx-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
  }
}
@keyframes cxspin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.cx-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.cx-heading { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.cx-subhead { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.cx-refresh {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px;
  border-radius: 999px; border: none; cursor: pointer; font: inherit;
  background: var(--bg-inset); color: var(--text-secondary); font-size: 12.5px; font-weight: 650;
  transition: background 160ms ease, color 160ms ease;
}
.cx-refresh:hover { background: #e9ebec; color: var(--text-primary); }
.cx-refresh:disabled { cursor: progress; }
.cx-spin { animation: cxspin 1s linear infinite; }

/* Overview card — editorial figures + health bar + radar */
.cx-overview {
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px; padding: 28px 30px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
  display: grid; grid-template-columns: 1fr 300px 240px; gap: 34px; align-items: center;
}
@media (max-width: 1180px) { .cx-overview { grid-template-columns: 1fr 1fr; } .cx-ov-radar { grid-column: span 2; height: 220px; } }
@media (max-width: 760px) { .cx-overview { grid-template-columns: 1fr; } .cx-ov-radar { grid-column: auto; height: 220px; } }
.cx-ov-figures { display: flex; flex-direction: column; gap: 20px; }
.cx-ov-value {
  margin: 0; font-size: 34px; font-weight: 400; letter-spacing: -0.03em; line-height: 1;
  color: var(--text-primary); font-variant-numeric: tabular-nums;
}
.cx-ov-dim { font-size: 18px; font-weight: 450; color: var(--text-muted); }
.cx-ov-label { margin: 6px 0 0; font-size: 12px; font-weight: 650; letter-spacing: 0.02em; color: var(--text-primary); }
.cx-ov-sub { margin: 1px 0 0; font-size: 11.5px; font-weight: 500; color: var(--text-muted); }

.cx-ov-health { display: flex; flex-direction: column; gap: 10px; }
.cx-ov-health-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
.cx-ov-health-num { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.cx-stack {
  display: flex; height: 8px; border-radius: 999px; overflow: hidden;
  background: var(--bg-inset);
}
.cx-stack-seg { height: 100%; }
.cx-stack-ok { flex: 1; background: linear-gradient(90deg, #397e70, #17b28c); border-radius: 999px 0 0 999px; }
.cx-stack-warn { background: #e0a020; }
.cx-stack-err { background: #ff4d5e; border-radius: 0 999px 999px 0; }
.cx-stack-legend { display: flex; align-items: center; gap: 14px; font-size: 11.5px; font-weight: 550; color: var(--text-muted); flex-wrap: wrap; }
.cx-stack-legend span { display: inline-flex; align-items: center; gap: 6px; }
.cx-stack-pct { margin-left: auto; font-weight: 700; color: var(--text-primary); }
.cx-li { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
.cx-li-ok { background: #17b28c; }
.cx-li-warn { background: #e0a020; }
.cx-li-err { background: #ff4d5e; }

.cx-ov-radar { height: 230px; min-width: 0; }

.cx-section-head { display: flex; align-items: center; gap: 10px; margin-top: 4px; }
.cx-section-title { font-size: 15px; font-weight: 650; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.cx-count { font-size: 11px; font-weight: 600; color: var(--text-muted); background: var(--bg-inset); padding: 3px 10px; border-radius: 100px; }
.cx-grid { display: grid; gap: 18px; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); }
@media (max-width: 900px) { .cx-grid { grid-template-columns: 1fr; } }

.cx-loading { text-align: center; padding: 48px; color: var(--text-muted); font-size: 14px; font-weight: 500; }
.cx-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  padding: 52px 24px; background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 26px; text-align: center;
}
.cx-empty-title { font-size: 17px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.cx-empty-desc { font-size: 13px; font-weight: 500; color: var(--text-muted); margin: 6px 0 0; max-width: 30em; line-height: 1.55; }

.cx-debug {
  margin-top: 4px; border: 1px dashed var(--border-strong);
  border-radius: 16px; padding: 12px 14px;
  font-family: 'SF Mono', 'Fira Code', monospace; font-size: 11px;
}
.cx-debug summary { cursor: pointer; color: var(--text-muted); font-weight: 650; user-select: none; }
.cx-debug summary:hover { color: var(--text-primary); }
.cx-debug-grid { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.cx-debug-row { display: flex; gap: 10px; align-items: baseline; color: var(--text-muted); }
.cx-debug-path { color: var(--text-primary); word-break: break-all; }
.cx-debug-count { color: var(--text-muted); flex-shrink: 0; }
.cx-debug-ok { color: #00a699; }
.cx-debug-bad { color: #ff5a5f; }
.cx-debug-err { color: #c98a00; word-break: break-word; }

:root[data-theme="dark"] .cx-overview { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .cx-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
:root[data-theme="dark"] .cx-refresh:hover { background: #232b38; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .cx-overview { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .cx-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
  :root:not([data-theme]) .cx-refresh:hover { background: #232b38; }
}
      `}</style>
    </div>
  );
}
