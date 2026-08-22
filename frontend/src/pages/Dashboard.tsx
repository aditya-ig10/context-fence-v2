import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts';
import { motion, type Variants } from 'framer-motion';
import { RefreshCw } from 'lucide-react';
import { notify } from '../components/Toasts';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';

// InsightHub-style dashboard:
//   [ Agents ] [ Connectors ] [ Calls Audited ] [ Policy Decisions ~2.2x ]
//   [        Recent Activity (table)          ] [ Donut ][ Traffic pie ]
// Orange -> teal -> white -> large white chart creates the visual rhythm;
// every number is real data from the backend APIs.

interface Stats {
  uptime: number;
  agents: number;
  servers: string[];
  policies: number;
  history?: { date: string; calls: number; blocked: number }[];
  calls: { total: number; blocked: number; blockRate: string };
}

interface ServerRow {
  name: string;
  type: string;
  status: 'connected' | 'error' | 'needs-auth';
}

interface DetectedAgent {
  id: string;
  name: string;
  type: string;
  protected?: boolean;
}

interface Bucket {
  label: string;
  allow: number;
  deny: number;
  log: number;
}

interface LogRow {
  id?: string;
  timestamp: string;
  agent?: string;
  tool?: string;
  decision: 'allow' | 'deny' | 'log';
  server?: string | null;
}

type Period = 'today' | '7d' | '30d';

const C = { orange: 'var(--accent-coral)', teal: 'var(--accent-teal)', amber: 'var(--accent-amber)', gray: '#9aa1a9' };

// Card pop-in — identical to the Agents page stagger so every page's cards
// land with the same motion language (opacity + rise + settle scale). The
// explicit duration/ease keeps the pop identical on every navigation.
const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
};

// Stable function domain — the second element being a FUNCTION (never a
// 'auto' <-> number literal flip) keeps the axis from rebuilding between
// period switches, which is what made the chart pop instead of morphing.
const yMax = (max: number): number => Math.max(4, Math.ceil(max * 1.2));

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (Math.abs(n) >= 10000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString();
}

// Audit timestamps are UTC without a timezone marker (SQLite
// datetime('now')) — appending Z makes JS parse them correctly; without it a
// call made seconds ago rendered as "5h ago" for anyone ahead of UTC.
function toUtcDate(ts: string): Date {
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(ts.trim());
  const iso = ts.trim().replace(' ', 'T') + (hasZone ? '' : 'Z');
  return new Date(iso);
}

function fullTime(ts: string): string {
  return toUtcDate(ts).toLocaleString();
}

// Count-up: eases the displayed number from its previous value to the new
// one (ease-out cubic) so KPI figures roll instead of snapping.
function useCountUp(value: number, duration = 900): number {
  const [display, setDisplay] = useState(value);
  const prevRef = useRef(value);
  useEffect(() => {
    const from = prevRef.current;
    prevRef.current = value;
    if (from === value) { setDisplay(value); return; }
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisplay(Math.round(from + (value - from) * eased));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return display;
}

function timeAgo(ts: string): string {
  const secs = Math.floor((Date.now() - toUtcDate(ts).getTime()) / 1000);
  if (secs < 60) return Math.max(0, secs) + 's ago';
  if (secs < 3600) return Math.floor(secs / 60) + 'm ago';
  if (secs < 86400) return Math.floor(secs / 3600) + 'h ago';
  return Math.floor(secs / 86400) + 'd ago';
}

function pctDelta(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return ((current - previous) / previous) * 100;
}

function DecisionText({ decision }: { decision: string }) {
  const color = decision === 'allow' ? C.teal : decision === 'deny' ? C.orange : C.amber;
  const label = decision === 'allow' ? 'Allowed' : decision === 'deny' ? 'Blocked' : 'Logged';
  return <span style={{ color, fontWeight: 650 }}>{label}</span>;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="db-tooltip">
      <p className="db-tooltip-label">{label}</p>
      {payload.map((p: any) => (
        <div key={p.dataKey} className="db-tooltip-row">
          <span className="db-tooltip-dot" style={{ background: p.color || p.stroke }} />
          <span className="db-tooltip-name">
            {p.dataKey === 'allow' ? 'Allowed' : p.dataKey === 'deny' ? 'Blocked' : p.dataKey === 'log' ? 'Logged' : p.name}
          </span>
          <span className="db-tooltip-val">{formatNumber(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  // maxAgeMs keeps the 30s discovery broadcasts from thrashing the numbers —
  // cached data is served within the window, so values only move when the
  // underlying data genuinely changed.
  const statsHook = useCachedFetch<Stats>('stats', () => fetch('/api/stats').then((r) => r.json()), { maxAgeMs: 60_000 });
  const serversHook = useCachedFetch<{ servers: ServerRow[] }>('servers', () =>
    fetch('/api/servers').then((r) => r.json()), { maxAgeMs: 60_000 },
  );
  const detectHook = useCachedFetch<{ agents: DetectedAgent[] }>('detect', () =>
    fetch('/api/detect').then((r) => r.json()), { maxAgeMs: 60_000 },
  );
  const stats = statsHook.data;
  const serversData = serversHook.data;
  const detectData = detectHook.data;

  const [period, setPeriod] = useState<Period>('today');
  const [nonce, setNonce] = useState(0);
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [byServer, setByServer] = useState<{ server: string; calls: number }[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch(`/api/stats/timeline?period=${period}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !Array.isArray(d?.buckets)) return;
        setBuckets((prev) => (JSON.stringify(prev) === JSON.stringify(d.buckets) ? prev : (d.buckets as Bucket[])));
      })
      .catch(() => {});
    load();
    const t = setInterval(load, 30_000); // graphs stay live
    return () => { cancelled = true; clearInterval(t); };
  }, [period, nonce]);

  useEffect(() => {
    let cancelled = false;
    const load = () => fetch('/api/logs?limit=10')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && Array.isArray(d?.logs)) setLogs(d.logs as LogRow[]); })
      .catch(() => {});
    load();
    const t = setInterval(load, 30_000); // keep Recent Activity genuinely recent
    return () => { cancelled = true; clearInterval(t); };
  }, [nonce]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/stats/mcp-usage')
      .then((r) => r.json())
      .then((d) => {
        if (cancelled || !Array.isArray(d?.byServer)) return;
        setByServer(
          (d.byServer as Record<string, unknown>[])
            .map((x) => ({ server: String(x.server ?? x.name ?? '?'), calls: Number(x.calls ?? 0) }))
            .filter((x) => x.server !== '?')
            .slice(0, 5),
        );
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [nonce]);

  const refreshingRef = useRef(false);
  const [refreshing, setRefreshing] = useState(false);
  async function refreshAll() {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    const loadingId = notify.loading('Refreshing dashboard…', 'Fetching the latest stats and activity');
    try {
      invalidateCache((k) => k === 'stats' || k === 'servers' || k === 'detect');
      statsHook.refresh();
      serversHook.refresh();
      detectHook.refresh();
      setNonce((n) => n + 1);
      // refetches are fire-and-forget — give them a beat to land before the swap
      await new Promise((r) => setTimeout(r, 700));
      notify.dismiss(loadingId);
      notify.success('Refreshed successfully', 'Dashboard data is up to date');
    } catch (err) {
      notify.dismiss(loadingId);
      notify.error('Refresh failed', err instanceof Error ? err.message : String(err));
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }

  const agents = detectData?.agents ?? [];
  const servers = serversData?.servers ?? [];
  const connected = servers.filter((s) => s.status === 'connected').length;
  const errored = servers.filter((s) => s.status === 'error').length;
  const needsAuth = servers.filter((s) => s.status === 'needs-auth').length;

  const trend = useMemo(() => {
    const h = stats?.history;
    if (!h || h.length < 8) return null;
    const latest = h[h.length - 1];
    const base = h[h.length - 8];
    // A zero baseline makes the percentage flap between 0% and +100% —
    // show the stable block-rate line instead until there is a real base.
    if (base.calls === 0) return null;
    const d = pctDelta(latest.calls, base.calls);
    return { value: (d >= 0 ? '+' : '') + d.toFixed(1) + '%', up: d >= 0 };
  }, [stats]);

  // "Today" buckets run 0:00 -> now, which is mostly empty canvas early in
  // the day — start the chart at the FIRST hour with a recorded call.
  const visibleBuckets = useMemo(() => {
    if (period !== 'today') return buckets;
    const first = buckets.findIndex((b) => b.allow + b.deny + b.log > 0);
    if (first <= 0) return buckets; // no data yet -> full-day straight line at 0
    return buckets.slice(first);
  }, [buckets, period]);


  const donutData = useMemo(() => ([
    { name: 'Connected', value: connected, color: C.teal },
    { name: 'Error', value: errored, color: C.orange },
    { name: 'Needs auth', value: needsAuth, color: C.amber },
  ]).filter((d) => d.value > 0), [connected, errored, needsAuth]);
  const donutTotal = connected + errored + needsAuth;

  // Only show traffic for connectors that still exist — historical rows for
  // deleted test servers are noise, not signal.
  const agentsCount = useCountUp(agents.length);
  const connectedCount = useCountUp(connected);
  const callsCount = useCountUp(stats?.calls.total ?? 0);
  const donutCount = useCountUp(donutTotal);

  const trafficData = useMemo(() => {
    const registered = new Set(servers.map((s) => s.name));
    return byServer.filter((x) => registered.has(x.server));
  }, [byServer, servers]);
  const trafficTotal = trafficData.reduce((s, x) => s + x.calls, 0);
  const PIE_COLORS = [C.orange, C.teal, C.gray, C.amber, '#c4cad0'];

  return (
    <div className="db-root">
      {/* Slim header: title + real refresh (cache invalidation, no reload) */}
      <header className="db-head">
        <div className="db-head-title">
          <h1 className="db-heading">Dashboard</h1>
          <p className="db-subhead">Live security overview — every number is real data from the backend.</p>
        </div>
        <button className="db-refresh" type="button" onClick={refreshAll} disabled={refreshing} title="Refresh all dashboard data">
          <RefreshCw size={14} className={refreshing ? 'db-spin' : ''} />
          Refresh
        </button>
      </header>

      {/* KPI row: orange -> teal -> white -> big white chart (~2.2x) */}
      <motion.section className="db-kpis" variants={containerVariants} initial="hidden" animate="visible">
        <motion.div className="db-card db-kpi db-kpi-orange" variants={cardVariants}>
          <p className="db-kpi-label">Agents Detected</p>
          <p className="db-kpi-value">{formatNumber(agentsCount)}</p>
          <p className="db-kpi-sub">{agents.filter((a) => a.protected).length} protected through the proxy</p>
        </motion.div>

        <motion.div className="db-card db-kpi db-kpi-teal" variants={cardVariants}>
          <p className="db-kpi-label">MCP Connectors</p>
          <p className="db-kpi-value">{formatNumber(connectedCount)}</p>
          <p className="db-kpi-sub">connected of {servers.length} registered</p>
        </motion.div>

        <motion.div className="db-card db-kpi db-kpi-white" variants={cardVariants}>
          <p className="db-kpi-label">Calls<br />Audited</p>
          <p className="db-kpi-value">{formatNumber(callsCount)}</p>
          {trend ? (
            <p className={'db-kpi-delta ' + (trend.up ? 'up' : 'down')}>
              <svg width="9" height="9" viewBox="0 0 10 10" fill="none">
                <path d={trend.up ? 'M5 1.5l4 5H1z' : 'M5 8.5l-4-5h8z'} fill="currentColor" />
              </svg>
              {trend.value}
              <span className="db-kpi-delta-note">vs last week</span>
            </p>
          ) : (
            <p className="db-kpi-sub">{stats?.calls.blockRate ?? '0%'} block rate</p>
          )}
        </motion.div>

        <motion.div className="db-card db-chartcard" variants={cardVariants}>
          <div className="db-chart-head">
            <div>
              <h3 className="db-h3">Policy Decisions</h3>
              <p className="db-h3-sub">Every MCP call, checked by your rules</p>
            </div>
            <select
              className="db-select"
              value={period}
              onChange={(e) => setPeriod(e.target.value as Period)}
              aria-label="Time range"
            >
              <option value="today">Today</option>
              <option value="7d">7 days</option>
              <option value="30d">30 days</option>
            </select>
          </div>
          <div className="db-chart-body">
            <ResponsiveContainer width="100%" height="100%">
              {/* key flips exactly once — empty -> loaded — so landing replays the
                  draw-in, while period switches keep the chart mounted and the
                  curve MORPHS between datasets instead of restarting. */}
              <AreaChart key={visibleBuckets.length === 0 ? 'empty' : 'loaded'} data={visibleBuckets} margin={{ top: 8, right: 6, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="gAllow" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.teal} stopOpacity={0.16} />
                    <stop offset="95%" stopColor={C.teal} stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gDeny" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={C.orange} stopOpacity={0.14} />
                    <stop offset="95%" stopColor={C.orange} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="label" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} minTickGap={28} />
                <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: '#999999' }} allowDecimals={false} width={44} domain={[0, yMax]} />
                <Tooltip content={<ChartTooltip />} cursor={{ stroke: '#b9bfc5', strokeWidth: 1, strokeDasharray: '4 4' }} />
                <Area type="monotone" dataKey="log" stroke={C.gray} strokeWidth={2} fill="transparent" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} name="Logged" isAnimationActive animationBegin={180} animationDuration={700} animationEasing="ease-out" />
                <Area type="monotone" dataKey="deny" stroke={C.orange} strokeWidth={2.4} fill="url(#gDeny)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} name="Blocked" isAnimationActive animationBegin={180} animationDuration={700} animationEasing="ease-out" />
                <Area type="monotone" dataKey="allow" stroke={C.teal} strokeWidth={2.4} fill="url(#gAllow)" dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: '#fff' }} name="Allowed" isAnimationActive animationBegin={180} animationDuration={700} animationEasing="ease-out" />
              </AreaChart>
            </ResponsiveContainer>

          </div>
        </motion.div>
      </motion.section>

      {/* Bottom: 2fr table + 1fr charts column */}
      <motion.section className="db-bottom" variants={containerVariants} initial="hidden" animate="visible">
        <motion.div className="db-card db-table-card" variants={cardVariants}>
          <div className="db-card-head">
            <div>
              <h3 className="db-h3">Recent Activity</h3>
              <p className="db-h3-sub">Latest MCP calls through the firewall</p>
            </div>
            <Link to="/logs" className="db-pill">View All</Link>
          </div>
          {logs.length === 0 ? (
            <p className="db-empty">No audited calls yet — route an agent through the proxy and activity appears here.</p>
          ) : (
            <table className="db-table">
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Server</th>
                  <th>Agent</th>
                  <th>Decision</th>
                  <th style={{ textAlign: 'right' }}>When</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((row, i) => (
                  <tr key={String(row.id ?? i)}>
                    <td className="db-td-strong">{row.tool || '—'}</td>
                    <td>{row.server || '—'}</td>
                    <td>{row.agent || '—'}</td>
                    <td><DecisionText decision={row.decision} /></td>
                    <td style={{ textAlign: 'right', color: 'var(--text-muted)' }} title={fullTime(row.timestamp)}>{timeAgo(row.timestamp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </motion.div>

        <motion.div className="db-right-col" variants={containerVariants}>
          <motion.div className="db-card db-donut-card" variants={cardVariants}>
            <div className="db-card-head"><h3 className="db-h3">Connector Status</h3></div>
            <div className="db-donut-wrap">
              <ResponsiveContainer width="100%" height={170}>
                <PieChart>
                  <Pie data={donutData} dataKey="value" innerRadius={54} outerRadius={74} paddingAngle={3} strokeWidth={0} startAngle={90} endAngle={-270} isAnimationActive animationBegin={0} animationDuration={700} animationEasing="ease-out">
                    {donutData.map((d) => (<Cell key={d.name} fill={d.color} />))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              {donutTotal > 0 && (
                <div className="db-donut-center">
                  <span className="db-donut-num">{donutCount}</span>
                  <span className="db-donut-cap">connectors</span>
                </div>
              )}
            </div>
            {donutTotal === 0 ? (
              <p className="db-empty">No connectors registered yet.</p>
            ) : (
              <div className="db-legend">
                {donutData.map((d) => (
                  <div key={d.name} className="db-legend-row">
                    <span className="db-dot" style={{ background: d.color }} />
                    <span className="db-legend-name">{d.name}</span>
                    <span className="db-legend-val">{d.value}</span>
                  </div>
                ))}
              </div>
            )}
          </motion.div>

          <motion.div className="db-card db-pie-card" variants={cardVariants}>
            <div className="db-card-head"><h3 className="db-h3">Traffic Share</h3></div>
            {trafficTotal === 0 ? (
              <p className="db-empty">No proxied traffic recorded yet.</p>
            ) : (
              <>
                <div className="db-donut-wrap">
                  <ResponsiveContainer width="100%" height={140}>
                    <PieChart>
                      <Pie data={trafficData} dataKey="calls" nameKey="server" innerRadius={38} outerRadius={60} paddingAngle={2} strokeWidth={0} isAnimationActive animationDuration={700} animationEasing="ease-out">
                        {byServer.map((_, i) => (<Cell key={i} fill={PIE_COLORS[i % PIE_COLORS.length]} />))}
                      </Pie>
                      <Tooltip content={<ChartTooltip />} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="db-legend">
                  {trafficData.map((x, i) => (
                    <div key={x.server} className="db-legend-row">
                      <span className="db-dot" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
                      <span className="db-legend-name">{x.server}</span>
                      <span className="db-legend-val">{Math.round((x.calls / trafficTotal) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        </motion.div>
      </motion.section>

      <style>{`
.db-root { position: relative; display: flex; flex-direction: column; gap: 18px; }
/* Ambient background glow — sits behind every card, never intercepts input */
.db-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.db-root > * { position: relative; z-index: 1; }
:root[data-theme="dark"] .db-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%),
    radial-gradient(520px 400px at 70% 20%, rgba(255, 176, 32, 0.05), transparent 60%);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .db-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%),
      radial-gradient(520px 400px at 70% 20%, rgba(255, 176, 32, 0.05), transparent 60%);
  }
}

/* Slim header */
.db-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.db-heading { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.db-subhead { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.db-refresh {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px;
  border-radius: 999px; border: none; cursor: pointer; font: inherit;
  background: var(--bg-inset); color: var(--text-secondary); font-size: 12.5px; font-weight: 650;
  transition: background 160ms ease, color 160ms ease;
}
.db-refresh:hover { background: #e9ebec; color: var(--text-primary); }
.db-refresh:disabled { cursor: progress; }
.db-spin { animation: dbSpin 1s linear infinite; }
@keyframes dbSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.db-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 28px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}

/* KPI row: 1x 1x 1x 2.2x, deliberately tall (spec ~480px) */
.db-kpis {
  display: grid; gap: 18px; min-height: 480px;
  grid-template-columns: 1fr 1fr 1fr 2.2fr;
}
@media (max-width: 1180px) { .db-kpis { grid-template-columns: 1fr 1fr; } .db-chartcard { grid-column: span 2; } }
@media (max-width: 720px)  { .db-kpis { grid-template-columns: 1fr; } .db-chartcard { grid-column: auto; } }

.db-kpi { display: flex; flex-direction: column; justify-content: space-between; }
.db-kpi-label {
  font-size: clamp(24px, 2vw, 29px); font-weight: 400;
  letter-spacing: -0.02em; line-height: 1.16;
  margin: 0; opacity: 0.96; max-width: 8em;
}
.db-kpi-value {
  font-size: clamp(42px, 4.2vw, 52px); font-weight: 400;
  letter-spacing: -0.03em; line-height: 1.02; margin: 0;
}
.db-kpi-sub { font-size: 12.5px; font-weight: 550; margin: 6px 0 0; opacity: 0.78; }

.db-kpi-orange { background: linear-gradient(160deg, #ff5163, #ff3144); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(255,49,68,0.28); }
.db-kpi-teal   { background: linear-gradient(160deg, #43907f, #397e70); color: #ffffff; border: none; box-shadow: 0 14px 34px rgba(57,126,112,0.26); }
.db-kpi-white  { color: var(--text-primary); }
.db-kpi-white .db-kpi-label { color: var(--text-muted); }
.db-kpi-white .db-kpi-sub { color: var(--text-secondary); }

.db-kpi-delta { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; font-weight: 700; margin: 6px 0 0; }
.db-kpi-white .db-kpi-delta.up   { color: #1e9e6a; }
.db-kpi-white .db-kpi-delta.down { color: var(--accent-coral); }
.db-kpi-delta-note { font-weight: 550; color: var(--text-muted); margin-left: 3px; }

/* Big chart card */
.db-chartcard { display: flex; flex-direction: column; }
.db-chart-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.db-h3 { font-size: 21px; font-weight: 550; letter-spacing: -0.015em; color: var(--text-primary); margin: 0; line-height: 1.25; }
.db-h3-sub { font-size: 12.5px; font-weight: 500; color: var(--text-muted); margin: 3px 0 0; }
.db-select {
  appearance: none; -webkit-appearance: none;
  font-size: 12.5px; font-weight: 600; color: var(--text-secondary);
  background: transparent url("data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.6' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 12px center;
  border: 1px solid var(--border-strong);
  border-radius: 999px; padding: 7px 32px 7px 14px; cursor: pointer;
}
.db-select:focus { outline: none; border-color: var(--accent-coral); }
.db-chart-body { flex: 1; min-height: 260px; }

/* Bottom section */
.db-bottom { display: grid; gap: 18px; grid-template-columns: 2fr 1fr; align-items: stretch; }
.db-bottom > .db-card, .db-bottom > .db-right-col { min-height: 560px; }
@media (max-width: 1180px) { .db-bottom { grid-template-columns: 1fr; } .db-bottom > .db-card, .db-bottom > .db-right-col { min-height: 0; } }
.db-table-card, .db-right-col { min-width: 0; }
.db-right-col { display: flex; flex-direction: column; gap: 18px; }
.db-donut-card, .db-pie-card { flex: 1; display: flex; flex-direction: column; }
.db-donut-card .db-legend, .db-pie-card .db-legend { margin-top: auto; padding-top: 12px; }

.db-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.db-pill {
  font-size: 12.5px; font-weight: 650; color: #ffffff;
  text-decoration: none; background: #111111;
  padding: 10px 20px; border-radius: 999px;
  transition: opacity 160ms ease, transform 160ms ease;
}
.db-pill:hover { opacity: 0.85; }
.db-pill:active { transform: scale(0.97); }

/* Editorial table */
.db-table { width: 100%; border-collapse: collapse; font-size: 15px; }
.db-table th {
  text-align: left; font-size: 11px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  padding: 8px 10px; border-bottom: 1px solid var(--border-strong);
}
.db-table td { padding: 15px 10px; border-bottom: 1px solid rgba(17,17,17,0.04); color: var(--text-secondary); }
.db-table tr:last-child td { border-bottom: none; }
.db-td-strong { color: var(--text-primary); font-weight: 600; }
.db-empty { font-size: 13px; font-weight: 500; color: var(--text-muted); padding: 22px 4px; margin: 0; }

/* Donut + pie cards */
.db-donut-wrap { position: relative; }
.db-donut-center {
  position: absolute; inset: 0; pointer-events: none;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.db-donut-num { font-size: 34px; font-weight: 350; letter-spacing: -0.03em; color: var(--text-primary); line-height: 1; }
.db-donut-cap { font-size: 11px; font-weight: 600; color: var(--text-muted); margin-top: 3px; }
.db-legend { display: flex; flex-direction: column; gap: 9px; margin-top: 10px; }
.db-legend-row { display: flex; align-items: center; gap: 9px; font-size: 13px; }
.db-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.db-legend-name { color: var(--text-secondary); font-weight: 500; }
.db-legend-val { margin-left: auto; color: var(--text-primary); font-weight: 700; font-variant-numeric: tabular-nums; }

/* Floating chart tooltip */
.db-tooltip {
  background: #ffffff; border-radius: 12px; padding: 10px 12px;
  box-shadow: 0 10px 30px rgba(16,24,32,0.14), 0 1px 3px rgba(16,24,32,0.08);
  border: 1px solid var(--border-default); min-width: 130px;
}
.db-tooltip-label { margin: 0 0 6px; font-size: 11px; font-weight: 700; color: var(--text-muted); }
.db-tooltip-row { display: flex; align-items: center; gap: 7px; font-size: 12px; padding: 2px 0; }
.db-tooltip-dot { width: 7px; height: 7px; border-radius: 50%; }
.db-tooltip-name { color: var(--text-secondary); font-weight: 550; }
.db-tooltip-val { margin-left: auto; color: var(--text-primary); font-weight: 750; font-variant-numeric: tabular-nums; }

/* ── Dark mode: neon tint + glow ──────────────────────────────────────────── */
:root[data-theme="dark"] .db-card {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.02), 0 10px 36px rgba(0, 0, 0, 0.5);
}
:root[data-theme="dark"] .db-kpi-orange {
  background: linear-gradient(160deg, #ff4d5e, #e51f33);
  box-shadow: var(--glow-red);
}
:root[data-theme="dark"] .db-kpi-teal {
  background: linear-gradient(160deg, #17b28c, #0e8a6d);
  box-shadow: var(--glow-teal);
}
:root[data-theme="dark"] .db-h3, :root[data-theme="dark"] .db-heading { text-shadow: 0 0 24px rgba(255, 255, 255, 0.08); }
:root[data-theme="dark"] .db-tooltip { background: #161c26; border-color: rgba(255, 255, 255, 0.09); }
:root[data-theme="dark"] .db-pill { background: #f2f5f9; color: #0a0d13; }
:root[data-theme="dark"] .db-pill:hover { opacity: 0.9; }
:root[data-theme="dark"] .db-refresh:hover { background: #232b38; }
:root[data-theme="dark"] .db-select { background-color: var(--bg-inset); }
:root[data-theme="dark"] .db-table td { border-bottom-color: rgba(255, 255, 255, 0.05); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .db-card {
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.02), 0 10px 36px rgba(0, 0, 0, 0.5);
  }
  :root:not([data-theme]) .db-kpi-orange {
    background: linear-gradient(160deg, #ff4d5e, #e51f33);
    box-shadow: var(--glow-red);
  }
  :root:not([data-theme]) .db-kpi-teal {
    background: linear-gradient(160deg, #17b28c, #0e8a6d);
    box-shadow: var(--glow-teal);
  }
  :root:not([data-theme]) .db-tooltip { background: #161c26; border-color: rgba(255, 255, 255, 0.09); }
  :root:not([data-theme]) .db-pill { background: #f2f5f9; color: #0a0d13; }
  :root:not([data-theme]) .db-table td { border-bottom-color: rgba(255, 255, 255, 0.05); }
}
      `}</style>
    </div>
  );
}
