import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import {
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Tooltip as RechartsTooltip,
} from 'recharts';
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  RefreshCw,
  Server,
  Terminal,
  Activity,
  CheckCircle2,
  AlertTriangle,
  ChevronDown,
  ArrowUpRight,
  Zap,
  Lock,
  Layers,
  Database,
  Globe,
  GitBranch,
  Cpu,
  Trash2,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { useCountUp } from '../hooks/useCountUp';
import { notify } from '../components/Toasts';
import { invalidateCache } from '../hooks/useCachedFetch';
import { getConnectorIcon } from '../lib/connectorIcons';

// ─── Types & Interfaces ──────────────────────────────────────────────────────

interface ThreatVariant {
  reason: string;
  count: number;
}

interface TopThreat {
  name: string;
  total: number;
  variants: ThreatVariant[];
}

interface ConnectedService {
  name: string;
  type: string;
  url: string | null;
  command: string | null;
  connected: number;
  last_check: string | null;
}

interface RecentActivity {
  id: string;
  timestamp: string;
  agent: string;
  tool: string;
  method: string;
  decision: 'allow' | 'deny' | 'log' | string;
  reason: string | null;
  duration_ms: number;
}

interface FirewallSummary {
  enabled: boolean;
  stats: {
    calls: number;
    blocked: number;
    blockRate: string;
  };
  activeRules: number;
  uptime: number;
  topThreats: TopThreat[];
  connectedServices: ConnectedService[];
  recentActivity: RecentActivity[];
  protection?: {
    detected: number;
    protected: number;
  };
}

const EMPTY_SUMMARY: FirewallSummary = {
  enabled: true,
  stats: { calls: 0, blocked: 0, blockRate: '0%' },
  activeRules: 0,
  uptime: 0,
  topThreats: [],
  connectedServices: [],
  recentActivity: [],
  protection: { detected: 0, protected: 0 },
};

// ─── Color Palette & Motion Variants ─────────────────────────────────────────

const C = {
  coral: 'var(--accent-coral)',
  teal: 'var(--accent-teal)',
  amber: 'var(--accent-amber)',
  gray: '#9aa1a9',
};

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
  },
};

const SERVICE_ICONS: Record<string, typeof Database> = {
  filesystem: Database,
  puppeteer: Globe,
  github: GitBranch,
  'sequential-thinking': Cpu,
  memory: Terminal,
};

// ─── Formatters & Helpers ────────────────────────────────────────────────────

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (Math.abs(n) >= 10_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function formatUptime(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
  return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
}

function humanizeRuleName(name: string): string {
  return name
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── Subcomponents ───────────────────────────────────────────────────────────

function StatKpiCard({
  label,
  value,
  subtext,
  variant,
  icon: Icon,
}: {
  label: string;
  value: number;
  subtext?: string;
  variant: 'orange' | 'teal' | 'white';
  icon?: typeof Shield;
}) {
  const count = useCountUp(value);
  const isOrange = variant === 'orange';
  const isTeal = variant === 'teal';

  return (
    <motion.div
      className={`fw-card fw-kpi-card ${isOrange ? 'fw-kpi-orange' : isTeal ? 'fw-kpi-teal' : 'fw-kpi-white'}`}
      variants={cardVariants}
      whileHover={{ y: -2, transition: { duration: 0.2 } }}
    >
      <div className="fw-kpi-top">
        <span className="fw-kpi-label">{label}</span>
        {Icon && (
          <div className="fw-kpi-icon-pill">
            <Icon size={16} strokeWidth={2} />
          </div>
        )}
      </div>
      <div className="fw-kpi-body">
        <p className="fw-kpi-value">{formatNumber(count)}</p>
        {subtext && <p className="fw-kpi-subtext">{subtext}</p>}
      </div>
    </motion.div>
  );
}

function DonutTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const data = payload[0];
  return (
    <div className="fw-chart-tooltip">
      <div className="fw-tooltip-row">
        <span className="fw-tooltip-dot" style={{ background: data.payload.color }} />
        <span className="fw-tooltip-name">{data.name}</span>
        <span className="fw-tooltip-val">{formatNumber(data.value)}</span>
      </div>
    </div>
  );
}

// ─── Main Firewall Component ─────────────────────────────────────────────────

export default function Firewall() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<FirewallSummary>(EMPTY_SUMMARY);
  const [enabled, setEnabled] = useState(() => localStorage.getItem('fw_enabled') !== 'false');
  const [expandedThreat, setExpandedThreat] = useState<number | null>(null);
  const [summaryError, setSummaryError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchSummary = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    try {
      const res = await fetch('/api/firewall/summary');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSummary(data);
      setEnabled(data.enabled);
      setSummaryError(false);
      if (isManual) notify.success('Firewall state synchronized');
    } catch {
      setSummaryError(true);
      if (isManual) notify.error('Failed to sync firewall status');
    } finally {
      if (isManual) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (!cancelled) fetchSummary(false);
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [fetchSummary]);

  const toggleFirewall = useCallback(async () => {
    const next = !enabled;
    setEnabled(next);
    localStorage.setItem('fw_enabled', String(next));

    try {
      const res = await fetch('/api/settings/firewall_enabled', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: String(next) }),
      });
      if (!res.ok) throw new Error('Update failed');
      notify.success(next ? 'MCP Firewall activated' : 'MCP Firewall paused (pass-through mode)');
      fetchSummary(false);
    } catch {
      const reverted = !next;
      setEnabled(reverted);
      localStorage.setItem('fw_enabled', String(reverted));
      notify.error('Failed to update firewall state');
    }
  }, [enabled, fetchSummary]);

  // Complete MCP Server Deletion with Sonner Confirm Dialog
  const confirmDeleteServer = useCallback((serverName: string) => {
    toast.custom(
      (tId) => (
        <div className="cf-glass-toast cf-glass-toast--warn fw-delete-toast">
          <span className="cf-glass-toast-icon">
            <AlertTriangle size={16} strokeWidth={2.2} />
          </span>
          <div className="cf-glass-toast-body" style={{ flex: 1 }}>
            <p className="cf-glass-toast-title">Remove {serverName}?</p>
            <p className="cf-glass-toast-msg">
              This will unbind, stop, and completely delete the MCP server.
            </p>
            <div className="fw-toast-actions">
              <button
                className="fw-toast-btn-danger"
                onClick={async () => {
                  toast.dismiss(tId);
                  const loadId = notify.loading(`Removing ${serverName}...`);
                  try {
                    const res = await fetch(`/api/servers/${encodeURIComponent(serverName)}`, {
                      method: 'DELETE',
                    });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    notify.dismiss(loadId);
                    notify.success(`Removed ${serverName}`, 'Server uninstalled successfully');
                    invalidateCache((k) => k === 'servers' || k.startsWith('server:'));
                    fetchSummary(false);
                  } catch {
                    notify.dismiss(loadId);
                    notify.error(`Failed to remove ${serverName}`);
                  }
                }}
              >
                Delete Server
              </button>
              <button
                className="fw-toast-btn-cancel"
                onClick={() => toast.dismiss(tId)}
              >
                Cancel
              </button>
            </div>
          </div>
          <button
            className="cf-glass-toast-close"
            onClick={() => toast.dismiss(tId)}
            aria-label="Dismiss"
          >
            <X size={13} />
          </button>
        </div>
      ),
      { duration: 10000 }
    );
  }, [fetchSummary]);

  // Calculations
  const allowedCount = Math.max(0, summary.stats.calls - summary.stats.blocked);
  const totalCalls = summary.stats.calls;
  const passRate = totalCalls > 0 ? `${((allowedCount / totalCalls) * 100).toFixed(1)}%` : '100%';

  const avgLatency = useMemo(() => {
    if (!summary.recentActivity.length) return 0;
    const sum = summary.recentActivity.reduce((acc, ev) => acc + (ev.duration_ms || 0), 0);
    return Math.round(sum / summary.recentActivity.length);
  }, [summary.recentActivity]);

  const pieData = useMemo(() => {
    if (totalCalls === 0) {
      return [{ name: 'No Calls', value: 1, color: 'var(--border-default)' }];
    }
    return [
      { name: 'Allowed', value: allowedCount, color: C.teal },
      { name: 'Blocked', value: summary.stats.blocked, color: C.coral },
    ].filter((d) => d.value > 0);
  }, [totalCalls, allowedCount, summary.stats.blocked]);

  const protectedAgents = summary.protection?.protected ?? 0;
  const detectedAgents = summary.protection?.detected ?? 0;
  const unprotectedCount = Math.max(0, detectedAgents - protectedAgents);

  return (
    <div className="fw-root">
      {/* ─── Slim Header ─── */}
      <div className="fw-header-strip">
        <div className="fw-header-left">
          <div className="fw-title-wrap">
            <h1 className="fw-heading">MCP Firewall</h1>
            <span className={`fw-status-pill ${enabled ? 'active' : 'paused'}`}>
              <span className="fw-status-dot" />
              {enabled ? 'Active Defense' : 'Bypass Mode'}
            </span>
          </div>
          <p className="fw-subhead">
            {enabled ? (
              <>
                Real-time security proxy &middot;{' '}
                <span className="fw-subhead-highlight">
                  {protectedAgents} of {detectedAgents}
                </span>{' '}
                agents protected
                {unprotectedCount > 0 && ` (${unprotectedCount} bypassing proxy)`}
              </>
            ) : (
              'Firewall is currently paused — tool calls are permitted without rule inspection.'
            )}
          </p>
        </div>

        <div className="fw-header-actions">
          <button
            className="fw-utility-btn"
            onClick={() => fetchSummary(true)}
            disabled={refreshing}
            title="Refresh firewall data"
          >
            <RefreshCw size={13} className={refreshing ? 'fw-spin' : ''} />
            <span>Sync</span>
          </button>
          <button
            className="fw-utility-btn"
            onClick={() => navigate('/marketplace')}
            title="Install new MCP servers"
          >
            <Plus size={13} strokeWidth={2.2} />
            <span>Marketplace</span>
          </button>
          <button
            className="fw-pill-btn"
            onClick={() => navigate('/policies')}
          >
            <span>Manage Rules</span>
            <ArrowUpRight size={13} strokeWidth={2.2} />
          </button>
        </div>
      </div>

      {summaryError && (
        <motion.div
          className="fw-error-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <AlertTriangle size={15} />
          <span>Backend unreachable &mdash; displaying cached telemetry.</span>
        </motion.div>
      )}

      {/* ─── Hero Cinematic 16:9 Control Center (The Breathing Circular Shield) ─── */}
      <motion.div
        className={`fw-hero-16-9 ${enabled ? 'is-active' : 'is-paused'}`}
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        {/* Background Atmospheric Grid & Radial Aura */}
        <div className="fw-16-9-grid-bg" />
        <div className="fw-16-9-ambient-glow" />

        {/* Top Floating Control Bar */}
        <div className="fw-16-9-topbar">
          <div className="fw-16-9-status-group">
            <span className={`fw-16-9-status-badge ${enabled ? 'active' : 'paused'}`}>
              <span className={`fw-status-pulse ${enabled ? 'on' : ''}`} />
              {enabled ? 'PROXY DEFENSE RUNNING' : 'PROXY BYPASSED'}
            </span>
            <span className="fw-16-9-pill">
              PORT <span className="fw-port-mono">:3001</span>
            </span>
            <span className="fw-16-9-pill fw-hide-mobile">
              <Zap size={11} strokeWidth={2.2} /> &lt;4.2ms avg latency
            </span>
          </div>

          <motion.button
            type="button"
            role="switch"
            aria-checked={enabled}
            className={`fw-16-9-toggle ${enabled ? 'is-enabled' : 'is-disabled'}`}
            onClick={toggleFirewall}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 450, damping: 25 }}
            title={enabled ? 'Pause firewall enforcement' : 'Enable firewall enforcement'}
          >
            <motion.span
              className="fw-16-9-toggle-thumb"
              layout
              transition={{ type: 'spring', stiffness: 500, damping: 30 }}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={enabled ? 'lock' : 'zap'}
                  initial={{ scale: 0.4, rotate: enabled ? -45 : 45, opacity: 0 }}
                  animate={{ scale: 1, rotate: 0, opacity: 1 }}
                  exit={{ scale: 0.4, rotate: enabled ? 45 : -45, opacity: 0 }}
                  transition={{ duration: 0.18, ease: 'easeOut' }}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                  {enabled ? <Lock size={13} strokeWidth={2.4} /> : <Zap size={13} strokeWidth={2.4} />}
                </motion.span>
              </AnimatePresence>
            </motion.span>

            <div className="fw-16-9-toggle-text-wrap">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={enabled ? 'pause' : 'enable'}
                  className="fw-16-9-toggle-text"
                  initial={{ opacity: 0, y: enabled ? 8 : -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: enabled ? -8 : 8 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                >
                  {enabled ? 'Pause Defense' : 'Enable Defense'}
                </motion.span>
              </AnimatePresence>
            </div>
          </motion.button>
        </div>

        {/* Center Stage: The Hypnotic Circular Breathing Radar Core */}
        <div className="fw-16-9-radar-stage">
          {enabled && (
            <>
              {/* Outer Pulse Wave 1 */}
              <motion.div
                className="fw-radar-wave wave-1"
                animate={{
                  scale: [1, 1.8, 2.5],
                  opacity: [0.4, 0.15, 0],
                }}
                transition={{
                  duration: 3.6,
                  repeat: Infinity,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
              {/* Outer Pulse Wave 2 */}
              <motion.div
                className="fw-radar-wave wave-2"
                animate={{
                  scale: [1, 1.5, 2.1],
                  opacity: [0.45, 0.2, 0],
                }}
                transition={{
                  duration: 3.6,
                  repeat: Infinity,
                  delay: 1.2,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
              {/* Delayed Pulse Wave 3 */}
              <motion.div
                className="fw-radar-wave wave-3"
                animate={{
                  scale: [1, 1.3, 1.7],
                  opacity: [0.55, 0.25, 0],
                }}
                transition={{
                  duration: 3.6,
                  repeat: Infinity,
                  delay: 2.4,
                  ease: [0.22, 1, 0.36, 1],
                }}
              />
              {/* Orbital Rotating Dashed Ring */}
              <motion.div
                className="fw-radar-dashed-orbit"
                animate={{ rotate: 360 }}
                transition={{
                  duration: 24,
                  repeat: Infinity,
                  ease: 'linear',
                }}
              />
              {/* Sweeping Radar Scanner Line */}
              <motion.div
                className="fw-radar-sweep"
                animate={{ rotate: 360 }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  ease: 'linear',
                }}
              />
            </>
          )}

          {/* Central Frosted Glass Shield Orb */}
          <motion.div
            className={`fw-center-orb ${enabled ? 'active' : 'paused'}`}
            animate={
              enabled
                ? {
                    scale: [1, 1.06, 1],
                    boxShadow: [
                      '0 0 24px rgba(0, 166, 153, 0.22)',
                      '0 0 52px rgba(0, 166, 153, 0.48)',
                      '0 0 24px rgba(0, 166, 153, 0.22)',
                    ],
                  }
                : { scale: 1, boxShadow: 'none' }
            }
            transition={
              enabled
                ? { duration: 3.2, repeat: Infinity, ease: 'easeInOut' }
                : { duration: 0.3 }
            }
          >
            {enabled ? (
              <ShieldCheck size={44} strokeWidth={1.8} className="fw-orb-icon" />
            ) : (
              <ShieldOff size={44} strokeWidth={1.8} className="fw-orb-icon" />
            )}
          </motion.div>
        </div>

        {/* Bottom Hero Narrative & Feature Pills */}
        <div className="fw-16-9-footer">
          <div className="fw-16-9-title-box">
            <h2 className="fw-16-9-title">
              {enabled ? 'Firewall Interception Active' : 'Firewall Paused (Pass-Through)'}
            </h2>
            <p className="fw-16-9-desc">
              {enabled
                ? 'Every tool call is intercepted on ingress port 3001, inspected in real-time against active security rules, and committed to the audit ledger.'
                : 'Tool requests route directly to upstream MCP servers without policy checks or credential mitigation.'}
            </p>
          </div>

          <div className="fw-16-9-pills">
            <span className="fw-16-9-subpill">
              <span className="fw-pill-dot" /> Zero-Trust Gateway
            </span>
            <span className="fw-16-9-subpill">
              <span className="fw-pill-dot" /> AST Schema Validation
            </span>
            <span className="fw-16-9-subpill">
              <span className="fw-pill-dot" /> Credential Leak Defense
            </span>
            <span className="fw-16-9-subpill fw-hide-mobile">
              <span className="fw-pill-dot" /> SQLite WAL Audit Ledger
            </span>
          </div>
        </div>
      </motion.div>

      {/* ─── KPI Band (ui-2.0 Rhythm: Orange -> Teal -> White -> White) ─── */}
      <motion.section
        className="fw-kpi-grid"
        variants={containerVariants}
        initial="hidden"
        animate="visible"
      >
        <StatKpiCard
          label="Requests Blocked"
          value={summary.stats.blocked}
          subtext={`${summary.stats.blockRate} block rate`}
          variant="orange"
          icon={ShieldAlert}
        />
        <StatKpiCard
          label="Requests Allowed"
          value={allowedCount}
          subtext={`${passRate} passed security checks`}
          variant="teal"
          icon={ShieldCheck}
        />
        <StatKpiCard
          label="Active Security Rules"
          value={summary.activeRules}
          subtext="Enforced across tools"
          variant="white"
          icon={Layers}
        />
        <StatKpiCard
          label="Avg Decision Latency"
          value={avgLatency}
          subtext={`Uptime: ${formatUptime(summary.uptime)}`}
          variant="white"
          icon={Activity}
        />
      </motion.section>

      {/* ─── Mid Split: Top Threats & Rule Breakdown ─── */}
      <div className="fw-main-split">
        {/* Left: Top Blocked Security Threats */}
        <motion.div
          className="fw-card fw-threats-card"
          variants={cardVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
        >
          <div className="fw-card-header">
            <div>
              <h3 className="fw-card-title">Top Security Threats</h3>
              <p className="fw-card-sub">Blocked policy triggers &middot; last 7 days</p>
            </div>
            <span className="fw-card-counter-badge">
              {summary.topThreats.length} rules triggered
            </span>
          </div>

          {summary.topThreats.length === 0 ? (
            <div className="fw-empty-state">
              <div className="fw-empty-icon">
                <CheckCircle2 size={24} strokeWidth={1.5} color="var(--accent-teal)" />
              </div>
              <p className="fw-empty-title">Zero Threats Detected</p>
              <p className="fw-empty-desc">No malicious or policy-violating tool calls in this period.</p>
            </div>
          ) : (
            <div className="fw-threats-list">
              {summary.topThreats.map((threat, idx) => {
                const maxTotal = summary.topThreats[0]?.total || 1;
                const riskPct = Math.min(100, Math.round((threat.total / maxTotal) * 100));
                const isExpanded = expandedThreat === idx;
                const hasVariants = threat.variants && threat.variants.length > 1;

                return (
                  <div key={threat.name} className="fw-threat-item">
                    <button
                      className={`fw-threat-row ${hasVariants ? 'expandable' : ''} ${isExpanded ? 'is-open' : ''}`}
                      onClick={hasVariants ? () => setExpandedThreat(isExpanded ? null : idx) : undefined}
                      aria-expanded={hasVariants ? isExpanded : undefined}
                    >
                      <div className="fw-threat-meta">
                        <span className="fw-threat-name">{humanizeRuleName(threat.name)}</span>
                        <span className="fw-threat-count">{threat.total} blocked</span>
                      </div>

                      <div className="fw-threat-track">
                        <motion.div
                          className="fw-threat-fill"
                          initial={{ width: 0 }}
                          whileInView={{ width: `${riskPct}%` }}
                          viewport={{ once: true }}
                          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                          style={{
                            background:
                              riskPct > 75
                                ? 'var(--accent-coral)'
                                : riskPct > 40
                                ? 'var(--accent-amber)'
                                : 'var(--accent-teal)',
                          }}
                        />
                      </div>

                      <div className="fw-threat-badge-wrap">
                        <span
                          className="fw-threat-pill"
                          style={{
                            color:
                              riskPct > 75
                                ? 'var(--accent-coral)'
                                : riskPct > 40
                                ? 'var(--accent-amber)'
                                : 'var(--accent-teal)',
                          }}
                        >
                          {riskPct}% impact
                        </span>
                        {hasVariants && (
                          <span className={`fw-threat-chevron ${isExpanded ? 'open' : ''}`}>
                            <ChevronDown size={14} />
                          </span>
                        )}
                      </div>
                    </button>

                    <AnimatePresence>
                      {isExpanded && hasVariants && (
                        <motion.div
                          className="fw-threat-variants"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                        >
                          {threat.variants.map((v, vIdx) => (
                            <div key={vIdx} className="fw-variant-row">
                              <span className="fw-variant-reason">{v.reason}</span>
                              <span className="fw-variant-count">{v.count}</span>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          )}
        </motion.div>

        {/* Right: Policy Enforcement Breakdown (Donut) */}
        <motion.div
          className="fw-card fw-donut-card"
          variants={cardVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true }}
        >
          <div className="fw-card-header">
            <div>
              <h3 className="fw-card-title">Enforcement Distribution</h3>
              <p className="fw-card-sub">Allowed vs Blocked requests</p>
            </div>
          </div>

          <div className="fw-donut-container">
            <div className="fw-chart-box">
              <ResponsiveContainer width="100%" height={180}>
                <PieChart>
                  <RechartsTooltip content={<DonutTooltip />} />
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={54}
                    outerRadius={74}
                    paddingAngle={3}
                    dataKey="value"
                    strokeWidth={0}
                    animationDuration={750}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>

              <div className="fw-donut-center-label">
                <span className="fw-donut-total">{formatNumber(totalCalls)}</span>
                <span className="fw-donut-caption">Total Calls</span>
              </div>
            </div>

            <div className="fw-donut-legend">
              <div className="fw-legend-row">
                <div className="fw-legend-left">
                  <span className="fw-legend-dot" style={{ background: C.teal }} />
                  <span className="fw-legend-text">Allowed</span>
                </div>
                <span className="fw-legend-val">{formatNumber(allowedCount)}</span>
              </div>
              <div className="fw-legend-row">
                <div className="fw-legend-left">
                  <span className="fw-legend-dot" style={{ background: C.coral }} />
                  <span className="fw-legend-text">Blocked</span>
                </div>
                <span className="fw-legend-val">{formatNumber(summary.stats.blocked)}</span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* ─── Connected MCP Services Matrix with Delete Actions ─── */}
      <div className="fw-section-head">
        <div>
          <h2 className="fw-section-title">Connected MCP Services</h2>
          <p className="fw-section-desc">Managed proxy endpoints & server health</p>
        </div>
        <span className="fw-section-badge">
          {summary.connectedServices.filter((s) => s.connected).length} of{' '}
          {summary.connectedServices.length} Active
        </span>
      </div>

      <motion.div
        className="fw-services-grid"
        variants={containerVariants}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true }}
      >
        {summary.connectedServices.map((svc) => {
          const IconComp = getConnectorIcon(svc.name);
          const isOnline = Boolean(svc.connected);

          return (
            <motion.div
              key={svc.name}
              className={`fw-service-card ${isOnline ? 'online' : 'offline'}`}
              variants={cardVariants}
              whileHover={{ y: -2, transition: { duration: 0.18 } }}
            >
              <div className="fw-svc-top">
                <div className="fw-svc-icon-tile">
                  <IconComp size={16} strokeWidth={1.8} />
                </div>
                <div className="fw-svc-top-actions">
                  <span className={`fw-svc-status-dot ${isOnline ? 'online' : 'offline'}`} />
                  <button
                    type="button"
                    className="fw-svc-delete-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      confirmDeleteServer(svc.name);
                    }}
                    title={`Delete ${svc.name} server`}
                    aria-label={`Delete ${svc.name} server`}
                  >
                    <Trash2 size={13} strokeWidth={1.8} />
                  </button>
                </div>
              </div>

              <div className="fw-svc-info">
                <p className="fw-svc-name">{svc.name}</p>
                <div className="fw-svc-tags">
                  <span className="fw-svc-tag">
                    <Terminal size={10} /> {svc.type}
                  </span>
                  <span className={`fw-svc-tag ${isOnline ? 'tag-ok' : 'tag-warn'}`}>
                    <Activity size={10} /> {isOnline ? 'Connected' : 'Offline'}
                  </span>
                </div>
              </div>
            </motion.div>
          );
        })}

        {/* Explore Marketplace CTA Card */}
        <motion.div
          className="fw-service-card fw-add-service-card"
          variants={cardVariants}
          whileHover={{ y: -2, transition: { duration: 0.18 } }}
          onClick={() => navigate('/marketplace')}
          role="button"
          tabIndex={0}
        >
          <div className="fw-add-card-inner">
            <div className="fw-add-icon-circle">
              <Plus size={18} strokeWidth={2.4} />
            </div>
            <p className="fw-add-card-title">Install MCP Server</p>
            <p className="fw-add-card-sub">Browse catalog & 1-click install</p>
          </div>
        </motion.div>
      </motion.div>

      {/* ─── Styles ─── */}
      <style>{`
/* ───── Root & Ambient Atmosphere ───── */
.fw-root {
  position: relative;
  max-width: 1404px;
  margin: 0 auto;
  padding-bottom: 56px;
  animation: fwFadeIn 0.35s ease-out;
}

.fw-root::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 0;
  background:
    radial-gradient(560px 420px at 8% 5%, rgba(255, 49, 68, 0.05), transparent 65%),
    radial-gradient(680px 500px at 92% 90%, rgba(57, 126, 112, 0.06), transparent 65%);
}

@keyframes fwFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ───── Header Strip ───── */
.fw-header-strip {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 24px;
}

.fw-title-wrap {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 6px;
}

.fw-heading {
  font-size: 24px;
  font-weight: 650;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  margin: 0;
}

.fw-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.fw-status-pill.active {
  background: rgba(57, 126, 112, 0.12);
  color: var(--accent-teal);
}

.fw-status-pill.paused {
  background: var(--bg-inset);
  color: var(--text-muted);
}

.fw-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.fw-status-pill.active .fw-status-dot {
  background: var(--accent-teal);
  box-shadow: 0 0 6px var(--accent-teal);
}

.fw-status-pill.paused .fw-status-dot {
  background: var(--text-muted);
}

.fw-subhead {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.45;
}

.fw-subhead-highlight {
  color: var(--text-primary);
  font-weight: 600;
}

.fw-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.fw-utility-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 14px;
  border-radius: 999px;
  background: var(--bg-inset);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.fw-utility-btn:hover:not(:disabled) {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
  transform: translateY(-1px);
}

.fw-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 38px;
  padding: 0 16px;
  border-radius: 999px;
  background: var(--accent-coral);
  color: #ffffff;
  border: none;
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
  box-shadow: 0 4px 14px rgba(255, 49, 68, 0.22);
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.fw-pill-btn:hover {
  transform: scale(1.02) translateY(-1px);
  box-shadow: 0 6px 18px rgba(255, 49, 68, 0.3);
}

.fw-spin {
  animation: fwSpin 0.9s linear infinite;
}

@keyframes fwSpin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.fw-error-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(255, 49, 68, 0.08);
  border: 1px solid rgba(255, 49, 68, 0.2);
  color: var(--accent-coral);
  padding: 10px 16px;
  border-radius: 14px;
  font-size: 12.5px;
  font-weight: 600;
  margin-bottom: 20px;
}

/* ───── Cinematic 16:9 Hero Control Center ───── */
.fw-hero-16-9 {
  position: relative;
  z-index: 1;
  width: 100%;
  aspect-ratio: 16 / 9;
  min-height: 420px;
  max-height: 520px;
  border-radius: 28px;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  box-shadow: 0 4px 32px rgba(0, 0, 0, 0.04), 0 1px 3px rgba(0, 0, 0, 0.02);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 26px 32px;
  margin-bottom: 24px;
  transition: border-color 300ms ease, box-shadow 300ms ease;
}

@media (max-width: 768px) {
  .fw-hero-16-9 {
    aspect-ratio: auto;
    min-height: 480px;
    padding: 20px;
  }
}

.fw-hero-16-9.is-active {
  border-color: rgba(0, 166, 153, 0.32);
}

/* Background Cyber Matrix & Radial Aura */
.fw-16-9-grid-bg {
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-size: 32px 32px;
  background-image:
    linear-gradient(to right, rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(to bottom, rgba(255, 255, 255, 0.035) 1px, transparent 1px);
  mask-image: radial-gradient(circle at 50% 50%, black 25%, transparent 75%);
  -webkit-mask-image: radial-gradient(circle at 50% 50%, black 25%, transparent 75%);
}

.fw-16-9-ambient-glow {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 460px;
  height: 460px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(0, 166, 153, 0.14) 0%, transparent 70%);
  pointer-events: none;
  filter: blur(36px);
}

/* Top Floating Bar */
.fw-16-9-topbar {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.fw-16-9-status-group {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.fw-16-9-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.06em;
  padding: 5px 12px;
  border-radius: 999px;
  text-transform: uppercase;
}

.fw-16-9-status-badge.active {
  background: rgba(0, 166, 153, 0.12);
  color: #00a699;
  border: 1px solid rgba(0, 166, 153, 0.3);
  box-shadow: 0 0 12px rgba(0, 166, 153, 0.15);
}

.fw-16-9-status-badge.paused {
  background: var(--bg-inset);
  color: var(--text-muted);
  border: 1px solid var(--border-default);
}

.fw-16-9-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  font-weight: 650;
  color: var(--text-muted);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  padding: 4px 11px;
  border-radius: 999px;
}

.fw-port-mono {
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-weight: 750;
  color: var(--text-primary);
}

/* Master Toggle */
.fw-16-9-toggle {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  padding: 0 16px 0 6px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-inset);
  cursor: pointer;
  transition: background 0.3s cubic-bezier(0.22, 1, 0.36, 1),
              border-color 0.3s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  user-select: none;
}

.fw-16-9-toggle:hover {
  border-color: var(--border-strong);
  background: var(--bg-surface-hover, var(--card-bg));
}

.fw-16-9-toggle.is-enabled {
  background: rgba(0, 166, 153, 0.12);
  border-color: rgba(0, 166, 153, 0.4);
  box-shadow: 0 0 16px rgba(0, 166, 153, 0.18);
}

.fw-16-9-toggle.is-disabled {
  background: var(--bg-inset);
  border-color: var(--border-default);
  box-shadow: none;
}

.fw-16-9-toggle-thumb {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.3s cubic-bezier(0.22, 1, 0.36, 1),
              box-shadow 0.3s cubic-bezier(0.22, 1, 0.36, 1);
  flex-shrink: 0;
}

.fw-16-9-toggle.is-enabled .fw-16-9-toggle-thumb {
  background: #00a699;
  color: #ffffff;
  box-shadow: 0 2px 10px rgba(0, 166, 153, 0.5);
}

.fw-16-9-toggle.is-disabled .fw-16-9-toggle-thumb {
  background: var(--border-strong);
  color: var(--text-primary);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.15);
}

.fw-16-9-toggle-text-wrap {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  min-width: 95px;
  height: 20px;
  overflow: hidden;
  position: relative;
}

.fw-16-9-toggle-text {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary);
  white-space: nowrap;
}

/* ───── Center Hypnotic Radar Stage ───── */
.fw-16-9-radar-stage {
  position: absolute;
  top: 48%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 220px;
  height: 220px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  z-index: 3;
}

.fw-radar-wave {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1.5px solid rgba(0, 166, 153, 0.45);
  pointer-events: none;
}

.fw-radar-dashed-orbit {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  border: 1.5px dashed rgba(0, 166, 153, 0.3);
  pointer-events: none;
}

.fw-radar-sweep {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, rgba(0, 166, 153, 0.2) 0deg, transparent 60deg, transparent 360deg);
  pointer-events: none;
  mask-image: radial-gradient(circle, transparent 40px, black 41px);
  -webkit-mask-image: radial-gradient(circle, transparent 40px, black 41px);
}

/* Center Frosted Glass Orb */
.fw-center-orb {
  position: relative;
  z-index: 10;
  width: 92px;
  height: 92px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  transition: all 0.3s ease;
  pointer-events: auto;
  cursor: default;
}

.fw-center-orb.active {
  background: radial-gradient(circle at 35% 30%, rgba(255, 255, 255, 0.15), var(--bg-inset) 75%);
  color: #00a699;
  border: 2px solid rgba(0, 166, 153, 0.5);
}

.fw-center-orb.paused {
  background: var(--bg-inset);
  color: var(--text-muted);
  border: 2px solid var(--border-default);
}

.fw-orb-icon {
  filter: drop-shadow(0 2px 8px rgba(0, 166, 153, 0.35));
}

/* ───── Bottom Hero Narrative & Feature Pills ───── */
.fw-16-9-footer {
  position: relative;
  z-index: 5;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
}

.fw-16-9-title-box {
  flex: 1;
  min-width: 280px;
}

.fw-16-9-title {
  font-size: 22px;
  font-weight: 800;
  letter-spacing: -0.03em;
  color: var(--text-primary);
  margin: 0 0 4px;
  line-height: 1.2;
}

.fw-16-9-desc {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.45;
  max-width: 580px;
}

.fw-16-9-pills {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.fw-16-9-subpill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  font-weight: 650;
  color: var(--text-secondary);
  background: var(--bg-inset);
  border: 1px solid var(--border-default);
  padding: 4px 10px;
  border-radius: 8px;
}

.fw-pill-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: #00a699;
  box-shadow: 0 0 6px #00a699;
}

.fw-status-pulse {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-muted);
  display: inline-block;
}

.fw-status-pulse.on {
  background: #00a699;
  box-shadow: 0 0 8px #00a699;
  animation: fwPulse 2.4s ease-in-out infinite;
}

@keyframes fwPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(0.85); }
}

@media (max-width: 860px) {
  .fw-hide-mobile {
    display: none !important;
  }
}

/* ───── Shared Card Base ───── */
.fw-card {
  position: relative;
  z-index: 1;
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  padding: 28px;
  box-shadow: var(--card-shadow);
}

.fw-card-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 20px;
}

.fw-card-title {
  font-size: 16.5px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  margin: 0 0 2px;
}

.fw-card-sub {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text-muted);
  margin: 0;
}

.fw-card-counter-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--bg-inset);
  padding: 4px 10px;
  border-radius: 999px;
}

/* ───── KPI Band (ui-2.0 Rhythm) ───── */
.fw-kpi-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 18px;
  margin-bottom: 20px;
}

.fw-kpi-card {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-height: 140px;
  padding: 24px;
}

.fw-kpi-orange {
  background: linear-gradient(160deg, #ff5163, #ff3144);
  color: #ffffff;
  border: none;
  box-shadow: 0 12px 30px rgba(255, 49, 68, 0.25);
}

.fw-kpi-orange .fw-kpi-label,
.fw-kpi-orange .fw-kpi-subtext {
  color: rgba(255, 255, 255, 0.85);
}

.fw-kpi-orange .fw-kpi-value {
  color: #ffffff;
}

.fw-kpi-orange .fw-kpi-icon-pill {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.fw-kpi-teal {
  background: linear-gradient(160deg, #43907f, #397e70);
  color: #ffffff;
  border: none;
  box-shadow: 0 12px 30px rgba(57, 126, 112, 0.25);
}

.fw-kpi-teal .fw-kpi-label,
.fw-kpi-teal .fw-kpi-subtext {
  color: rgba(255, 255, 255, 0.85);
}

.fw-kpi-teal .fw-kpi-value {
  color: #ffffff;
}

.fw-kpi-teal .fw-kpi-icon-pill {
  background: rgba(255, 255, 255, 0.18);
  color: #ffffff;
}

.fw-kpi-white .fw-kpi-label {
  color: var(--text-muted);
}

.fw-kpi-white .fw-kpi-value {
  color: var(--text-primary);
}

.fw-kpi-white .fw-kpi-subtext {
  color: var(--text-secondary);
}

.fw-kpi-white .fw-kpi-icon-pill {
  background: var(--bg-inset);
  color: var(--text-muted);
}

.fw-kpi-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.fw-kpi-label {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.fw-kpi-icon-pill {
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fw-kpi-body {
  margin-top: 14px;
}

.fw-kpi-value {
  font-size: 34px;
  font-weight: 400;
  letter-spacing: -0.03em;
  line-height: 1;
  margin: 0 0 6px;
  font-variant-numeric: tabular-nums;
}

.fw-kpi-subtext {
  font-size: 11.5px;
  font-weight: 500;
  margin: 0;
}

/* ───── Main Split (2fr / 1.2fr) ───── */
.fw-main-split {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: 2fr 1.2fr;
  gap: 18px;
  margin-bottom: 24px;
}

/* ───── Top Threats List ───── */
.fw-threats-list {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.fw-threat-item {
  border-radius: 16px;
  background: var(--bg-surface-hover);
  padding: 12px 16px;
  transition: all 0.2s ease;
}

.fw-threat-item:hover {
  background: var(--bg-inset);
}

.fw-threat-row {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0;
  font-family: inherit;
}

.fw-threat-row.expandable {
  cursor: pointer;
}

.fw-threat-meta {
  width: 170px;
  flex-shrink: 0;
}

.fw-threat-name {
  display: block;
  font-size: 13px;
  font-weight: 650;
  color: var(--text-primary);
  line-height: 1.3;
}

.fw-threat-count {
  display: block;
  font-size: 11px;
  font-weight: 500;
  color: var(--text-muted);
}

.fw-threat-track {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-inset);
  overflow: hidden;
}

.fw-threat-fill {
  height: 100%;
  border-radius: 999px;
}

.fw-threat-badge-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.fw-threat-pill {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: -0.01em;
}

.fw-threat-chevron {
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.25s cubic-bezier(0.22, 1, 0.36, 1);
}

.fw-threat-chevron.open {
  transform: rotate(180deg);
}

.fw-threat-variants {
  overflow: hidden;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--border-default);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.fw-variant-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 11.5px;
}

.fw-variant-reason {
  color: var(--text-secondary);
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fw-variant-count {
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

/* ───── Donut Chart ───── */
.fw-donut-container {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.fw-chart-box {
  position: relative;
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.fw-donut-center-label {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  pointer-events: none;
}

.fw-donut-total {
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text-primary);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.fw-donut-caption {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-muted);
  margin-top: 4px;
}

.fw-donut-legend {
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
  padding-top: 14px;
  border-top: 1px solid var(--border-default);
}

.fw-legend-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12.5px;
}

.fw-legend-left {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fw-legend-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
}

.fw-legend-text {
  color: var(--text-secondary);
  font-weight: 500;
}

.fw-legend-val {
  font-weight: 700;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.fw-chart-tooltip {
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 6px 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
}

.fw-tooltip-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-primary);
}

.fw-tooltip-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.fw-tooltip-val {
  font-variant-numeric: tabular-nums;
  margin-left: 4px;
}

/* ───── Section Head ───── */
.fw-section-head {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin: 32px 0 16px;
}

.fw-section-title {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: -0.015em;
  color: var(--text-primary);
  margin: 0;
}

.fw-section-desc {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  margin: 2px 0 0;
}

.fw-section-badge {
  font-size: 11px;
  font-weight: 700;
  color: var(--text-muted);
  background: var(--bg-inset);
  padding: 4px 10px;
  border-radius: 999px;
}

/* ───── Connected Services Grid ───── */
.fw-services-grid {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 14px;
  margin-bottom: 24px;
}

.fw-service-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 20px;
  padding: 18px;
  box-shadow: var(--card-shadow);
  transition: all 0.2s ease;
}

.fw-service-card:hover {
  border-color: var(--border-strong);
}

.fw-svc-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.fw-svc-icon-tile {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  background: var(--bg-inset);
  color: var(--text-primary);
  display: flex;
  align-items: center;
  justify-content: center;
}

.fw-svc-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.fw-svc-status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
}

.fw-svc-status-dot.online {
  background: var(--accent-teal);
  box-shadow: 0 0 6px var(--accent-teal);
}

.fw-svc-status-dot.offline {
  background: var(--accent-amber);
}

.fw-svc-delete-btn {
  background: transparent;
  border: none;
  padding: 4px;
  border-radius: 6px;
  color: var(--text-muted);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.18s ease;
}

.fw-svc-delete-btn:hover {
  color: var(--accent-coral);
  background: rgba(255, 49, 68, 0.1);
  transform: scale(1.08);
}

.fw-svc-name {
  font-size: 13.5px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.fw-svc-tags {
  display: flex;
  align-items: center;
  gap: 6px;
}

.fw-svc-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-muted);
  background: var(--bg-inset);
  padding: 2px 7px;
  border-radius: 6px;
}

.fw-svc-tag.tag-ok {
  color: var(--accent-teal);
  background: rgba(57, 126, 112, 0.08);
}

.fw-svc-tag.tag-warn {
  color: var(--accent-amber);
  background: rgba(222, 145, 29, 0.08);
}

/* ───── Add Service CTA Card ───── */
.fw-add-service-card {
  border: 1.5px dashed var(--border-strong);
  background: var(--bg-surface-hover);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  text-align: center;
}

.fw-add-service-card:hover {
  border-color: var(--accent-teal);
  background: rgba(57, 126, 112, 0.04);
}

.fw-add-card-inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 6px 0;
}

.fw-add-icon-circle {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(57, 126, 112, 0.12);
  color: var(--accent-teal);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  transition: transform 0.2s ease;
}

.fw-add-service-card:hover .fw-add-icon-circle {
  transform: scale(1.1);
}

.fw-add-card-title {
  font-size: 12.5px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 2px;
}

.fw-add-card-sub {
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text-muted);
  margin: 0;
}

/* ───── Delete Toast Confirmation ───── */
.fw-delete-toast {
  min-width: 330px;
}

.fw-toast-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}

.fw-toast-btn-danger {
  background: var(--accent-coral);
  color: #ffffff;
  border: none;
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 11.5px;
  font-weight: 700;
  cursor: pointer;
  transition: opacity 0.18s ease;
}

.fw-toast-btn-danger:hover {
  opacity: 0.9;
}

.fw-toast-btn-cancel {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
  border-radius: 6px;
  padding: 5px 12px;
  font-size: 11.5px;
  font-weight: 600;
  cursor: pointer;
}

.fw-toast-btn-cancel:hover {
  background: var(--bg-surface-hover);
  color: var(--text-primary);
}

/* ───── Empty State ───── */
.fw-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 40px 20px;
}

.fw-empty-icon {
  margin-bottom: 8px;
}

.fw-empty-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-primary);
  margin: 4px 0 2px;
}

.fw-empty-desc {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-muted);
  max-width: 320px;
  margin: 0;
}

/* ───── Dark Mode 2.0 Overrides ───── */
:root[data-theme="dark"] .fw-root::before {
  background:
    radial-gradient(560px 420px at 8% 5%, rgba(255, 49, 68, 0.12), transparent 65%),
    radial-gradient(680px 500px at 92% 90%, rgba(47, 230, 176, 0.1), transparent 65%);
}

:root[data-theme="dark"] .fw-kpi-orange {
  background: linear-gradient(160deg, #ff4d5e, #e51f33);
  box-shadow: 0 12px 32px rgba(255, 49, 68, 0.35);
}

:root[data-theme="dark"] .fw-kpi-teal {
  background: linear-gradient(160deg, #17b28c, #0e8a6d);
  box-shadow: 0 12px 32px rgba(47, 230, 176, 0.28);
}

:root[data-theme="dark"] .fw-shield-core.active {
  background: linear-gradient(145deg, rgba(47, 230, 176, 0.22), rgba(47, 230, 176, 0.08));
  box-shadow: 0 0 32px rgba(47, 230, 176, 0.3);
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .fw-root::before {
    background:
      radial-gradient(560px 420px at 8% 5%, rgba(255, 49, 68, 0.12), transparent 65%),
      radial-gradient(680px 500px at 92% 90%, rgba(47, 230, 176, 0.1), transparent 65%);
  }

  :root:not([data-theme]) .fw-kpi-orange {
    background: linear-gradient(160deg, #ff4d5e, #e51f33);
    box-shadow: 0 12px 32px rgba(255, 49, 68, 0.35);
  }

  :root:not([data-theme]) .fw-kpi-teal {
    background: linear-gradient(160deg, #17b28c, #0e8a6d);
    box-shadow: 0 12px 32px rgba(47, 230, 176, 0.28);
  }

  :root:not([data-theme]) .fw-shield-core.active {
    background: linear-gradient(145deg, rgba(47, 230, 176, 0.22), rgba(47, 230, 176, 0.08));
    box-shadow: 0 0 32px rgba(47, 230, 176, 0.3);
  }
}

/* ───── Responsive Layout ───── */
@media (max-width: 1180px) {
  .fw-kpi-grid {
    grid-template-columns: repeat(2, 1fr);
  }
  .fw-main-split {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 768px) {
  .fw-header-strip {
    flex-direction: column;
    align-items: stretch;
  }
  .fw-hero-inner {
    flex-direction: column;
    align-items: stretch;
  }
  .fw-master-toggle {
    width: 100%;
    justify-content: center;
  }
  .fw-kpi-grid {
    grid-template-columns: 1fr;
  }
}
      `}</style>
    </div>
  );
}
