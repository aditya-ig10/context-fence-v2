import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface AddMCPModalProps {
  open: boolean;
  onClose: () => void;
  onAdded?: () => void;
}

interface TestResult {
  ok: boolean;
  error?: string;
  handshakeMs?: number;
}

/**
 * Add MCP Server flow (replaces the old dashboard "Connect Server" demo).
 * stdio servers: command + args + env. env values are entered in masked
 * (password) inputs and stored server-side in mcp_servers.env — they are
 * never returned by any API. "Test Connection" spawns the EXACT entered
 * config through the real proxy spawn path (initialize handshake + ping)
 * without registering anything.
 */
export default function AddMCPModal({ open, onClose, onAdded }: AddMCPModalProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function close() {
    onClose();
    setName('');
    setType('stdio');
    setCommand('');
    setArgs('');
    setUrl('');
    setEnv([{ key: '', value: '' }]);
    setTestResult(null);
    setError('');
  }

  function envObject(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of env) {
      if (row.key.trim()) out[row.key.trim()] = row.value;
    }
    return out;
  }

  function validate(): string {
    if (!name.trim()) return 'Server name is required';
    if (type === 'stdio' && !command.trim()) return 'Launch command is required for stdio servers';
    if (type === 'http' && !url.trim()) return 'URL is required for http servers';
    return '';
  }

  async function handleTest() {
    const invalid = validate();
    if (invalid) {
      setTestResult({ ok: false, error: invalid });
      return;
    }
    setTesting(true);
    setTestResult(null);
    setError('');
    try {
      const res = await fetch('/api/servers/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: type === 'stdio' ? command.trim() : undefined,
          args: type === 'stdio' ? args.trim().split(/\s+/).filter(Boolean) : undefined,
          env: envObject(),
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestResult({ ok: true, handshakeMs: data.handshakeMs });
      } else {
        setTestResult({ ok: false, error: data.error || 'Connection failed' });
      }
    } catch {
      setTestResult({ ok: false, error: 'Failed to reach the backend' });
    }
    setTesting(false);
  }

  async function handleSave() {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          type,
          command: type === 'stdio' ? command.trim() : undefined,
          args: type === 'stdio' ? args.trim().split(/\s+/).filter(Boolean) : undefined,
          url: type === 'http' ? url.trim() : undefined,
          env: envObject(),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to add server');
      } else {
        // Auto-setup: trigger the fetch sequence (spawn + live tools/list via
        // the proxy) so the new MCP is immediately usable — no manual Sync.
        fetch(`/api/servers/${encodeURIComponent(name.trim())}/fetch`, { method: 'POST' }).catch(() => {});
        onAdded?.();
        close();
      }
    } catch {
      setError('Failed to reach the backend');
    }
    setSaving(false);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="mcp-overlay"
          onClick={close}
        >
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="mcp-modal"
          >
            <div className="mcp-modal-head">
              <div>
                <h3 className="mcp-modal-title">Add MCP Server</h3>
                <p className="mcp-modal-desc">Register a server the firewall can route to</p>
              </div>
              <motion.button
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                onClick={close}
                className="mcp-modal-close"
              >✕</motion.button>
            </div>

            <div className="mcp-modal-body">
              <label className="mcp-label">Server name</label>
              <input
                className="glass-input"
                placeholder="e.g. my-notes-db"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />

              <label className="mcp-label">Transport</label>
              <div className="mcp-type-toggle">
                <button
                  className={`mcp-type-btn ${type === 'stdio' ? 'active' : ''}`}
                  onClick={() => { setType('stdio'); setTestResult(null); }}
                >Local (stdio)</button>
                <button
                  className={`mcp-type-btn ${type === 'http' ? 'active' : ''}`}
                  onClick={() => { setType('http'); setTestResult(null); }}
                >Remote (http)</button>
              </div>

              {type === 'stdio' ? (
                <>
                  <label className="mcp-label">Launch command</label>
                  <input
                    className="glass-input"
                    placeholder="e.g. npx"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                  />
                  <label className="mcp-label">Arguments (space-separated)</label>
                  <input
                    className="glass-input"
                    placeholder="e.g. -y @modelcontextprotocol/server-filesystem ~/notes"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />

                  <label className="mcp-label">Environment (secrets stay masked, never returned by the API)</label>
                  {env.map((row, i) => (
                    <div key={i} className="mcp-env-row">
                      <input
                        className="glass-input mcp-env-key"
                        placeholder="KEY"
                        value={row.key}
                        onChange={(e) => {
                          const next = [...env];
                          next[i] = { ...row, key: e.target.value };
                          setEnv(next);
                        }}
                      />
                      <input
                        className="glass-input mcp-env-val"
                        placeholder="value (token, API key…)"
                        type="password"
                        value={row.value}
                        onChange={(e) => {
                          const next = [...env];
                          next[i] = { ...row, value: e.target.value };
                          setEnv(next);
                        }}
                      />
                      <button
                        className="mcp-env-del"
                        onClick={() => setEnv(env.filter((_, j) => j !== i))}
                        disabled={env.length === 1}
                        title="Remove env var"
                      >✕</button>
                    </div>
                  ))}
                  <button className="mcp-env-add" onClick={() => setEnv([...env, { key: '', value: '' }])}>
                    + Add env var
                  </button>
                </>
              ) : (
                <>
                  <label className="mcp-label">Endpoint URL</label>
                  <input
                    className="glass-input"
                    placeholder="https://mcp.example.com/sse"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                  />
                  <p className="mcp-hint">http servers are registered for inventory; the proxy currently routes stdio servers.</p>
                </>
              )}

              {testResult && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`mcp-test-result ${testResult.ok ? 'ok' : 'fail'}`}
                >
                  {testResult.ok ? (
                    <>Connection OK — handshake + ping through the live proxy path in {testResult.handshakeMs}ms</>
                  ) : (
                    <>Connection failed: {testResult.error}</>
                  )}
                </motion.div>
              )}
              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mcp-modal-error"
                >{error}</motion.p>
              )}
            </div>

            <div className="mcp-modal-foot">
              <button
                className="mcp-btn mcp-btn-ghost"
                onClick={handleTest}
                disabled={testing || saving}
              >
                {testing ? 'Testing…' : 'Test Connection'}
              </button>
              <button
                className="mcp-btn mcp-btn-primary"
                onClick={handleSave}
                disabled={saving || testing}
              >
                {saving ? 'Adding…' : 'Add Server'}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}

      <style>{`
.mcp-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.mcp-modal {
  width: 600px; max-width: 100%;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 28px;
  box-shadow: 0 32px 64px rgba(0,0,0,0.2);
  max-height: 85vh; overflow: hidden;
  display: flex; flex-direction: column;
}
.mcp-modal-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 28px 32px 20px;
  border-bottom: 1px solid var(--border-default);
}
.mcp-modal-title {
  font-size: 20px; font-weight: 750; letter-spacing: -0.01em;
  color: var(--text-primary); margin: 0;
}
.mcp-modal-desc {
  font-size: 13px; font-weight: 500;
  color: var(--text-muted); margin: 4px 0 0;
}
.mcp-modal-close {
  width: 32px; height: 32px; border-radius: 50%;
  border: none; cursor: pointer;
  background: var(--bg-inset); color: var(--text-muted);
  font-size: 13px; display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
}
.mcp-modal-close:hover { color: var(--text-primary); }
.mcp-modal-body {
  padding: 24px 32px;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 8px;
}
.mcp-label {
  font-size: 11px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em;
  margin-top: 10px;
}
.mcp-label:first-child { margin-top: 0; }
.mcp-type-toggle {
  display: flex; gap: 8px; background: var(--bg-inset);
  padding: 4px; border-radius: 12px;
}
.mcp-type-btn {
  flex: 1; padding: 8px 12px; border: none; cursor: pointer;
  border-radius: 9px; font-size: 13px; font-weight: 700;
  color: var(--text-muted); background: transparent;
  transition: all 0.2s ease;
}
.mcp-type-btn.active {
  background: var(--bg-surface); color: var(--text-primary);
  box-shadow: 0 1px 4px rgba(0,0,0,0.15);
}
.mcp-env-row {
  display: flex; gap: 8px; align-items: center;
}
.mcp-env-key { flex: 0 0 40%; }
.mcp-env-val { flex: 1; }
.mcp-env-del {
  width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
  border: 1px solid var(--border-default); cursor: pointer;
  background: transparent; color: var(--text-muted); font-size: 11px;
}
.mcp-env-del:hover { color: #ff5a5f; border-color: rgba(255,90,95,0.4); }
.mcp-env-del:disabled { opacity: 0.35; cursor: default; }
.mcp-env-add {
  align-self: flex-start; border: none; cursor: pointer;
  background: transparent; color: var(--accent-coral);
  font-size: 12px; font-weight: 700; padding: 2px 0;
}
.mcp-hint { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 0; }
.mcp-test-result {
  margin-top: 12px; padding: 10px 14px; border-radius: 10px;
  font-size: 12px; font-weight: 600;
}
.mcp-test-result.ok { background: rgba(0,166,153,0.08); color: #00a699; border: 1px solid rgba(0,166,153,0.2); }
.mcp-test-result.fail { background: rgba(255,90,95,0.08); color: #ff5a5f; border: 1px solid rgba(255,90,95,0.2); }
.mcp-modal-error {
  font-size: 12px; font-weight: 600; color: #ff5a5f; margin: 8px 0 0;
}
.mcp-modal-foot {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 20px 32px 28px;
  border-top: 1px solid var(--border-default);
}
.mcp-btn {
  padding: 10px 18px; border-radius: 9999px; cursor: pointer;
  font-size: 13px; font-weight: 700; border: none;
  transition: all 0.2s ease;
}
.mcp-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.mcp-btn-ghost {
  background: var(--bg-inset); color: var(--text-primary);
  border: 1px solid var(--border-default);
}
.mcp-btn-ghost:hover:not(:disabled) { border-color: var(--border-strong); }
.mcp-btn-primary {
  background: linear-gradient(135deg, var(--accent-coral), #e0484d);
  color: #fff; box-shadow: 0 2px 12px rgba(255,90,95,0.2);
}
.mcp-btn-primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 16px rgba(255,90,95,0.3); }
      `}</style>
    </AnimatePresence>
  );
}
