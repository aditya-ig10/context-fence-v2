/**
 * Audit Log — InsightHub redesign (matches Dashboard / Agents / Settings).
 *
 *   ambient-glow root -> slim header (+ Export pill)
 *   -> live status strip: Audited · Blocked · Block rate · Viewing · Stream
 *   -> toolbar: decision segmented control + env-context chip
 *   -> editorial table card (column resize kept, badges restyled)
 *
 * Behavior preserved 1:1 from the previous page: same cache keys and 15s
 * security staleness window, realtime fallback polling, agent identity
 * rendering rules, audit-rule prefill navigation, and Excel-style column
 * resizing.
 */
import { useRef, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, type Variants } from 'framer-motion';
import { Download, ShieldPlus, Server, ChevronLeft, ChevronRight } from 'lucide-react';
import { useCachedFetch } from '../hooks/useCachedFetch';
import { isRealtimeConnected } from '../hooks/useRealtimeSync';
import { LOGOS } from '../lib/agentLogos';
import { auditCoverage, auditPrefill } from '../lib/auditRule';
import type { PolicyRuleLike } from '../lib/auditRule';

interface AuditEntry {
  id: string;
  timestamp: string;
  agent: string;
  tool: string;
  method: string;
  params: string;
  decision: string;
  reason: string;
  duration_ms: number;
  server?: string | null;
  env?: boolean;
}

interface StatsData {
  calls?: { total: number; blocked: number; blockRate: string };
}

// Agent column is driven by the PROXY's real identity tagging (P11-N5):
//   - a client that completed the MCP initialize handshake on a TCP
//     connection is labeled with its declared clientInfo.name
//   - "api:<server>" rows are calls made by this dashboard's API against a
//     registered MCP server (shown as the server it targeted)
//   - "tcp:addr:port" / anything unrecognized means the caller never
//     declared an identity — show an honest muted "Unknown source" badge
function AgentCell({ agent }: { agent: string }) {
  if (agent.startsWith('api:')) {
    const server = agent.slice(4);
    return (
      <div className="au-agent">
        <span className="au-agent-ico"><Server size={12} /></span>
        <span className="au-agent-name" title={`Dashboard call → server: ${server}`}>{server}</span>
      </div>
    );
  }
  if (agent.startsWith('tcp:')) {
    return (
      <div className="au-agent">
        <span className="au-unknown">Unknown</span>
        <span className="au-tcp" title={agent}>{agent.replace('tcp:', '')}</span>
      </div>
    );
  }
  const logoKey = Object.keys(LOGOS).find((k) => agent.toLowerCase().includes(k));
  if (logoKey) {
    return (
      <div className="au-agent">
        <img src={LOGOS[logoKey]} alt="" referrerPolicy="no-referrer" className="au-logo" />
        <span className="au-agent-name">{agent}</span>
      </div>
    );
  }
  return (
    <div className="au-agent">
      <span className="au-unknown">Unknown source</span>
    </div>
  );
}

// audit_log timestamps are stored by the proxy as SQLite datetime('now'),
// i.e. UTC "YYYY-MM-DD HH:MM:SS" — parse them as UTC so the relative label
// is exact, and show the raw value verbatim (+ " UTC") as the exact label.
function parseUtc(ts: string): Date {
  return new Date(ts.replace(' ', 'T') + 'Z');
}

function timeAgo(ts: string): string {
  const secs = Math.floor((Date.now() - parseUtc(ts).getTime()) / 1000);
  if (secs < 60) return `${Math.max(0, secs)}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

const COLUMNS = [
  { key: 'time', label: 'Time', width: 150 },
  { key: 'agent', label: 'Agent', width: 210 },
  { key: 'tool', label: 'Tool', width: 200 },
  { key: 'decision', label: 'Decision', width: 120 },
  { key: 'duration', label: 'Duration', width: 100 },
  { key: 'reason', label: 'Reason', width: 340 },
  { key: 'action', label: '', width: 110 },
];

const MIN_COL_WIDTH = 80;
const MAX_COL_WIDTH = 700;

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.05 } },
};
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 20, scale: 0.97 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] } },
};
const EASE = [0.22, 1, 0.36, 1] as const;

const DECISION_LABELS: Record<string, string> = { allow: 'Allowed', deny: 'Blocked', log: 'Logged' };

export default function AuditLog() {
  const [filter, setFilter] = useState('');
  const [envOnly, setEnvOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [colWidths, setColWidths] = useState<Record<string, number>>(() =>
    Object.fromEntries(COLUMNS.map((c) => [c.key, c.width])),
  );
  const [resizingKey, setResizingKey] = useState<string | null>(null);
  const resize = useRef<{ key: string; startX: number; startWidth: number } | null>(null);
  const navigate = useNavigate();

  // Excel-style column resize: drag the handle on a header to change that
  // column's width. Pointer events on the window so the drag survives cursor
  // movement outside the header; body cursor + selection are suppressed for
  // the duration of the drag.
  function startResize(e: React.PointerEvent, key: string) {
    e.preventDefault();
    resize.current = { key, startX: e.clientX, startWidth: colWidths[key] };
    setResizingKey(key);
    const onMove = (ev: PointerEvent) => {
      const r = resize.current;
      if (!r) return;
      const next = Math.round(
        Math.min(MAX_COL_WIDTH, Math.max(MIN_COL_WIDTH, r.startWidth + (ev.clientX - r.startX))),
      );
      setColWidths((w) => ({ ...w, [r.key]: next }));
    };
    const onUp = () => {
      resize.current = null;
      setResizingKey(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }

  // Short staleness window (15s): log data is security-relevant, so a stale
  // entry from another tab must reflect fresh denies within seconds (N12).
  const { data, loading, refresh } = useCachedFetch<{ logs: AuditEntry[]; total: number }>(`logs:${filter}:${envOnly}:${page}`, () => {
    const params = new URLSearchParams();
    if (filter) params.set('decision', filter);
    if (envOnly) params.set('env', '1');
    params.set('limit', '20');
    params.set('page', String(page));
    return fetch(`/api/logs?${params}`).then((r) => r.json());
  }, { maxAgeMs: 15_000 });
  const entries = data?.logs ?? [];
  const total = data?.total ?? 0;

  // All-time rollups for the status strip (same numbers the Dashboard KPI uses).
  const { data: statsData } = useCachedFetch<StatsData>('stats', () =>
    fetch('/api/stats').then((r) => r.json()), { maxAgeMs: 60_000 });

  // Realtime fallback: the /ws push channel makes new env/deny rows appear
  // instantly, but if it is down (packaged static server, proxy hiccup) the
  // audit page must still converge — poll every 5s until the channel returns.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (isRealtimeConnected()) return;
    const timer = setInterval(() => refreshRef.current(), 5_000);
    return () => clearInterval(timer);
  }, []);

  // Registered connectors — used to tell whether an entry's server still
  // exists before offering a rule (a deleted connector still matches by
  // name, but the user should know). Shared cache key with the Connectors
  // page; the realtime WS keeps it fresh.
  const { data: serversData } = useCachedFetch<{ servers: { name: string }[] }>('servers', () =>
    fetch('/api/servers').then((r) => r.json()));
  const servers = serversData?.servers ?? [];
  const { data: rulesData } = useCachedFetch<{ rules: PolicyRuleLike[] }>('policies', () =>
    fetch('/api/policies').then((r) => r.json()), { maxAgeMs: 15_000 });
  const rules = rulesData?.rules ?? [];

  function handleCreateRule(e: AuditEntry) {
    const coverage = auditCoverage(e, rules);
    const serverExists = !e.server || servers.some((s) => s.name === e.server);
    navigate('/policies', {
      state: {
        new: true,
        prefill: auditPrefill(e),
        fromAudit: { id: e.id, timestamp: e.timestamp, covered: coverage, serverExists },
      },
    });
  }

  const callsTotal = statsData?.calls?.total ?? 0;
  const callsBlocked = statsData?.calls?.blocked ?? 0;
  const blockRate = statsData?.calls?.blockRate ?? '0%';
  const live = isRealtimeConnected();
  const envCount = entries.filter((e) => e.env).length;

  return (
    <div className="au-root">
      {/* Slim header */}
      <header className="au-head">
        <div>
          <h1 className="au-heading">Audit Log</h1>
          <p className="au-subhead">Every MCP call through the firewall — policy-checked and recorded.</p>
        </div>
        <a href="/api/logs/export" className="au-export" title="Download the full audit log as a file">
          <Download size={14} />
          Export
        </a>
      </header>

      {/* Live status strip */}
      <motion.section
        className="au-card au-strip"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        <div className="au-cell">
          <p className="au-cell-key">Calls audited</p>
          <p className="au-cell-val">{callsTotal.toLocaleString()}</p>
        </div>
        <div className="au-cell">
          <p className="au-cell-key">Blocked all-time</p>
          <p className="au-cell-val au-warn">{callsBlocked.toLocaleString()}</p>
        </div>
        <div className="au-cell">
          <p className="au-cell-key">Block rate</p>
          <p className="au-cell-val">{blockRate}</p>
        </div>
        <div className="au-cell">
          <p className="au-cell-key">Viewing</p>
          <p className="au-cell-val">
            {entries.length.toLocaleString()} <em>of {total.toLocaleString()}</em>
          </p>
        </div>
        <div className="au-cell au-cell-last">
          <p className="au-cell-key">Stream</p>
          <p className={`au-cell-val au-stream${live ? '' : ' off'}`}>
            <span className={live ? 'au-pulse' : 'au-dot-flat'} />
            {live ? 'Live' : 'Polling'}
            {envOnly && envCount > 0 && <em>{envCount} env-flagged</em>}
          </p>
        </div>
      </motion.section>

      {/* Toolbar */}
      <motion.div
        className="au-toolbar"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        <div className="au-seg" role="radiogroup" aria-label="Filter by decision">
          {[['', 'All'], ['allow', 'Allowed'], ['deny', 'Blocked'], ['log', 'Logged']].map(([value, text]) => (
            <button
              key={value}
              className={`au-seg-btn d-${value || 'all'}${filter === value ? ' active' : ''}`}
              onClick={() => { setFilter(value); setPage(1); }}
              role="radio"
              aria-checked={filter === value}
            >
              {text}
            </button>
          ))}
        </div>
        <button
          onClick={() => { setEnvOnly(!envOnly); if (filter) setFilter(''); setPage(1); }}
          className={`au-chip${envOnly ? ' on' : ''}`}
          title="Env/API/JWT context was read in a session — rows blocked or flagged by the env-context block / secret context filter"
        >
          <span className="au-chip-dot" />
          Env / Secret context
        </button>
      </motion.div>

      {/* Table */}
      <motion.div
        className={`au-card au-tablecard${entries.length === 0 ? ' empty' : ''}`}
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        {entries.length === 0 ? (
          <div className="au-empty">
            <div className="au-empty-icon">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M3 11h18M3 11l2-6h14l2 6M5 11v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9M9 17h6"/></svg>
            </div>
            <p className="au-empty-title">{loading ? 'Loading audit entries…' : 'No audit entries'}</p>
            <p className="au-empty-desc">
              {loading
                ? 'Fetching the latest decisions from the firewall.'
                : filter || envOnly
                  ? 'Nothing matches the current filters — clear them to see the full log.'
                  : 'Route an agent through the proxy and every call shows up here.'}
            </p>
          </div>
        ) : (
          <div className="au-table-scroll">
            <table className="au-table">
              <colgroup>
                {COLUMNS.map((c) => (
                  <col key={c.key} style={{ width: colWidths[c.key] }} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {COLUMNS.map((c) => (
                    <th key={c.key}>
                      {c.label}
                      <span
                        className={`au-resize-handle${resizingKey === c.key ? ' au-resizing' : ''}`}
                        onPointerDown={(e) => startResize(e, c.key)}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td>
                      <div className="au-time" title={`${e.timestamp} UTC`}>
                        <span className="au-time-ago">{timeAgo(e.timestamp)}</span>
                        <span className="au-time-raw">{e.timestamp}</span>
                      </div>
                    </td>
                    <td><AgentCell agent={e.agent} /></td>
                    <td><span className="au-tool" title={e.tool}>{e.tool}</span></td>
                    <td>
                      <span className={`au-badge b-${e.decision}`}>
                        <span className="au-badge-dot" />
                        {DECISION_LABELS[e.decision] ?? e.decision}
                      </span>
                    </td>
                    <td><span className="au-duration" title={`${e.duration_ms}ms`}>{e.duration_ms}ms</span></td>
                    <td>
                      <span className="au-reason" title={e.reason}>
                        {e.env && (
                          <span className="au-envbadge" title="Env/API/JWT context was read in this session — blocked or flagged by the firewall">
                            ENV
                          </span>
                        )}
                        <span className="au-reason-text">{e.reason}</span>
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button
                        className="au-blockbtn"
                        onClick={() => handleCreateRule(e)}
                        title={
                          auditCoverage(e, rules)?.kind === 'context-filter'
                            ? 'Already blocked by the built-in context filter — create a variant anyway'
                            : auditCoverage(e, rules)?.kind === 'rule'
                              ? `Already blocked by "${auditCoverage(e, rules)?.ruleName}" — create a variant anyway`
                              : `Block ${e.tool}${e.server ? ` on ${e.server}` : ''} going forward`
                        }
                      >
                        <ShieldPlus size={12} />
                        <span>Block</span>
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {total > 0 && (
          <div className="au-pagination">
            <span className="au-page-info">
              Showing <span className="au-page-bold">{total === 0 ? 0 : (page - 1) * 20 + 1}–{Math.min(page * 20, total)}</span> of <span className="au-page-bold">{total.toLocaleString()}</span> entries
            </span>

            <div className="au-page-controls">
              <button
                type="button"
                className="au-page-btn"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                title="Previous 20 entries"
              >
                <ChevronLeft size={14} />
                <span>Previous</span>
              </button>

              <span className="au-page-curr">
                Page {page} of {Math.max(1, Math.ceil(total / 20))}
              </span>

              <button
                type="button"
                className="au-page-btn"
                onClick={() => setPage((p) => Math.min(Math.ceil(total / 20), p + 1))}
                disabled={page >= Math.ceil(total / 20) || loading}
                title="Next 20 entries"
              >
                <span>Next</span>
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}
      </motion.div>

      <style>{`
.au-root { position: relative; display: flex; flex-direction: column; gap: 18px; }
/* Ambient background glow — identical language to Dashboard/Agents/Settings */
.au-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(560px 420px at 10% 6%, rgba(255, 49, 68, 0.06), transparent 65%),
    radial-gradient(680px 500px at 90% 92%, rgba(57, 126, 112, 0.07), transparent 65%);
}
.au-root > * { position: relative; z-index: 1; }

/* Pagination footer */
.au-pagination {
  display: flex; align-items: center; justify-content: space-between;
  padding: 13px 22px; border-top: 1px solid var(--border-default);
  background: var(--bg-inset); gap: 12px; flex-wrap: wrap;
}
.au-page-info { font-size: 12px; color: var(--text-muted); }
.au-page-bold { color: var(--text-primary); font-weight: 650; }
.au-page-controls { display: flex; align-items: center; gap: 8px; }
.au-page-btn {
  display: inline-flex; align-items: center; gap: 5px;
  background: var(--card-bg); border: 1px solid var(--border-default);
  border-radius: 8px; padding: 6px 12px; font-size: 12px; font-weight: 650;
  color: var(--text-primary); cursor: pointer; transition: all 0.15s ease;
}
.au-page-btn:hover:not(:disabled) {
  border-color: var(--border-strong); background: var(--bg-surface-hover);
}
.au-page-btn:disabled {
  opacity: 0.35; cursor: not-allowed;
}
.au-page-curr {
  font-size: 12px; font-weight: 600; color: var(--text-secondary); padding: 0 4px;
}

/* Slim header */
.au-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.au-heading { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; color: var(--text-primary); margin: 0; line-height: 1.15; }
.au-subhead { font-size: 13px; font-weight: 550; color: var(--text-muted); margin: 3px 0 0; }
.au-export {
  display: inline-flex; align-items: center; gap: 7px; height: 38px; padding: 0 16px;
  border-radius: 999px; border: none; cursor: pointer; text-decoration: none;
  background: var(--bg-inset); color: var(--text-secondary); font-size: 12.5px; font-weight: 650;
  transition: background 160ms ease, color 160ms ease; flex-shrink: 0;
}
.au-export:hover { background: #e9ebec; color: var(--text-primary); }

/* Cards */
.au-card {
  background: var(--card-bg);
  border: 1px solid var(--card-border);
  border-radius: 26px;
  box-shadow: 0 1px 2px rgba(16,24,32,0.04);
}

/* Status strip */
.au-strip {
  display: grid; grid-template-columns: repeat(5, auto);
  justify-content: space-between; gap: 8px; padding: 18px 26px;
}
@media (max-width: 980px) { .au-strip { grid-template-columns: 1fr 1fr; } }
.au-cell { display: flex; flex-direction: column; gap: 4px; padding-right: 24px; border-right: 1px solid var(--border-default); }
.au-cell-last { border-right: none; padding-right: 0; }
@media (max-width: 980px) { .au-cell { border-right: none; padding-right: 0; } }
.au-cell-key { font-size: 10.5px; font-weight: 750; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-muted); margin: 0; }
.au-cell-val { font-size: 19px; font-weight: 400; letter-spacing: -0.02em; line-height: 26px; color: var(--text-primary); margin: 0; font-variant-numeric: tabular-nums; }
.au-cell-val em { font-style: normal; font-size: 11.5px; font-weight: 550; color: var(--text-muted); margin-left: 6px; letter-spacing: 0; }
.au-warn { color: #e02839; }
.au-stream { display: inline-flex; align-items: center; gap: 8px; font-size: 13.5px; font-weight: 650; color: #128a6d; }
.au-stream.off { color: #b7791f; }
.au-pulse, .au-dot-flat { width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0; }
.au-pulse { background: var(--accent-teal); animation: auPulse 2.4s ease-in-out infinite; }
@keyframes auPulse { 0%, 100% { box-shadow: 0 0 0 3px rgba(47,230,176,0.18); } 50% { box-shadow: 0 0 0 6px rgba(47,230,176,0.07); } }
.au-dot-flat { background: var(--accent-amber); }

/* Toolbar */
.au-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.au-seg {
  display: inline-flex; padding: 4px; gap: 2px;
  background: var(--bg-inset); border-radius: 999px;
}
.au-seg-btn {
  border: none; background: transparent; cursor: pointer; font: inherit;
  padding: 7px 16px; border-radius: 999px;
  font-size: 12px; font-weight: 650; color: var(--text-muted);
  transition: all 200ms cubic-bezier(0.22,1,0.36,1);
}
.au-seg-btn:hover:not(.active) { color: var(--text-secondary); }
.au-seg-btn.active { background: var(--bg-surface-elevated); color: var(--text-primary); box-shadow: 0 1px 4px rgba(16,24,32,0.12); }
.au-seg-btn.active.d-allow { color: #2f6d60; }
.au-seg-btn.active.d-deny { color: #e02839; }
.au-seg-btn.active.d-log { color: #a1741f; }

/* Env chip */
.au-chip {
  display: inline-flex; align-items: center; gap: 7px;
  padding: 8px 16px; border-radius: 999px; cursor: pointer; font: inherit;
  border: 1.5px solid var(--border-default); background: transparent;
  color: var(--text-muted); font-size: 12px; font-weight: 700;
  transition: all 180ms ease;
}
.au-chip-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: 0.35; flex-shrink: 0; transition: all 180ms ease; }
.au-chip.on { border-color: rgba(255,49,68,0.4); background: rgba(255,49,68,0.06); color: #e02839; }
.au-chip.on .au-chip-dot { opacity: 1; background: var(--accent-coral); box-shadow: 0 0 6px rgba(255,49,68,0.55); }

/* Table card */
.au-tablecard { overflow: hidden; }
.au-tablecard.empty { padding: 0; }

/* Editorial table */
.au-table-scroll { overflow-x: auto; }
.au-table {
  table-layout: fixed;
  width: max-content;
  min-width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.au-table th, .au-table td {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.au-table th {
  position: relative;
  text-align: left;
  padding: 14px 14px;
  font-size: 10.5px; font-weight: 750;
  letter-spacing: 0.07em; text-transform: uppercase;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border-strong);
}
.au-table td {
  padding: 13px 14px;
  border-bottom: 1px solid var(--border-default);
  color: var(--text-secondary);
  vertical-align: middle;
}
.au-table tbody tr:last-child td { border-bottom: none; }
.au-table tbody tr { transition: background 120ms ease; }
.au-table tbody tr:hover { background: var(--bg-surface-hover); }

/* Column resize */
.au-resize-handle {
  position: absolute; top: 0; right: -5px; width: 10px; height: 100%;
  cursor: col-resize; touch-action: none; user-select: none;
}
.au-resize-handle::after {
  content: ''; position: absolute; top: 18%; bottom: 18%; left: 50%;
  width: 2px; transform: translateX(-50%); border-radius: 1px;
  background: var(--accent-coral);
  opacity: 0; transition: opacity 150ms ease;
}
.au-resize-handle:hover::after,
.au-resize-handle.au-resizing::after { opacity: 1; }

/* Time cell */
.au-time { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.au-time-ago { font-size: 13px; font-weight: 650; color: var(--text-primary); overflow: hidden; text-overflow: ellipsis; }
.au-time-raw { font-size: 10.5px; font-weight: 500; color: var(--text-muted); font-family: 'SF Mono', Menlo, monospace; overflow: hidden; text-overflow: ellipsis; }

/* Agent cell */
.au-agent { display: flex; align-items: center; gap: 8px; min-width: 0; }
.au-agent-ico {
  width: 22px; height: 22px; border-radius: 7px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-inset); color: var(--text-muted);
}
.au-logo { width: 18px; height: 18px; object-fit: cover; border-radius: 50%; flex-shrink: 0; }
.au-agent-name { font-weight: 650; color: var(--text-primary); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.au-unknown {
  flex-shrink: 0; padding: 2px 9px; border-radius: 999px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.02em;
  color: var(--text-muted); background: rgba(142,112,111,0.12);
}
.au-tcp { font-size: 10px; color: var(--text-muted); font-family: 'SF Mono', Menlo, monospace; font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

/* Tool cell */
.au-tool {
  font-family: 'SF Mono', Menlo, monospace; font-size: 12px; font-weight: 600;
  color: var(--text-secondary); display: block; min-width: 0;
}

/* Decision badge */
.au-badge {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 11px; border-radius: 999px;
  font-size: 11px; font-weight: 700;
  border: 1px solid transparent;
}
.au-badge-dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.au-badge.b-allow { background: rgba(57,126,112,0.09); color: #2f6d60; border-color: rgba(57,126,112,0.25); }
.au-badge.b-deny  { background: rgba(255,49,68,0.08); color: #d92c3c; border-color: rgba(217,44,60,0.28); }
.au-badge.b-log   { background: rgba(222,145,29,0.1); color: #a1741f; border-color: rgba(222,145,29,0.3); }

/* Duration */
.au-duration { color: var(--text-muted); font-variant-numeric: tabular-nums; font-weight: 550; }

/* Reason + ENV badge */
.au-reason { display: flex; align-items: center; gap: 6px; min-width: 0; }
.au-reason-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.au-envbadge {
  display: inline-flex; align-items: center; flex-shrink: 0;
  padding: 2px 8px; border-radius: 999px;
  font-size: 9.5px; font-weight: 800; letter-spacing: 0.05em;
  color: #d92c3c; background: rgba(255,49,68,0.09);
  border: 1px solid rgba(255,49,68,0.3);
}

/* Block button */
.au-blockbtn {
  display: inline-flex; align-items: center; gap: 5px;
  font: inherit; font-size: 11px; font-weight: 700; color: #d92c3c;
  background: rgba(255,49,68,0.07); border: 1px solid rgba(217,44,60,0.3);
  border-radius: 999px; padding: 5px 12px; cursor: pointer;
  transition: all 150ms ease; white-space: nowrap;
}
.au-blockbtn:hover { background: rgba(255,49,68,0.13); border-color: rgba(217,44,60,0.55); }

/* Empty state */
.au-empty {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; text-align: center; padding: 72px 24px;
}
.au-empty-icon {
  width: 56px; height: 56px; border-radius: 17px;
  display: flex; align-items: center; justify-content: center;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-muted); margin-bottom: 18px;
}
.au-empty-title { font-size: 17px; font-weight: 650; color: var(--text-primary); margin: 0; letter-spacing: -0.01em; }
.au-empty-desc { font-size: 13px; font-weight: 500; color: var(--text-muted); margin: 6px 0 0; max-width: 30em; line-height: 1.55; }

/* ── Dark mode ──────────────────────────────────────────────────────────── */
:root[data-theme="dark"] .au-root::before {
  background:
    radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
    radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
}
:root[data-theme="dark"] .au-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .au-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
:root[data-theme="dark"] .au-export { background: var(--bg-inset); }
:root[data-theme="dark"] .au-export:hover { background: #232b38; color: var(--text-primary); }
:root[data-theme="dark"] .au-cell { border-right-color: rgba(255,255,255,0.08); }
@media (max-width: 980px) { :root[data-theme="dark"] .au-cell { border-right-color: transparent; } }
:root[data-theme="dark"] .au-warn { color: #ff6b78; }
:root[data-theme="dark"] .au-stream { color: #2fe6b0; }
:root[data-theme="dark"] .au-stream.off { color: #ffb020; }
:root[data-theme="dark"] .au-seg { background: rgba(255,255,255,0.05); }
:root[data-theme="dark"] .au-seg-btn.active { background: #232b38; box-shadow: 0 1px 6px rgba(0,0,0,0.5); }
:root[data-theme="dark"] .au-seg-btn.active.d-allow { color: #2fe6b0; }
:root[data-theme="dark"] .au-seg-btn.active.d-deny { color: #ff6b78; }
:root[data-theme="dark"] .au-seg-btn.active.d-log { color: #ffb020; }
:root[data-theme="dark"] .au-chip.on { border-color: rgba(255,73,94,0.35); background: rgba(255,73,94,0.09); color: #ff6b78; }
:root[data-theme="dark"] .au-table th { border-bottom-color: rgba(255,255,255,0.12); }
:root[data-theme="dark"] .au-table td { border-bottom-color: rgba(255,255,255,0.05); }
:root[data-theme="dark"] .au-agent-ico { background: rgba(255,255,255,0.04); }
:root[data-theme="dark"] .au-badge.b-allow { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
:root[data-theme="dark"] .au-badge.b-deny { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
:root[data-theme="dark"] .au-badge.b-log { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.28); }
:root[data-theme="dark"] .au-envbadge { color: #ff6b78; background: rgba(255,73,94,0.1); border-color: rgba(255,73,94,0.32); }
:root[data-theme="dark"] .au-blockbtn { color: #ff6b78; background: rgba(255,73,94,0.08); border-color: rgba(255,73,94,0.32); }
:root[data-theme="dark"] .au-blockbtn:hover { background: rgba(255,73,94,0.16); border-color: rgba(255,73,94,0.55); }
:root[data-theme="dark"] .au-unknown { background: rgba(255,255,255,0.06); }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) .au-root::before {
    background:
      radial-gradient(620px 480px at 10% 6%, rgba(255, 49, 68, 0.14), transparent 62%),
      radial-gradient(720px 540px at 90% 92%, rgba(47, 230, 176, 0.1), transparent 62%);
  }
  :root:not([data-theme]) .au-card { box-shadow: 0 0 0 1px rgba(255,255,255,0.02), 0 10px 36px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .au-heading { text-shadow: 0 0 24px rgba(255,255,255,0.08); }
  :root:not([data-theme]) .au-export { background: var(--bg-inset); }
  :root:not([data-theme]) .au-export:hover { background: #232b38; color: var(--text-primary); }
  :root:not([data-theme]) .au-cell { border-right-color: rgba(255,255,255,0.08); }
  :root:not([data-theme]) .au-warn { color: #ff6b78; }
  :root:not([data-theme]) .au-stream { color: #2fe6b0; }
  :root:not([data-theme]) .au-stream.off { color: #ffb020; }
  :root:not([data-theme]) .au-seg { background: rgba(255,255,255,0.05); }
  :root:not([data-theme]) .au-seg-btn.active { background: #232b38; box-shadow: 0 1px 6px rgba(0,0,0,0.5); }
  :root:not([data-theme]) .au-seg-btn.active.d-allow { color: #2fe6b0; }
  :root:not([data-theme]) .au-seg-btn.active.d-deny { color: #ff6b78; }
  :root:not([data-theme]) .au-seg-btn.active.d-log { color: #ffb020; }
  :root:not([data-theme]) .au-chip.on { border-color: rgba(255,73,94,0.35); background: rgba(255,73,94,0.09); color: #ff6b78; }
  :root:not([data-theme]) .au-table th { border-bottom-color: rgba(255,255,255,0.12); }
  :root:not([data-theme]) .au-table td { border-bottom-color: rgba(255,255,255,0.05); }
  :root:not([data-theme]) .au-agent-ico { background: rgba(255,255,255,0.04); }
  :root:not([data-theme]) .au-badge.b-allow { background: rgba(47,230,176,0.09); color: #2fe6b0; border-color: rgba(47,230,176,0.28); }
  :root:not([data-theme]) .au-badge.b-deny { background: rgba(255,73,94,0.1); color: #ff6b78; border-color: rgba(255,73,94,0.3); }
  :root:not([data-theme]) .au-badge.b-log { background: rgba(255,176,32,0.09); color: #ffb020; border-color: rgba(255,176,32,0.28); }
  :root:not([data-theme]) .au-envbadge { color: #ff6b78; background: rgba(255,73,94,0.1); border-color: rgba(255,73,94,0.32); }
  :root:not([data-theme]) .au-blockbtn { color: #ff6b78; background: rgba(255,73,94,0.08); border-color: rgba(255,73,94,0.32); }
  :root:not([data-theme]) .au-blockbtn:hover { background: rgba(255,73,94,0.16); border-color: rgba(255,73,94,0.55); }
  :root:not([data-theme]) .au-unknown { background: rgba(255,255,255,0.06); }
}
      `}</style>
    </div>
  );
}
