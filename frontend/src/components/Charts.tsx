import { useEffect, useState, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer,
  RadarChart, Radar, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Legend,
} from 'recharts';
import { LOGOS } from '../lib/agentLogos';
import { useCachedFetch } from '../hooks/useCachedFetch';
import ChartTooltip from './ChartTooltip';
import DoughnutChart from './DoughnutChart';

/**
 * Fetches `url` through the shared useCachedFetch layer (N10/N11). Mock data
 * is used ONLY when the fetch itself fails (backend unreachable). A successful
 * response with an empty payload is kept as-is so charts can render a genuine
 * empty state instead of presenting mock numbers as real data.
 */
function useMockableFetch<T>(url: string, mock: T): { data: T | null; isOffline: boolean } {
  const { data, error } = useCachedFetch<T>(url, () =>
    fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))),
  );
  const [mockData, setMockData] = useState<T | null>(null);
  useEffect(() => {
    if (error) setMockData(mock);
  }, [error, mock]);
  return { data: data ?? mockData, isOffline: !!mockData && data === null };
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="chart-card" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240, color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
      {message}
    </div>
  );
}

function OfflineBadge({ isOffline }: { isOffline: boolean }) {
  if (!isOffline) return null;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color: '#f59e0b', background: 'rgba(245,158,11,0.1)', padding: '2px 8px', borderRadius: 100 }}>
      Offline — sample data
    </span>
  );
}

// Calls Over Time — allowed vs blocked calls per bucket with the same
// Today / 7 Days / 30 Days toggle UX as AgentDetail's usage chart. Data from
// /api/stats/timeline?period=..., two series: Allowed (teal) / Blocked (coral),
// rendered as a monotone area chart.
export function ChartCallsOverTime() {
  const [period, setPeriod] = useState<'today' | '7d' | '30d'>('today');
  const { data, isOffline } = useMockableFetch<{
    buckets: { label: string; allow: number; deny: number }[];
  }>(`/api/stats/timeline?period=${period}`, { buckets: [] });
  const chartData = useMemo(() => data?.buckets ?? [], [data]);

  if (chartData.length === 0) {
    return <EmptyChart message="No calls in this period yet" />;
  }

  return (
    <div className="chart-card">
      <div className="chart-card-head">
        <div>
          <p className="chart-title">Calls Over Time</p>
          <p className="chart-subtitle">Allowed vs blocked calls</p>
        </div>
        <div className="chart-range-toggle">
          {(['today', '7d', '30d'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`chart-range-btn ${period === p ? 'active' : ''}`}
            >{p === 'today' ? 'Today' : p === '7d' ? '7 Days' : '30 Days'}</button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="coAllowGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-teal)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent-teal)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="coDenyGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent-coral)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--accent-coral)" stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} minTickGap={20} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--bg-surface-hover)' }} />
          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-muted)' }} />
          <Area type="monotone" dataKey="allow" name="Allowed" stroke="var(--accent-teal)" strokeWidth={2} fill="url(#coAllowGrad)" dot={false} isAnimationActive animationDuration={700} animationEasing="ease-out" />
          <Area type="monotone" dataKey="deny" name="Blocked" stroke="var(--accent-coral)" strokeWidth={2} fill="url(#coDenyGrad)" dot={false} isAnimationActive animationDuration={700} animationEasing="ease-out" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// Policy Outcomes Breakdown — doughnut of allow/deny/log from
// /api/stats/outcomes, window-customisable from Settings (dash_window:
// this-month | 7-day | all-time; dash_categories: CSV of allow,deny,log).
// Both controls are real, stored via PUT /api/settings/:key; the settings
// wiring lives in Settings.tsx. Legend row + hover tooltip with exact counts
// come from the shared ChartTooltip; bottom stat line shows the allow rate
// with a real previous-window trend when one exists. There is deliberately no
// 4th "Skipped" category: audit_log has no skip path (a no-rule-match is an
// allow).
const OUTCOME_WINDOWS = {
  'this-month': { query: 'this-month', label: 'this month' },
  '7-day': { query: '7d', label: 'last 7 days' },
  'all-time': { query: 'all', label: 'all time' },
} as const;

export function ChartPolicyOutcomes() {
  // Dashboard customization from Settings: time window + visible categories,
  // read through the shared 'settings' cache key (Settings writes invalidate
  // it on every PUT, so a chart mount after a change refetches fresh).
  const { data: settingsData, isOffline } = useMockableFetch<{ settings: Record<string, string> }>('/api/settings', { settings: {} });
  const windowKey = (settingsData?.settings?.dash_window as keyof typeof OUTCOME_WINDOWS | undefined) ?? 'this-month';
  const windowDef = OUTCOME_WINDOWS[windowKey] ?? OUTCOME_WINDOWS['this-month'];
  const { data: effective } = useCachedFetch<{
    buckets: { allow: number; deny: number; log: number };
    total: number;
    allowRate: number;
    prevAllowRate: number | null;
    trend: number | null;
    window: string;
  }>(`/api/stats/outcomes?window=${windowDef.query}`, () =>
    fetch(`/api/stats/outcomes?window=${windowDef.query}`).then((r) => r.json()),
  );
  const categoryList = (settingsData?.settings?.dash_categories || 'allow,deny,log')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const chartData = useMemo(() => {
    const b = effective?.buckets ?? { allow: 0, deny: 0, log: 0 };
    const rows = [
      { name: 'Allowed', value: b.allow, key: 'allow' },
      { name: 'Blocked', value: b.deny, key: 'deny' },
      { name: 'Logged', value: b.log, key: 'log' },
    ].filter((d) => d.value > 0 && categoryList.includes(d.key));
    return rows;
  }, [effective, categoryList]);

  if (chartData.length === 0 || !effective || effective.total === 0) {
    return <EmptyChart message="No policy outcomes recorded in this window" />;
  }

  const COLORS = ['var(--accent-teal)', 'var(--accent-coral)', 'var(--accent-amber)'];
  const rate = effective.allowRate;
  const trend = effective.trend;
  const trendUp = trend !== null && trend >= 0;

  return (
    <div className="chart-card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="chart-card-head">
        <div>
          <p className="chart-subtitle">Request Distribution</p>
          <p className="chart-title">Policy Outcomes Breakdown</p>
        </div>
        <OfflineBadge isOffline={isOffline} />
      </div>
      <DoughnutChart data={chartData} colors={COLORS} paddingAngle={3} height={190} />
      <div style={{ display: 'flex', gap: 18, justifyContent: 'center', marginTop: 2 }}>
        {chartData.map((d) => (
          <div key={d.name} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: COLORS[chartData.indexOf(d) % COLORS.length], display: 'inline-block' }} />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{d.name}</span>
            <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text-primary)' }}>{d.value.toLocaleString()}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-default)' }}>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          {trend === null ? (
            <path d="M5 1.5l4 5H1z" fill="var(--text-muted)" />
          ) : trendUp ? (
            <path d="M5 1.5l4 5H1z" fill="var(--accent-teal)" />
          ) : (
            <path d="M5 8.5l-4-5h8z" fill="var(--accent-coral)" />
          )}
        </svg>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-primary)' }}>Allowed rate: {rate.toFixed(1)}%</span>
        {trend !== null && (
          <span style={{ fontSize: 11, fontWeight: 600, color: trendUp ? 'var(--accent-teal)' : 'var(--accent-coral)' }}>
            {trend >= 0 ? '+' : ''}{trend.toFixed(1)}% vs previous {windowKey === '7-day' ? '7 days' : windowKey === 'all-time' ? 'period' : 'month'}
          </span>
        )}
      </div>
    </div>
  );
}

// System Health Metrics — 5-axis radar (Latency, Throughput, Reliability,
// Coverage, Efficiency), each axis a real computation documented on the
// backend (/api/stats/health). BLOCKED series over the current 24h (coral).
// Coverage is a rule-presence metric; blocked reliability is the share of
// proxy failures correctly surfaced as deny rows. The bottom stat shows the
// blocked average over the full scale.
export function ChartSystemHealth() {
  const { data, isOffline } = useMockableFetch<{
    axes: { key: string; label: string; allowed: number | null; blocked: number | null; minSamples: number }[];
    average: { allowed: number; blocked: number };
  }>('/api/stats/health', { axes: [], average: { allowed: 0, blocked: 0 } });

  const chartData = useMemo(
    () => (data?.axes ?? []).map((a) => ({ axis: a.label, blocked: a.blocked ?? 0 })),
    [data],
  );

  if (chartData.length === 0) {
    return <EmptyChart message="Health metrics unavailable" />;
  }

  return (
    <div className="chart-card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="chart-card-head">
        <div>
          <p className="chart-subtitle">Performance</p>
          <p className="chart-title">System Health Metrics</p>
        </div>
        <OfflineBadge isOffline={isOffline} />
      </div>
      {chartData.length === 0 ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 230, color: 'var(--text-muted)', fontSize: 13, fontWeight: 600 }}>
          Health metrics unavailable
        </div>
      ) : (
        <ResponsiveContainer width="100%" height={230}>
          <RadarChart data={chartData}>
            <PolarGrid stroke="var(--chart-grid)" strokeDasharray="3 3" />
            <PolarAngleAxis dataKey="axis" tick={{ fontSize: 11, fill: 'var(--text-muted)', fontWeight: 600 }} />
            <PolarRadiusAxis tick={false} axisLine={false} domain={[0, 100]} />
            <Tooltip content={<ChartTooltip />} />
            <Radar name="Blocked" dataKey="blocked" stroke="var(--accent-coral)" fill="var(--accent-coral)" fillOpacity={0.22} strokeWidth={2} isAnimationActive animationDuration={700} animationEasing="ease-out" />
            <Legend wrapperStyle={{ fontSize: 11, color: 'var(--text-muted)' }} />
          </RadarChart>
        </ResponsiveContainer>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14, marginTop: 10, paddingTop: 12, borderTop: '1px solid var(--border-default)' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--accent-coral)' }}>
          Blocked avg: {Math.round(data?.average?.blocked ?? 0)}/100
        </span>
      </div>
    </div>
  );
}

// Compact "Most frequently denied tools (last 7 days)" card — deliberately the
// small d-card shell (same size as the MCP Servers / Active Policies cards),
// NOT the full-width chart-card, so it sits in a grid row with the Most
// Active Agent card.
export function ChartDeniedTools() {
  const { data, isOffline } = useMockableFetch<{ tools: { tool: string; count: number }[] }>('/api/stats/top-tools', { tools: [] });
  const tools = useMemo(() => (data?.tools ?? []).slice(0, 5), [data]);

  const max = Math.max(...tools.map((t) => t.count), 1);

  return (
    <div className="d-card" style={{ '--accent': 'var(--accent-coral)' } as React.CSSProperties}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="d-card-label">Denied Tools</span>
        <OfflineBadge isOffline={isOffline} />
      </div>
      <p style={{ margin: '4px 0 12px', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
        Most frequently denied (last 7 days)
      </p>
      {tools.length === 0 ? (
        <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', padding: '12px 0' }}>
          No blocked tools in the last 7 days
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {tools.map((t, i) => (
            <div key={t.tool} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ width: 130, flexShrink: 0, fontSize: 12, fontWeight: 650, color: 'var(--text-primary)', fontFamily: 'SF Mono, Fira Code, monospace', textAlign: 'right', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.tool}</span>
              <div style={{ flex: 1, height: 14, borderRadius: 100, background: 'var(--bg-inset)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: `${(t.count / max) * 100}%`,
                    borderRadius: 100,
                    background: `linear-gradient(90deg, ${i % 3 === 0 ? 'var(--accent-coral)' : i % 3 === 1 ? 'var(--accent-amber)' : 'var(--accent-teal)'}, transparent 130%)`,
                    opacity: 0.85,
                    transition: 'width 800ms cubic-bezier(0.22, 1, 0.36, 1)',
                  }}
                />
              </div>
              <span style={{ width: 36, flexShrink: 0, fontSize: 12, fontWeight: 800, color: 'var(--text-primary)', textAlign: 'right' }}>{t.count}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Most Active Agent — real winner from /api/stats/most-active (sessions +
// messages across detected agent stats; see final report for metric choice).
export function ChartMostActiveAgent() {
  const { data, isOffline } = useMockableFetch<{
    winner: { name: string; type: string; score: number; sessions: number; messages: number; tokensTotal: number } | null;
  }>('/api/stats/most-active', { winner: null });
  const winner = data?.winner;

  if (!winner) {
    return <EmptyChart message="No agent usage data detected yet" />;
  }

  const logo = LOGOS[winner.type.toLowerCase()] || LOGOS[winner.name.toLowerCase()];
  return (
    <div className="chart-card" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="chart-card-head">
        <div>
          <p className="chart-title">Most Active Agent</p>
          <p className="chart-subtitle">Ranked by sessions + messages</p>
        </div>
        <OfflineBadge isOffline={isOffline} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '12px 4px', flex: 1 }}>
        <div style={{ width: 56, height: 56, borderRadius: 18, overflow: 'hidden', background: 'var(--bg-surface)', border: '1px solid var(--card-border)', boxShadow: 'var(--card-shadow)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          {logo ? (
            <img src={logo} alt={winner.name} style={{ width: 32, height: 32, objectFit: 'contain' }} />
          ) : (
            <span style={{ fontSize: 22, fontWeight: 800, color: 'var(--accent-coral)' }}>{winner.name.charAt(0)}</span>
          )}
        </div>
        <div style={{ minWidth: 0 }}>
          <p style={{ margin: 0, fontSize: 16, fontWeight: 750, color: 'var(--text-primary)' }}>{winner.name}</p>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            {winner.score.toLocaleString()} sessions + messages
          </p>
          <p style={{ margin: '4px 0 0', fontSize: 12, fontWeight: 500, color: 'var(--text-muted)' }}>
            {winner.sessions.toLocaleString()} sessions · {winner.messages.toLocaleString()} messages · {(winner.tokensTotal / 1_000_000).toFixed(1)}M tokens
          </p>
        </div>
      </div>
    </div>
  );
}
