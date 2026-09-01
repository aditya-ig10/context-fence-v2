/**
 * Settings — ui-2.0 clean redesign.
 *
 *   ambient-glow root -> slim header (+ Download backup button)
 *   -> live status strip: Version · Backend · MCP Proxy · Mode · DB
 *   -> Security & Threat Defense (Log-only, Env/API context block, Prompt injection defense, Schema validation, Payload recording)
 *   -> [ Notifications & Alerts | Audit Data & Retention (v2 presets: 7d / 30d / 90d) ]
 *   -> [ Appearance & Preferences | Updates & About ]
 *
 * Streamlined, zero clutter, high-craft ui-2.0 design language.
 */
import { useEffect, useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import {
  Shield, Bell, Palette, Download,
  RefreshCw, ExternalLink, Bug, Clock, Monitor, Sun, Moon,
  Zap, FileCheck, Lock, ShieldAlert, Database, Cloud, CloudUpload, CheckCircle2,
} from 'lucide-react';
import { applyTheme } from '../lib/theme';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { notify } from '../components/Toasts';
import { performCloudBackup } from '../lib/cloudBackup';

interface SettingsData {
  settings: Record<string, string>;
  proxy?: { proxyPort: number; backendPort: number; note: string };
  retention?: { days: number };
  logOnly?: boolean;
  envBlock?: boolean;
}

const containerVariants: Variants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.06 } },
};

const cardVariants: Variants = {
  hidden: { opacity: 0, y: 16, scale: 0.98 },
  visible: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.4, ease: [0.22, 1, 0.36, 1] } },
};

const EASE = [0.22, 1, 0.36, 1] as const;

export default function Settings() {

  const [data, setData] = useState<SettingsData | null>(null);
  const [backendOnline, setBackendOnline] = useState<boolean | null>(null);

  const [theme, setTheme] = useState('system');
  const [autoUpdates, setAutoUpdates] = useState(true);

  const [envBlock, setEnvBlock] = useState(true);
  const [strictSchema, setStrictSchema] = useState(true);
  const [promptDefense, setPromptDefense] = useState(true);
  const [recordPayloads, setRecordPayloads] = useState(true);

  const [webhookUrl, setWebhookUrl] = useState('');
  const [desktopAlerts, setDesktopAlerts] = useState(false);

  const [retentionDays, setRetention (v2 presets: 7d / 30d / 90d)Days] = useState(0);
  const [clearDate, setClearDate] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);

  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [lastCloudBackup, setLastCloudBackup] = useState<string | null>(
    () => localStorage.getItem('cf_last_cloud_backup')
  );

  async function handleCloudSync() {
    setCloudSyncing(true);
    try {
      const result = await performCloudBackup();
      if (result.success) {
        setLastCloudBackup(result.timestamp || new Date().toISOString());
        notify.success(
          'Cloud Backup Completed',
          `Saved ${result.itemCounts?.policies || 0} policies, ${result.itemCounts?.agents || 0} agents, and ${result.itemCounts?.logs || 0} audit logs to separate Firestore tables.`
        );
      } else {
        notify.error('Cloud Backup Failed', result.error || 'Check Firebase permissions and auth state.');
      }
    } catch (err: any) {
      notify.error('Backup Error', err.message || 'Network error during cloud sync');
    } finally {
      setCloudSyncing(false);
    }
  }

  type UpdateState = 'idle' | 'checking' | 'up-to-date' | 'available' | 'error';
  const [updateState, setUpdateState] = useState<UpdateState>('idle');
  const [updateMsg, setUpdateMsg] = useState('');
  const [latestVersion, setLatestVersion] = useState('');
  const [releaseUrl, setReleaseUrl] = useState('');

  const { data: settingsData } = useCachedFetch<SettingsData>('settings', () =>
    fetch('/api/settings').then((r) => r.json()));

  useEffect(() => {
    let cancelled = false;
    const ping = () => fetch('/api/health')
      .then((r) => { if (!cancelled) setBackendOnline(r.ok); })
      .catch(() => { if (!cancelled) setBackendOnline(false); });
    ping();
    const t = setInterval(ping, 30_000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!settingsData) return;
    setData(settingsData);
    setTheme(settingsData.settings.theme || 'system');
    setWebhookUrl(settingsData.settings.webhook_url || '');
    setRetention (v2 presets: 7d / 30d / 90d)Days(settingsData.retention?.days ?? 0);
    setEnvBlock(settingsData.settings.block_env_mcp !== 'false');
    setStrictSchema(settingsData.settings.strict_schema !== 'false');
    setPromptDefense(settingsData.settings.prompt_injection_defense !== 'false');
    setRecordPayloads(settingsData.settings.record_payloads !== 'false');
    setDesktopAlerts(settingsData.settings.desktop_alerts === 'true');
    setAutoUpdates(settingsData.settings.auto_check_updates !== 'false');
  }, [settingsData]);

  async function putSetting(key: string, value: string): Promise<boolean> {
    try {
      const res = await fetch(`/api/settings/${key}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (res.ok) invalidateCache((k) => k === 'settings');
      return res.ok;
    } catch { return false; }
  }

  async function toggleLogOnly() {
    const next = !(data?.logOnly ?? false);
    const ok = await putSetting('log_only', String(next));
    if (ok) {
      setData((d) => (d ? { ...d, logOnly: next } : d));
      notify.success(next ? 'Log-only mode enabled' : 'Enforcement active', next ? 'Deny decisions will be logged without dropping requests' : 'Policy violations will be strictly blocked');
    }
  }

  async function toggleEnvBlock() {
    const next = !envBlock;
    const ok = await putSetting('block_env_mcp', String(next));
    if (ok) {
      setEnvBlock(next);
      notify.success(next ? 'Credential shield enabled' : 'Credential shield disabled', next ? 'Requests carrying API keys, JWTs or env context are blocked' : 'Credential inspection disabled');
    }
  }

  async function toggleStrictSchema() {
    const next = !strictSchema;
    const ok = await putSetting('strict_schema', String(next));
    if (ok) {
      setStrictSchema(next);
      notify.success(next ? 'Strict schema active' : 'Schema validation relaxed', next ? 'Tool arguments must match declared MCP schema types' : 'Schema type validation bypassed');
    }
  }

  async function togglePromptDefense() {
    const next = !promptDefense;
    const ok = await putSetting('prompt_injection_defense', String(next));
    if (ok) {
      setPromptDefense(next);
      notify.success(next ? 'Injection defense enabled' : 'Injection defense disabled', next ? 'Detects context escaping and system prompt overrides' : 'Prompt defense bypassed');
    }
  }

  async function toggleRecordPayloads() {
    const next = !recordPayloads;
    const ok = await putSetting('record_payloads', String(next));
    if (ok) {
      setRecordPayloads(next);
      notify.success(next ? 'Full payload recording on' : 'Metadata-only mode', next ? 'Audit logs capture complete request & response payloads' : 'Only metadata and method names recorded');
    }
  }

  async function toggleDesktopAlerts() {
    const next = !desktopAlerts;
    if (next && 'Notification' in window && Notification.permission !== 'granted') {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        notify.error('Permission denied', 'Allow browser notifications in site settings');
        return;
      }
    }
    const ok = await putSetting('desktop_alerts', String(next));
    if (ok) {
      setDesktopAlerts(next);
      notify.success(next ? 'Desktop alerts enabled' : 'Desktop alerts disabled', next ? 'You will be notified when critical security threats are blocked' : 'System notifications turned off');
    }
  }

  async function toggleAutoUpdates() {
    const next = !autoUpdates;
    const ok = await putSetting('auto_check_updates', String(next));
    if (ok) setAutoUpdates(next);
  }

  async function saveWebhook() {
    const ok = await putSetting('webhook_url', webhookUrl.trim());
    if (ok) notify.success('Webhook saved', 'Every deny decision will POST to this URL');
    else notify.error('Save failed', 'The webhook URL could not be stored');
  }

  async function testWebhook() {
    const loadingId = notify.loading('Testing webhook…', 'Sending a test payload to the configured URL');
    try {
      const res = await fetch('/api/settings/webhook/test', { method: 'POST' });
      const body = await res.json();
      notify.dismiss(loadingId);
      if (body.ok) notify.success('Test delivered', 'The webhook endpoint accepted the payload');
      else notify.error('Delivery failed', 'Check the URL and try again');
    } catch {
      notify.dismiss(loadingId);
      notify.error('Delivery failed', 'Could not reach the backend');
    }
  }

  async function changeRetention (v2 presets: 7d / 30d / 90d)(days: number) {
    const ok = await putSetting('audit_retention_days', String(days));
    if (ok) {
      setRetention (v2 presets: 7d / 30d / 90d)Days(days);
      notify.success('Retention (v2 presets: 7d / 30d / 90d) updated', days === 0 ? 'Audit records are kept forever' : `Audit records older than ${days} days will be cleaned up`);
    } else {
      notify.error('Retention (v2 presets: 7d / 30d / 90d) not saved', 'Could not reach the settings store');
    }
  }

  async function runCleanup() {
    const loadingId = notify.loading('Running cleanup…', 'Deleting audit rows outside the retention window');
    try {
      const res = await fetch('/api/settings/retention/run', { method: 'POST' });
      const body = await res.json();
      notify.dismiss(loadingId);
      if (body.ok) notify.success('Cleanup complete', `${body.deleted} audit ${body.deleted === 1 ? 'row' : 'rows'} removed`);
      else notify.error('Cleanup failed', 'The retention job reported an error');
    } catch {
      notify.dismiss(loadingId);
      notify.error('Cleanup failed', 'Could not reach the backend');
    }
  }

  function localToday(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  async function clearLogs(scope: { date: string } | { all: true }) {
    try {
      const res = await fetch('/api/logs/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(scope),
      });
      const body = await res.json();
      if (body.ok) {
        const target = body.scope === 'all' ? 'entire audit log' : body.scope;
        notify.success('Audit log cleared', `${body.deleted} ${body.deleted === 1 ? 'record' : 'records'} deleted (${target})`);
      } else {
        notify.error('Failed to clear', body.error ?? 'The backend rejected the request');
      }
      invalidateCache((k) => k === 'logs' || k === 'stats' || k.startsWith('server:') || k === 'servers' || k === 'dashboard');
      setConfirmAll(false);
    } catch {
      notify.error('Failed to clear', 'Could not reach the backend');
    }
  }

  async function changeTheme(next: string) {
    const ok = await putSetting('theme', next);
    if (ok) {
      setTheme(next);
      applyTheme(next);
    }
  }

  async function checkForUpdates() {
    setUpdateState('checking');
    setUpdateMsg('');
    const bridge = window.cfUpdates;
    if (!bridge) {
      setUpdateState('error');
      setUpdateMsg('Update checks are available inside the Context Fence app or on GitHub.');
      return;
    }
    try {
      const result = await bridge.check();
      if (!result?.ok) {
        setUpdateState('error');
        setUpdateMsg(result?.error ?? "Couldn't check for updates — try again.");
        return;
      }
      if (result.updateAvailable) {
        setUpdateState('available');
        setLatestVersion(result.latest);
        setReleaseUrl(result.releaseUrl);
      } else {
        setUpdateState('up-to-date');
        setLatestVersion(result.latest);
      }
    } catch {
      setUpdateState('error');
      setUpdateMsg("Couldn't check for updates — try again.");
    }
  }

  async function exportBackup() {
    try {
      const r = await fetch('/api/settings/export');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mcp-firewall-backup.json';
      a.click();
      URL.revokeObjectURL(url);
      notify.success('Backup downloaded', 'Audit log, policies, settings and connectors exported in one JSON bundle');
    } catch {
      notify.error('Export failed', 'Could not build the backup bundle');
    }
  }

  const proxyPort = data?.proxy?.proxyPort ?? 3001;
  const logOnly = data?.logOnly ?? false;

  return (
    <div className="set-root">
      <header className="set-head">
        <div>
          <h1 className="set-heading">Settings</h1>
          <p className="set-subhead">Security enforcement, data lifecycle, notifications, and application preferences.</p>
        </div>
        <button className="set-ghost" type="button" onClick={exportBackup} title="Export database, policies, and audit records as JSON">
          <Download size={14} />
          Download backup
        </button>
      </header>

      <motion.section
        className="set-card set-strip"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        <div className="set-cell">
          <p className="set-cell-key">Version</p>
          <p className="set-cell-val set-cell-mono">{__APP_VERSION__}</p>
        </div>
        <div className="set-cell">
          <p className="set-cell-key">Backend API</p>
          <p className={`set-cell-val set-cell-status${backendOnline === false ? ' down' : ''}`}>
            <span className={backendOnline ? 'set-pulse' : 'set-dot-flat'} />
            {backendOnline === null ? 'Checking…' : backendOnline ? 'Connected' : 'Offline'}
          </p>
        </div>
        <div className="set-cell">
          <p className="set-cell-key">MCP Proxy Ingress</p>
          <p className="set-cell-val set-cell-mono">:{proxyPort} &amp; :3002</p>
        </div>
        <div className="set-cell">
          <p className="set-cell-key">Firewall Mode</p>
          <p className={`set-cell-val${logOnly ? ' warn' : ' active-mode'}`}>
            {logOnly ? <>Log-only <em>safe mode</em></> : <>Enforced <em>blocking active</em></>}
          </p>
        </div>
        <div className="set-cell set-cell-last">
          <p className="set-cell-key">Database</p>
          <p className="set-cell-val set-cell-mono">
            <Database size={12} style={{ display: 'inline', marginRight: 4 }} />
            SQLite WAL
          </p>
        </div>
      </motion.section>

      {/* Security & Threat Defense (Hero Enforcement Section) */}
      <motion.section
        className="set-card"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        <div className="set-cardhead">
          <span className="set-tile"><Shield size={18} strokeWidth={1.8} /></span>
          <div>
            <h3 className="set-h3">Security &amp; Threat Defense</h3>
            <p className="set-h3-sub">Global inspection engines, credential shielding, and policy enforcement behavior.</p>
          </div>
        </div>

        {/* Log-only toggle */}
        <div className="set-row">
          <div className="set-row-ico">
            <Shield size={15} strokeWidth={1.8} />
          </div>
          <div className="set-row-text">
            <p className="set-row-title">Log-only mode</p>
            <p className="set-row-desc">
              {logOnly
                ? 'On — deny rules are recorded as log entries without dropping the request (safe testing mode).'
                : 'Off — deny rules block unauthorized requests before reaching the MCP server.'}
            </p>
          </div>
          <button
            className={`set-switch${logOnly ? ' on' : ''}`}
            onClick={toggleLogOnly}
            role="switch"
            aria-checked={logOnly}
            aria-label="Toggle log-only mode"
          >
            <span className="set-knob" />
          </button>
        </div>

        {/* Env / Credential Block */}
        <div className="set-row">
          <div className="set-row-ico">
            <Lock size={15} strokeWidth={1.8} />
          </div>
          <div className="set-row-text">
            <p className="set-row-title">Block env / API / JWT credential leakage</p>
            <p className="set-row-desc">
              {envBlock
                ? 'On — MCP tool calls containing private keys, tokens, or environment variables are intercepted and blocked.'
                : 'Off — credential context is flagged in the audit log but allowed to execute.'}
            </p>
          </div>
          <button
            className={`set-switch${envBlock ? ' on' : ''}`}
            onClick={toggleEnvBlock}
            role="switch"
            aria-checked={envBlock}
            aria-label="Toggle blocking of credential context MCP calls"
          >
            <span className="set-knob" />
          </button>
        </div>

        {/* Prompt Injection Defense */}
        <div className="set-row">
          <div className="set-row-ico">
            <ShieldAlert size={15} strokeWidth={1.8} />
          </div>
          <div className="set-row-text">
            <p className="set-row-title">Prompt injection &amp; jailbreak defense</p>
            <p className="set-row-desc">
              {promptDefense
                ? 'On — inspects inputs for system prompt overrides, delimiter escaping, and known jailbreak patterns.'
                : 'Off — prompt injection inspection engine bypassed.'}
            </p>
          </div>
          <button
            className={`set-switch${promptDefense ? ' on' : ''}`}
            onClick={togglePromptDefense}
            role="switch"
            aria-checked={promptDefense}
            aria-label="Toggle prompt injection defense"
          >
            <span className="set-knob" />
          </button>
        </div>

        {/* Strict Schema Validation */}
        <div className="set-row">
          <div className="set-row-ico">
            <FileCheck size={15} strokeWidth={1.8} />
          </div>
          <div className="set-row-text">
            <p className="set-row-title">Strict argument schema validation</p>
            <p className="set-row-desc">
              {strictSchema
                ? 'On — validates tool call parameters strictly against the server’s declared MCP JSON Schema.'
                : 'Off — schema structure validation relaxed.'}
            </p>
          </div>
          <button
            className={`set-switch${strictSchema ? ' on' : ''}`}
            onClick={toggleStrictSchema}
            role="switch"
            aria-checked={strictSchema}
            aria-label="Toggle strict schema validation"
          >
            <span className="set-knob" />
          </button>
        </div>

        {/* Payload Shadow Recording */}
        <div className="set-row">
          <div className="set-row-ico">
            <Database size={15} strokeWidth={1.8} />
          </div>
          <div className="set-row-text">
            <p className="set-row-title">Full request &amp; response payload recording</p>
            <p className="set-row-desc">
              {recordPayloads
                ? 'On — captures full JSON payloads in the local audit log for forensic inspection.'
                : 'Off — records only tool names, timestamps, and policy outcomes for minimal disk footprint.'}
            </p>
          </div>
          <button
            className={`set-switch${recordPayloads ? ' on' : ''}`}
            onClick={toggleRecordPayloads}
            role="switch"
            aria-checked={recordPayloads}
            aria-label="Toggle payload recording"
          >
            <span className="set-knob" />
          </button>
        </div>
      </motion.section>

      <motion.div
        className="set-banner"
        variants={cardVariants}
        initial="hidden"
        animate="visible"
        transition={{ duration: 0.4, ease: EASE }}
      >
        <span className="set-banner-icon"><Zap size={15} /></span>
        <span className="set-banner-text">
          <span className="set-banner-title">Zero-reload realtime synchronization</span>
          <span className="set-banner-desc">
            All rule edits, credential triggers, and mode switches take effect immediately on the next tool call without restarting the proxy.
          </span>
        </span>
      </motion.div>

      <motion.div className="set-band" variants={containerVariants} initial="hidden" animate="visible">
        <motion.section className="set-card" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <div className="set-cardhead">
            <span className="set-tile"><Bell size={17} /></span>
            <div>
              <h3 className="set-h3">Notifications &amp; Alerting</h3>
              <p className="set-h3-sub">Trigger webhooks or native desktop notifications on security violations.</p>
            </div>
          </div>

          <p className="set-field-label">Security Webhook</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              className="set-input set-input-mono"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://example.com/hooks/deny"
              aria-label="Webhook URL"
            />
            <button className="set-primary" onClick={saveWebhook}>Save</button>
            <button className="set-ghost" onClick={testWebhook}>Test</button>
          </div>
          <p className="set-field-note">Fires a JSON POST on every denied or intercepted tool call.</p>

          <div className="set-row" style={{ marginTop: 12, padding: '12px 0 0', borderTop: '1px solid var(--border-default)' }}>
            <div className="set-row-text">
              <p className="set-row-title">Native desktop alerts</p>
              <p className="set-row-desc">Show OS notification whenever a critical policy violation occurs.</p>
            </div>
            <button
              className={`set-switch${desktopAlerts ? ' on' : ''}`}
              onClick={toggleDesktopAlerts}
              role="switch"
              aria-checked={desktopAlerts}
              aria-label="Toggle desktop alerts"
            >
              <span className="set-knob" />
            </button>
          </div>
        </motion.section>

        <motion.section className="set-card" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <div className="set-cardhead">
            <span className="set-tile"><Clock size={17} /></span>
            <div>
              <h3 className="set-h3">Audit Data &amp; Retention (v2 presets: 7d / 30d / 90d)</h3>
              <p className="set-h3-sub">Automated database pruning, one-shot cleanup, and manual log purge.</p>
            </div>
          </div>

          <p className="set-field-label">Retention (v2 presets: 7d / 30d / 90d) Window</p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <div className="set-seg" role="radiogroup" aria-label="Audit retention window">
              {[[0, 'Forever'], [7, '7 days'], [30, '30 days'], [90, '90 days']].map(([days, text]) => (
                <button
                  key={days}
                  className={`set-seg-btn${retentionDays === days ? ' active' : ''}`}
                  onClick={() => changeRetention (v2 presets: 7d / 30d / 90d)(days as number)}
                  role="radio"
                  aria-checked={retentionDays === days}
                >
                  {text as string}
                </button>
              ))}
            </div>
            <button className="set-ghost set-ghost-sm" onClick={runCleanup}>
              <RefreshCw size={12} /> Run cleanup
            </button>
          </div>
          <p className="set-field-note">Automated background cleanup task purges expired rows every 60s.</p>

          <div className="set-dangerzone">
            <p className="set-danger-title">Danger Zone</p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button className="set-danger-btn" onClick={() => clearLogs({ date: localToday() })}>
                Clear today
              </button>
              <input
                type="date"
                className="set-dateinput"
                value={clearDate}
                max={localToday()}
                onChange={(e) => setClearDate(e.target.value)}
                aria-label="Pick a day to clear"
              />
              <button className="set-danger-btn" disabled={!clearDate} onClick={() => clearDate && clearLogs({ date: clearDate })}>
                Clear selected
              </button>
              <button
                className={`set-danger-btn fill${confirmAll ? ' armed' : ''}`}
                onClick={() => (confirmAll ? clearLogs({ all: true }) : setConfirmAll(true))}
                onBlur={() => setConfirmAll(false)}
              >
                {confirmAll ? 'Confirm clear all?' : 'Clear all logs'}
              </button>
            </div>
          </div>
        </motion.section>
      </motion.div>

      {/* Cloud Backup to Firestore Band */}
      <motion.div className="set-band" variants={containerVariants} initial="hidden" animate="visible">
        <motion.section className="set-card" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }} style={{ gridColumn: '1 / -1' }}>
          <div className="set-cardhead">
            <span className="set-tile" style={{ background: 'rgba(47, 230, 176, 0.12)', color: '#2fe6b0' }}>
              <Cloud size={17} />
            </span>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 className="set-h3">Cloud Backup to Firestore</h3>
              </div>
              <p className="set-h3-sub">
                Automatically back up all daemon policies, agent protections, and security audit records into separate, isolated Firestore collections.
              </p>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 16 }}>
            <div style={{ padding: '12px 14px', background: 'var(--bg-inset)', borderRadius: 12, border: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Policies Collection</span>
              <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>cloud_policies</p>
            </div>
            <div style={{ padding: '12px 14px', background: 'var(--bg-inset)', borderRadius: 12, border: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Agent Configs</span>
              <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>cloud_agent_configs</p>
            </div>
            <div style={{ padding: '12px 14px', background: 'var(--bg-inset)', borderRadius: 12, border: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Audit Logs</span>
              <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>cloud_audit_logs</p>
            </div>
            <div style={{ padding: '12px 14px', background: 'var(--bg-inset)', borderRadius: 12, border: '1px solid var(--border-default)' }}>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Snapshots</span>
              <p style={{ margin: '4px 0 0', fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', fontFamily: 'var(--font-mono, monospace)' }}>cloud_backups</p>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-default)', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              {lastCloudBackup ? (
                <span>Last backed up: <strong style={{ color: 'var(--text-primary)' }}>{new Date(lastCloudBackup).toLocaleString()}</strong></span>
              ) : (
                <span>No cloud backup recorded yet</span>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                type="button"
                className="prof-btn-action prof-btn-upgrade"
                onClick={handleCloudSync}
                disabled={cloudSyncing}
                style={{ padding: '8px 18px', fontSize: 12.5 }}
              >
                <CloudUpload size={14} className={cloudSyncing ? 'ag2-spin' : ''} />
                <span>{cloudSyncing ? 'Syncing to Firestore…' : 'Sync All Data to Cloud Now'}</span>
              </button>
            </div>
          </div>
        </motion.section>
      </motion.div>

      <motion.div className="set-band" variants={containerVariants} initial="hidden" animate="visible">
        <motion.section className="set-card" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <div className="set-cardhead">
            <span className="set-tile"><Palette size={17} /></span>
            <div>
              <h3 className="set-h3">Appearance &amp; Preferences</h3>
              <p className="set-h3-sub">Theme selection and startup preferences.</p>
            </div>
          </div>

          <p className="set-field-label">Interface Theme</p>
          <div className="set-seg" role="radiogroup" aria-label="Theme">
            {([
              ['system', 'System', Monitor],
              ['light', 'Light', Sun],
              ['dark', 'Dark', Moon],
            ] as [string, string, typeof Monitor][]).map(([value, text, Icon]) => (
              <button
                key={value}
                className={`set-seg-btn${theme === value ? ' active' : ''}`}
                onClick={() => changeTheme(value)}
                role="radio"
                aria-checked={theme === value}
              >
                <Icon size={13} />
                {text}
              </button>
            ))}
          </div>

          <div className="set-row" style={{ marginTop: 16, padding: '14px 0 0', borderTop: '1px solid var(--border-default)' }}>
            <div className="set-row-text">
              <p className="set-row-title">Auto-check updates</p>
              <p className="set-row-desc">Automatically check for new versions on application launch.</p>
            </div>
            <button
              className={`set-switch${autoUpdates ? ' on' : ''}`}
              onClick={toggleAutoUpdates}
              role="switch"
              aria-checked={autoUpdates}
              aria-label="Toggle auto update check"
            >
              <span className="set-knob" />
            </button>
          </div>
        </motion.section>

        <motion.section className="set-card" variants={cardVariants} transition={{ duration: 0.4, ease: EASE }}>
          <div className="set-cardhead">
            <span className="set-tile"><RefreshCw size={17} /></span>
            <div>
              <h3 className="set-h3">Updates &amp; Support</h3>
              <p className="set-h3-sub">Release checks and official documentation.</p>
            </div>
          </div>
          <div className="set-updates">
            <div>
              <p className="set-update-ver">v{__APP_VERSION__}</p>
              {updateState === 'checking' && <p className="set-update-note">Checking for updates…</p>}
              {updateState === 'up-to-date' && <p className="set-update-ok">Latest release ({latestVersion || __APP_VERSION__})</p>}
              {updateState === 'available' && <p className="set-update-warn">Update available: {latestVersion}</p>}
              {updateState === 'error' && <p className="set-update-err">{updateMsg}</p>}
              {updateState === 'idle' && (
                <p className="set-update-note">Running latest production build.</p>
              )}
            </div>
            <div className="set-update-actions">
              {updateState === 'available' && releaseUrl && (
                <a href={releaseUrl} target="_blank" rel="noreferrer" className="set-ghost">
                  <ExternalLink size={13} /> View release
                </a>
              )}
              <button className="set-primary" onClick={checkForUpdates} disabled={updateState === 'checking'}>
                <RefreshCw size={13} /> {updateState === 'checking' ? 'Checking…' : 'Check for updates'}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-default)' }}>
            <a
              href="https://contextfence.vercel.app"
              target="_blank"
              rel="noreferrer"
              className="set-ghost"
            >
              <ExternalLink size={13} /> Documentation
            </a>
            <a
              href="https://github.com/aditya-ig10/context-fence/issues"
              target="_blank"
              rel="noreferrer"
              className="set-ghost"
            >
              <Bug size={13} /> Report an issue
            </a>
          </div>
        </motion.section>
      </motion.div>

      <style>{`
.set-root { position: relative; display: flex; flex-direction: column; gap: 24px; padding-bottom: 40px; }
.set-root::before {
  content: ''; position: fixed; inset: 0; pointer-events: none; z-index: 0;
  background:
    radial-gradient(800px circle at 15% 5%, rgba(255, 49, 68, 0.03), transparent 70%),
    radial-gradient(900px circle at 85% 85%, rgba(57, 126, 112, 0.04), transparent 70%);
}
.set-root > * { position: relative; z-index: 1; }

.set-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 4px; }
.set-heading { font-size: 28px; font-weight: 700; letter-spacing: -0.03em; color: var(--text-primary); margin: 0; }
.set-subhead { font-size: 13.5px; font-weight: 500; color: var(--text-muted); margin: 4px 0 0; }

.set-primary {
  display: inline-flex; align-items: center; gap: 8px;
  border: 1px solid transparent; cursor: pointer; font: inherit;
  font-size: 13px; font-weight: 600; color: #ffffff;
  background: #ff3144; padding: 0 16px; height: 36px; border-radius: 999px;
  box-shadow: 0 2px 8px rgba(255,49,68,0.2), inset 0 1px 0 rgba(255,255,255,0.15);
  transition: all 200ms ease; text-decoration: none; flex-shrink: 0;
}
.set-primary:hover:not(:disabled) { background: #e51f33; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(255,49,68,0.3), inset 0 1px 0 rgba(255,255,255,0.15); }
.set-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

.set-ghost {
  display: inline-flex; align-items: center; gap: 7px;
  background: var(--card-bg); border: 1px solid var(--border-default);
  cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 600;
  color: var(--text-secondary); padding: 0 14px; height: 34px; border-radius: 999px;
  transition: all 180ms ease; text-decoration: none;
}
.set-ghost:hover { background: var(--bg-surface-hover); border-color: var(--border-strong); color: var(--text-primary); }
.set-ghost-sm { height: 28px; padding: 0 10px; font-size: 11.5px; border-radius: 8px; }

.set-card {
  background: var(--card-bg); border: 1px solid var(--card-border);
  border-radius: 18px; padding: 22px 24px; display: flex; flex-direction: column; gap: 16px;
  box-shadow: var(--shadow-sm); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
  transition: border-color 200ms ease, box-shadow 200ms ease;
}
.set-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); }

.set-cardhead { display: flex; align-items: center; gap: 14px; }
.set-tile {
  width: 38px; height: 38px; border-radius: 12px;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-primary); display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: all 200ms ease;
}
.set-card:hover .set-tile { border-color: var(--border-strong); }
.set-h3 { font-size: 15.5px; font-weight: 700; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.set-h3-sub { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 2px 0 0; }

.set-strip {
  display: grid; grid-template-columns: repeat(5, 1fr); padding: 16px 22px; gap: 16px;
}
@media (max-width: 860px) {
  .set-strip { grid-template-columns: repeat(2, 1fr); }
}
.set-cell { border-right: 1px solid var(--border-default); padding-right: 16px; }
.set-cell-last { border-right: none; padding-right: 0; }
.set-cell-key { font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin: 0 0 4px; }
.set-cell-val { font-size: 13.5px; font-weight: 700; color: var(--text-primary); margin: 0; display: flex; align-items: center; gap: 6px; }
.set-cell-val.active-mode { color: var(--accent-teal); }
.set-cell-val.warn { color: var(--accent-amber); }
.set-cell-val em { font-style: normal; font-size: 11px; font-weight: 500; color: var(--text-muted); }
.set-cell-mono { font-family: 'SF Mono', 'Fira Code', monospace; }
.set-cell-status { color: #00a699; }
.set-cell-status.down { color: var(--accent-coral); }

.set-pulse { width: 7px; height: 7px; border-radius: 50%; background: #00a699; box-shadow: 0 0 8px #00a699; display: inline-block; }
.set-dot-flat { width: 7px; height: 7px; border-radius: 50%; background: var(--text-muted); display: inline-block; }

.set-row { display: flex; align-items: center; gap: 14px; padding: 12px 0; border-bottom: 1px solid var(--border-default); }
.set-row:last-of-type { border-bottom: none; }
.set-row-ico {
  width: 34px; height: 34px; border-radius: 10px;
  background: var(--bg-inset); border: 1px solid var(--border-default);
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center; flex-shrink: 0;
  transition: all 200ms ease;
}
.set-row:hover .set-row-ico {
  color: var(--text-primary); border-color: var(--border-strong);
  background: var(--bg-surface-hover, var(--bg-inset));
}

.set-row-text { flex: 1; min-width: 0; }
.set-row-title { font-size: 13px; font-weight: 650; color: var(--text-primary); margin: 0 0 2px; }
.set-row-desc { font-size: 11.5px; font-weight: 500; color: var(--text-muted); margin: 0; line-height: 1.4; }

.set-switch {
  width: 44px; height: 24px; border-radius: 999px;
  background: var(--border-strong); border: none; padding: 2px;
  cursor: pointer; position: relative; transition: background 200ms ease; flex-shrink: 0;
}
.set-switch.on { background: #00a699; }
.set-switch.on.amber-on { background: var(--accent-amber); }
.set-knob {
  display: block; width: 20px; height: 20px; border-radius: 50%;
  background: #ffffff; box-shadow: 0 1px 4px rgba(0,0,0,0.2);
  transition: transform 200ms cubic-bezier(0.22, 1, 0.36, 1);
}
.set-switch.on .set-knob { transform: translateX(20px); }

.set-banner {
  display: flex; align-items: center; gap: 12px; padding: 12px 18px;
  border-radius: 14px; background: rgba(57, 126, 112, 0.08); border: 1px solid rgba(57, 126, 112, 0.2);
}
.set-banner-icon { color: var(--accent-teal); flex-shrink: 0; }
.set-banner-text { display: flex; flex-direction: column; gap: 2px; }
.set-banner-title { font-size: 12.5px; font-weight: 700; color: var(--text-primary); }
.set-banner-desc { font-size: 11.5px; font-weight: 500; color: var(--text-muted); }

.set-band { display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
@media (max-width: 860px) {
  .set-band { grid-template-columns: 1fr; }
}

.set-field-label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); margin: 0 0 6px; }
.set-field-note { font-size: 11px; font-weight: 500; color: var(--text-muted); margin: 4px 0 0; }

.set-seg {
  display: inline-flex; background: var(--bg-inset); padding: 3px; border-radius: 10px;
  border: 1px solid var(--border-default); gap: 2px;
}
.set-seg-btn {
  display: inline-flex; align-items: center; gap: 6px; border: none; background: transparent;
  padding: 5px 12px; border-radius: 8px; font-size: 12px; font-weight: 600;
  color: var(--text-muted); cursor: pointer; transition: all 180ms ease;
}
.set-seg-btn.active {
  background: var(--card-bg); color: var(--text-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.06); font-weight: 700;
}

.set-input {
  flex: 1; min-width: 180px; height: 36px; border-radius: 8px;
  border: 1px solid var(--border-default); background: var(--bg-inset);
  color: var(--text-primary); padding: 0 12px; font-size: 12px;
  outline: none; transition: border-color 180ms ease;
}
.set-input:focus { border-color: var(--accent-coral); }
.set-input-mono { font-family: 'SF Mono', 'Fira Code', monospace; }

.set-dangerzone {
  margin-top: 14px; padding-top: 14px; border-top: 1px solid var(--border-default);
  display: flex; flex-direction: column; gap: 8px;
}
.set-danger-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: var(--accent-coral); margin: 0; }
.set-danger-btn {
  background: transparent; border: 1px solid rgba(255,49,68,0.3); border-radius: 8px;
  color: var(--accent-coral); font-size: 11.5px; font-weight: 650; padding: 6px 12px;
  cursor: pointer; transition: all 180ms ease;
}
.set-danger-btn:hover:not(:disabled) { background: rgba(255,49,68,0.08); border-color: var(--accent-coral); }
.set-danger-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.set-danger-btn.fill.armed { background: #ff3144; color: #ffffff; border-color: #ff3144; }

.set-dateinput {
  height: 30px; border-radius: 8px; border: 1px solid var(--border-default);
  background: var(--bg-inset); color: var(--text-primary); padding: 0 8px; font-size: 11px;
}

.set-updates {
  display: flex; align-items: center; justify-content: space-between; gap: 16px;
}
.set-update-ver { font-size: 18px; font-weight: 800; font-family: 'SF Mono', 'Fira Code', monospace; margin: 0 0 2px; color: var(--text-primary); }
.set-update-note { font-size: 11.5px; font-weight: 500; color: var(--text-muted); margin: 0; }
.set-update-ok { font-size: 11.5px; font-weight: 600; color: #00a699; margin: 0; }
.set-update-warn { font-size: 11.5px; font-weight: 700; color: var(--accent-amber); margin: 0; }
.set-update-err { font-size: 11.5px; font-weight: 600; color: var(--accent-coral); margin: 0; }
.set-update-actions { display: flex; align-items: center; gap: 8px; }
      `}</style>
    </div>
  );
}
