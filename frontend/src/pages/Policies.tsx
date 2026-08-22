import { useEffect, useState, useRef } from 'react';
import { useCachedFetch, invalidateCache } from '../hooks/useCachedFetch';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield, ShieldCheck, ShieldAlert, Plus, Trash2, Pencil, RotateCcw,
  Download, Upload, Copy, ChevronDown,
} from 'lucide-react';

interface PolicyRule {
  id?: number;
  name: string;
  description?: string;
  action: string;
  reason: string;
  methods?: string[];
  tools?: string[];
  servers?: string[];
  param_contains?: string[];
  path_patterns?: string[];
  domain_patterns?: string[];
  custom?: boolean;
  origin?: 'Built-in' | 'Modified' | 'Custom';
}

interface EditableRow {
  name: string;
  description: string;
  action: 'allow' | 'deny' | 'log';
  reason: string;
  methods: string;
  tools: string;
  servers: string;
  param_contains: string;
  saving: boolean;
  error: string;
  editingOriginalName?: string | null;
  editingOrigin?: 'Built-in' | 'Modified' | 'Custom' | null;
}

interface AuditContext {
  id?: string;
  timestamp?: string;
  covered?: { kind: 'context-filter'; pattern?: string } | { kind: 'rule'; ruleName?: string } | null;
  serverExists?: boolean;
}

const ACTION_META: Record<string, { icon: typeof Shield; color: string; bg: string }> = {
  allow: { icon: ShieldCheck, color: '#00a699', bg: 'rgba(0,166,153,0.08)' },
  deny: { icon: ShieldAlert, color: '#ff5a5f', bg: 'rgba(255,90,95,0.08)' },
  log: { icon: Shield, color: '#fcb400', bg: 'rgba(252,180,0,0.08)' },
};

const TEMPLATES: { name: string; description: string; action: string; reason: string; methods: string; tools: string; param_contains: string }[] = [
  { name: 'block-destructive-commands', description: 'Block dangerous shell commands', action: 'deny', reason: 'Destructive command blocked by policy', methods: 'tools/call', tools: 'execute_command,bash,run_shell,exec', param_contains: 'rm -rf,dd if,> /dev/sda,chmod -R 777,:(){:|:&};:' },
  { name: 'block-secret-exfiltration', description: 'Block API keys and secrets from leaving', action: 'deny', reason: 'Potential secret exfiltration blocked', methods: 'tools/call', tools: 'http_request,fetch,web_request,curl', param_contains: 'sk-,ghp_,AIzaSy' },
  { name: 'block-db-destruction', description: 'Prevent destructive DB operations', action: 'deny', reason: 'Destructive database operation blocked', methods: 'tools/call', tools: '', param_contains: 'DROP TABLE,DROP DATABASE,TRUNCATE,ALTER TABLE' },
  { name: 'log-file-access', description: 'Log all filesystem reads and writes', action: 'log', reason: 'Filesystem access logged for audit', methods: 'tools/call', tools: 'read_file,write_file,list_directory,create_directory', param_contains: '' },
];

function formatConditions(rule: PolicyRule): string[] {
  const parts: string[] = [];
  if (rule.methods?.length) parts.push(`methods: ${rule.methods.join(', ')}`);
  if (rule.tools?.length) parts.push(`tools: ${rule.tools.join(', ')}`);
  if (rule.param_contains?.length) parts.push(`params contain: ${rule.param_contains.join(', ')}`);
  if (rule.path_patterns?.length) parts.push(`path: ${rule.path_patterns.join(', ')}`);
  if (rule.domain_patterns?.length) parts.push(`domain: ${rule.domain_patterns.join(', ')}`);
  return parts;
}

function freshRow(): EditableRow {
  return { name: '', description: '', action: 'deny', reason: '', methods: '', tools: '', servers: '', param_contains: '', saving: false, error: '' };
}

// Edit entry point shared by Built-in, Modified and Custom rows: saving an
// existing rule goes through PUT /api/policies/:name/override (upsert by
// name), so editing a built-in writes a custom_policies row that the engine
// evaluates instead of the YAML version.
function editRow(rule: PolicyRule): EditableRow {
  return {
    name: rule.name,
    description: rule.description || '',
    action: (rule.action as 'allow' | 'deny' | 'log') || 'deny',
    reason: rule.reason || '',
    methods: (rule.methods || []).join(','),
    tools: (rule.tools || []).join(','),
    servers: (rule.servers || []).join(','),
    param_contains: (rule.param_contains || []).join(','),
    saving: false,
    error: '',
    editingOriginalName: rule.name,
    editingOrigin: rule.origin || (rule.custom ? 'Custom' : 'Built-in'),
  };
}

export default function Policies() {
  const [editing, setEditing] = useState<EditableRow | null>(null);
  const [showTemplates, setShowTemplates] = useState(false);
  const [auditCtx, setAuditCtx] = useState<AuditContext | null>(null);
  const [justSaved, setJustSaved] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const newRowRef = useRef<HTMLTableRowElement>(null);
  const location = useLocation();
  const navigate = useNavigate();

  const { data: rulesData, refresh: refreshRules } = useCachedFetch<{ rules: PolicyRule[] }>('policies', () =>
    fetch('/api/policies').then((r) => r.json()), { maxAgeMs: 15_000 });
  const { data: statusData, refresh: refreshStatus } = useCachedFetch<{ rulesLoaded: number; logOnly: boolean; customCount: number }>('policies:status', () =>
    fetch('/api/policies/status').then((r) => r.json()), { maxAgeMs: 15_000 });
  const rules = rulesData?.rules ?? [];
  const status = statusData ?? { rulesLoaded: 0, logOnly: false, customCount: 0 };

  function invalidatePolicies() {
    invalidateCache((k) => k.startsWith('policies') || k === 'stats');
    refreshRules();
    refreshStatus();
  }

  // Shared entry point for the Firewall page's "Add Rule" button: opening
  // /policies?new=1 drops straight into the same create-policy row used by
  // "New Policy" (one implementation, two entry points).
  // Shared entry point for the Firewall page's "Add Rule" button: the router
  // navigates here with state { new: true }, which drops straight into the
  // same create-policy row used by "New Policy" (one implementation, two
  // entry points). Router state (not a URL param) is used so the signal
  // survives dev-mode remounts and doesn't pollute the address bar.
  useEffect(() => {
    const state = location.state as { new?: boolean; prefill?: Partial<EditableRow>; fromAudit?: AuditContext } | null;
    if (state?.new) {
      setAuditCtx(state.fromAudit ?? null);
      setJustSaved(null);
      setEditing(state.prefill ? { ...freshRow(), ...state.prefill } : freshRow());
    }
  }, [location.state]);

  useEffect(() => {
    if (editing && editing.name && newRowRef.current) {
      newRowRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [editing?.name]);

  async function handleSave() {
    const row = editing;
    if (!row) return;
    if (!row.name.trim()) { setEditing({ ...row, error: 'Name is required' }); return; }
    setEditing({ ...row, saving: true, error: '' });
    const body = {
      name: row.name.trim(),
      description: row.description.trim(),
      action: row.action,
      reason: row.reason.trim() || `Custom ${row.action} rule`,
      methods: row.methods.trim(),
      tools: row.tools.trim(),
      servers: row.servers.trim(),
      param_contains: row.param_contains.trim(),
    };
    try {
      // Editing an existing rule (Built-in, Modified or Custom) = override
      // upsert by name. Creating new = /create (also an upsert now, so a
      // name clash intentionally becomes an override).
      const url = row.editingOriginalName
        ? `/api/policies/${encodeURIComponent(row.name.trim())}/override`
        : '/api/policies/create';
      const res = await fetch(url, {
        method: row.editingOriginalName ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) { setEditing({ ...row, saving: false, error: data.error || 'Failed' }); return; }
      if (auditCtx) {
        setJustSaved(`Rule "${row.name.trim()}" is now active — the next matching call will be blocked`);
        setAuditCtx(null);
      }
      setEditing(null);
      invalidatePolicies();
    } catch { setEditing({ ...row, saving: false, error: 'Failed to create' }); }
  }

  async function handleDelete(id: number) {
    await fetch(`/api/policies/${id}`, { method: 'DELETE' });
    invalidatePolicies();
  }

  async function handleRestore(name: string) {
    await fetch(`/api/policies/${encodeURIComponent(name)}/restore`, { method: 'POST' });
    invalidatePolicies();
  }

  function applyTemplate(t: typeof TEMPLATES[0]) {
    setEditing({ ...freshRow(), name: t.name, description: t.description, action: t.action as 'allow' | 'deny' | 'log', reason: t.reason, methods: t.methods, tools: t.tools, param_contains: t.param_contains });
    setAuditCtx(null);
    setShowTemplates(false);
  }

  function handleExport() {
    const customs = rules.filter(r => r.custom);
    if (!customs.length) return;
    const blob = new Blob([JSON.stringify(customs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'custom-policies.json'; a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported: PolicyRule[] = JSON.parse(text);
      for (const rule of imported) {
        await fetch('/api/policies/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: rule.name, description: rule.description || '', action: rule.action,
            reason: rule.reason || '', methods: (rule.methods || []).join(','),
            tools: (rule.tools || []).join(','), servers: (rule.servers || []).join(','),
            param_contains: (rule.param_contains || []).join(','),
          }),
        });
      }
      invalidatePolicies();
    } catch { alert('Failed to import policies'); }
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="section-title">Policies</h2>
          <p className="text-sm mt-1" style={{ color: '#8e706f' }}>{status.rulesLoaded} rules · {status.customCount} custom</p>
        </div>
        <div className="flex items-center gap-2">
          <div style={{ position: 'relative' }}>
            <button onClick={() => setShowTemplates(!showTemplates)} className="btn-ghost" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '8px 14px' }}>
              <Copy size={13} /> Templates <ChevronDown size={12} />
            </button>
            <AnimatePresence>
              {showTemplates && (
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  style={{ position: 'absolute', top: '100%', right: 0, marginTop: 4, width: 280, background: 'var(--bg-surface-elevated)', border: '1px solid var(--border-strong)', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.15)', zIndex: 10, overflow: 'hidden' }}
                >
                  {TEMPLATES.map((t, i) => (
                    <button key={t.name} onClick={() => applyTemplate(t)}
                      style={{ display: 'block', width: '100%', padding: '12px 16px', textAlign: 'left', border: 'none', borderBottom: i < TEMPLATES.length - 1 ? '1px solid var(--border-default)' : 'none', background: 'transparent', cursor: 'pointer' }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-surface-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ fontSize: 13, fontWeight: 650, color: 'var(--text-primary)', display: 'block' }}>{t.name}</span>
                      <span style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, display: 'block' }}>{t.description}</span>
                    </button>
                  ))}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {rules.some(r => r.custom) && (
            <button onClick={handleExport} className="btn-ghost" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '8px 14px' }}>
              <Download size={13} /> Export
            </button>
          )}
          <button onClick={() => fileInputRef.current?.click()} className="btn-ghost" style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '8px 14px' }}>
            <Upload size={13} /> Import
          </button>
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleImport} style={{ display: 'none' }} />

          <motion.button whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.97 }}
            onClick={() => { setEditing(freshRow()); setShowTemplates(false); setAuditCtx(null); setJustSaved(null); }}
            style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, padding: '8px 20px', borderRadius: 9999, border: 'none', background: 'linear-gradient(135deg, #ff5a5f 0%, #e0484d 100%)', color: '#fff', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 20px rgba(255,90,95,0.35)', position: 'relative', overflow: 'hidden' }}
          >
            <Plus size={14} /> New Policy
          </motion.button>
        </div>
      </div>

      {justSaved && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: 'rgba(0,166,153,0.08)', border: '1px solid rgba(0,166,153,0.25)', borderRadius: 12, padding: '10px 16px', marginBottom: 14 }}>
          <ShieldCheck size={15} style={{ color: '#00a699', flexShrink: 0 }} />
          <span style={{ flex: 1, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)' }}>{justSaved}</span>
          <button onClick={() => navigate('/logs')} className="btn-ghost" style={{ fontSize: 11.5, padding: '6px 12px', whiteSpace: 'nowrap' }}>
            Back to audit log
          </button>
        </div>
      )}

      {editing !== null && auditCtx && (
        <div style={{ background: auditCtx.covered ? 'rgba(252,180,0,0.08)' : 'rgba(0,166,153,0.08)', border: `1px solid ${auditCtx.covered ? 'rgba(252,180,0,0.3)' : 'rgba(0,166,153,0.25)'}`, borderRadius: 12, padding: '12px 16px', marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {auditCtx.covered ? <ShieldAlert size={14} style={{ color: '#c98a00', flexShrink: 0 }} /> : <ShieldCheck size={14} style={{ color: '#00a699', flexShrink: 0 }} />}
            <p style={{ margin: 0, fontSize: 12.5, fontWeight: 600, color: 'var(--text-primary)', lineHeight: 1.45 }}>
              {auditCtx.covered?.kind === 'context-filter'
                ? `This call was already blocked by the built-in context filter${auditCtx.covered.pattern ? ` (pattern: ${auditCtx.covered.pattern})` : ''} — saving would create a duplicate. Create anyway if you want a custom variant.`
                : auditCtx.covered?.kind === 'rule'
                  ? `This call was already blocked by rule "${auditCtx.covered.ruleName}" — saving would create a duplicate. Create anyway to narrow or widen the scope.`
                  : `Prefilled from audit log${auditCtx.timestamp ? ` entry ${auditCtx.timestamp}` : ''} — will block this tool${editing.servers ? ` on ${editing.servers}` : ''} going forward. Adjust scope, then save.`}
            </p>
          </div>
          {auditCtx.serverExists === false && (
            <p style={{ margin: '6px 0 0', fontSize: 11.5, fontWeight: 550, color: '#c98a00' }}>
              Source connector "{editing.servers}" is no longer registered — the rule still matches by name.
            </p>
          )}
        </div>
      )}

      {rules.length === 0 && editing === null ? (
        <div className="glass-panel text-center py-12">
          <p className="text-lg font-semibold" style={{ color: '#8e706f' }}>No policies configured</p>
          <p className="text-sm mt-1" style={{ color: '#8e706f' }}>Create a policy to control MCP request behaviour</p>
        </div>
      ) : (
        <motion.div
          initial="hidden" animate="visible"
          variants={{ visible: { transition: { staggerChildren: 0.03 } } }}
          className="data-table-card"
        >
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: '42%' }}>Rule</th>
                <th style={{ width: '12%' }}>Action</th>
                <th style={{ width: '10%' }}>Origin</th>
                <th style={{ textAlign: 'right', width: '8%' }} />
              </tr>
            </thead>
            <tbody>
              {editing !== null && (() => {
                const e = editing;
                return (
                <tr
                  ref={newRowRef}
                  style={{ background: 'rgba(255,90,95,0.04)' }}
                >
                  <td style={{ verticalAlign: 'top' }}>
                    <input className="glass-input" style={{ width: '100%', fontSize: 12, padding: '8px 10px', marginBottom: 6 }} placeholder="Policy name" value={e.name} onChange={ev => setEditing({ ...e, name: ev.target.value })} autoFocus />
                    <input className="glass-input" style={{ width: '100%', fontSize: 12, padding: '8px 10px', marginBottom: 6 }} placeholder="Description (optional)" value={e.description} onChange={ev => setEditing({ ...e, description: ev.target.value })} />
                    <input className="glass-input" style={{ width: '100%', fontSize: 12, padding: '8px 10px', marginBottom: 6 }} placeholder="Reason shown when triggered" value={e.reason} onChange={ev => setEditing({ ...e, reason: ev.target.value })} />
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <input className="glass-input" style={{ flex: 1, minWidth: 100, fontSize: 11, padding: '6px 8px', fontFamily: 'monospace' }} placeholder="methods (e.g. tools/call)" value={e.methods} onChange={ev => setEditing({ ...e, methods: ev.target.value })} />
                      <input className="glass-input" style={{ flex: 1, minWidth: 100, fontSize: 11, padding: '6px 8px', fontFamily: 'monospace' }} placeholder="tools (e.g. execute_command)" value={e.tools} onChange={ev => setEditing({ ...e, tools: ev.target.value })} />
                      <input className="glass-input" style={{ flex: 1, minWidth: 100, fontSize: 11, padding: '6px 8px', fontFamily: 'monospace' }} placeholder="servers (comma-separated)" value={e.servers} onChange={ev => setEditing({ ...e, servers: ev.target.value })} />
                      <input className="glass-input" style={{ flex: 1, minWidth: 100, fontSize: 11, padding: '6px 8px', fontFamily: 'monospace' }} placeholder="param contains (e.g. DROP TABLE)" value={e.param_contains} onChange={ev => setEditing({ ...e, param_contains: ev.target.value })} />
                    </div>
                    {auditCtx && e.servers && (
                      <button
                        onClick={() => setEditing({ ...e, servers: '' })}
                        style={{ marginTop: 6, fontSize: 11, fontWeight: 600, color: '#5b8cff', background: 'transparent', border: 'none', cursor: 'pointer', padding: 0 }}
                        title="Remove the connector scope so the rule blocks this tool on every connector"
                      >
                        Widen to all connectors
                      </button>
                    )}
                    {e.error && <p style={{ fontSize: 11, color: '#ff5a5f', marginTop: 6 }}>{e.error}</p>}
                  </td>
                  <td style={{ verticalAlign: 'top' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {(['allow', 'deny', 'log'] as const).map(a => {
                        const m = ACTION_META[a];
                        const Icon = m.icon;
                        const active = e.action === a;
                        return (
                          <button key={a} onClick={() => setEditing({ ...e, action: a })}
                            style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 9999, border: `1.5px solid ${active ? m.color : 'var(--border-default)'}`, background: active ? m.bg : 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 700, color: active ? m.color : 'var(--text-muted)', textTransform: 'uppercase', transition: 'all 0.15s' }}
                          ><Icon size={12} /> {a}</button>
                        );
                      })}
                    </div>
                  </td>
                  <td style={{ verticalAlign: 'top' }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: 'rgba(99,102,241,0.1)', color: '#6366f1' }}>New</span>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button onClick={() => setEditing(null)} className="btn-ghost" style={{ fontSize: 11, padding: '6px 12px', borderRadius: 9999 }}>Cancel</button>
                      <button onClick={handleSave} disabled={e.saving || !e.name.trim()} className="btn-primary" style={{ fontSize: 11, padding: '6px 16px', borderRadius: 9999, whiteSpace: 'nowrap', opacity: e.saving || !e.name.trim() ? 0.6 : 1 }}>
                        {e.saving ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  </td>
                </tr>
                );
              })()}

              {rules.map((rule, idx) => {
                const ac = ACTION_META[rule.action] || ACTION_META.log;
                const conditions = formatConditions(rule);
                const origin = rule.origin || (rule.custom ? 'Custom' : 'Built-in');
                const isCustom = origin === 'Custom';
                const isModified = origin === 'Modified';
                const key = isCustom ? `c-${rule.id}` : `f-${rule.name}`;
                return (
                  <motion.tr
                    key={key}
                    variants={{ hidden: { opacity: 0 }, visible: { opacity: 1 } }}
                  >
                    <td style={{ verticalAlign: 'top' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 650, color: 'var(--text-primary)' }}>{rule.name}</span>
                        {isCustom && <span style={{ fontSize: 9, fontWeight: 600, padding: '2px 7px', borderRadius: 4, background: 'var(--bg-inset)', color: 'var(--text-muted)' }}>CUSTOM</span>}
                      </div>
                      {rule.description && <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 3, lineHeight: 1.4 }}>{rule.description}</p>}
                      <p style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.4 }}>{rule.reason}</p>
                      {conditions.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                          {conditions.map((c, i) => (
                            <span key={i} style={{ fontSize: 9, fontWeight: 600, fontFamily: 'monospace', padding: '3px 8px', borderRadius: 5, background: 'var(--bg-inset)', color: 'var(--text-muted)' }}>{c}</span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      <span style={{ fontSize: 12, fontWeight: 700, color: ac.color, textTransform: 'uppercase', letterSpacing: '0.03em' }}>{rule.action}</span>
                    </td>
                    <td style={{ verticalAlign: 'top' }}>
                      {isModified ? (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: 'rgba(252,180,0,0.12)', color: '#b8860b' }}>Modified</span>
                      ) : isCustom ? (
                        <span style={{ fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 6, background: 'rgba(255,90,95,0.08)', color: '#ff5a5f' }}>Custom</span>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Built-in</span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                        {isModified && (
                          <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                            onClick={() => handleRestore(rule.name)}
                            title="Restore default"
                            style={{ height: 28, padding: '0 10px', borderRadius: 9999, border: 'none', background: 'rgba(252,180,0,0.12)', color: '#b8860b', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700 }}
                          ><RotateCcw size={12} /> Restore default</motion.button>
                        )}
                        {(isCustom || isModified || origin === 'Built-in') && (
                          <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                            onClick={() => setEditing(editRow(rule))}
                            title={origin === 'Built-in' ? 'Edit built-in policy (creates an override)' : 'Edit policy'}
                            style={{ width: 28, height: 28, borderRadius: 9999, border: 'none', background: 'var(--bg-inset)', color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          ><Pencil size={13} /></motion.button>
                        )}
                        {isCustom && (
                          <motion.button whileHover={{ scale: 1.1 }} whileTap={{ scale: 0.9 }}
                            onClick={() => handleDelete(rule.id!)}
                            title="Delete policy"
                            style={{ width: 28, height: 28, borderRadius: 9999, border: 'none', background: 'rgba(255,90,95,0.08)', color: '#ff5a5f', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
                          ><Trash2 size={13} /></motion.button>
                        )}
                      </div>
                    </td>
                  </motion.tr>
                );
              })}
            </tbody>
          </table>
        </motion.div>
      )}
    </div>
  );
}
