import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, X } from 'lucide-react';

// Folded-in raw-testing capability from the old TestMCP page: send one
// JSON-RPC method through the firewall proxy (full policy evaluation + audit)
// and inspect the masked response.

interface TestCallModalProps {
  serverName: string;
  serverType: 'stdio' | 'http';
  open: boolean;
  onClose: () => void;
}

interface TestOutcome {
  ok: boolean;
  decision?: string;
  response?: unknown;
  error?: string | null;
  durationMs?: number;
}

const METHODS = ['ping', 'tools/list', 'tools/call', 'resources/list'];

export default function TestCallModal({ serverName, serverType, open, onClose }: TestCallModalProps) {
  const [method, setMethod] = useState('ping');
  const [toolName, setToolName] = useState('');
  const [argsJson, setArgsJson] = useState('{}');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  function close() {
    onClose();
    setMethod('ping');
    setToolName('');
    setArgsJson('{}');
    setOutcome(null);
  }

  function paramsFor(): Record<string, unknown> {
    if (method === 'tools/call') {
      const args = (() => { try { return JSON.parse(argsJson || '{}'); } catch { return {}; } })();
      return { name: toolName.trim() || 'unknown_tool', arguments: args };
    }
    return {};
  }

  async function send() {
    setSending(true);
    setOutcome(null);
    try {
      const res = await fetch('/api/test-mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: serverName, method, params: paramsFor() }),
      });
      const data = await res.json();
      setOutcome({
        ok: !!data.ok,
        decision: data.result?.decision,
        response: data.result?.response ?? null,
        error: data.result?.error ?? data.error ?? null,
        durationMs: data.result?.durationMs,
      });
    } catch {
      setOutcome({ ok: false, error: 'Failed to reach the backend' });
    }
    setSending(false);
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="tco"
          className="tcm-overlay"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          onClick={close}
        >
          <motion.div
            key="tcm"
            className="tcm-modal"
            initial={{ opacity: 0, scale: 0.94, y: 16 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 16 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="tcm-head">
              <div>
                <h3 className="tcm-title">Send test call</h3>
                <p className="tcm-desc">
                  {serverName} — routed through the firewall ({serverType === 'http' ? 'HTTP ingress' : 'proxy spawn'}), evaluated and audited
                </p>
              </div>
              <button className="tcm-close" onClick={close}>✕</button>
            </div>

            <div className="tcm-body">
              <label className="tcm-label">JSON-RPC method</label>
              <div className="tcm-methods">
                {METHODS.map((m) => (
                  <button
                    key={m}
                    className={`tcm-method ${method === m ? 'active' : ''}`}
                    onClick={() => setMethod(m)}
                  >{m}</button>
                ))}
              </div>

              {method === 'tools/call' && (
                <>
                  <label className="tcm-label">Tool name</label>
                  <input
                    className="glass-input tcm-input"
                    placeholder="e.g. read_note"
                    value={toolName}
                    onChange={(e) => setToolName(e.target.value)}
                  />
                  <label className="tcm-label">Arguments (JSON)</label>
                  <textarea
                    className="glass-textarea tcm-args"
                    value={argsJson}
                    onChange={(e) => setArgsJson(e.target.value)}
                    spellCheck={false}
                  />
                </>
              )}

              {outcome && (
                <motion.div
                  className={`tcm-outcome ${outcome.ok ? 'ok' : 'fail'}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                >
                  <div className="tcm-outcome-head">
                    {outcome.ok ? (
                      <><span className="tcm-badge tcm-badge-allow">{outcome.decision}</span> OK{outcome.durationMs !== undefined ? ` — ${outcome.durationMs}ms` : ''}</>
                    ) : (
                      <><span className="tcm-badge tcm-badge-deny">{outcome.decision ?? 'error'}</span> Failed</>
                    )}
                  </div>
                  {outcome.response !== undefined && outcome.response !== null && (
                    <pre className="tcm-pre">{typeof outcome.response === 'string' ? outcome.response : JSON.stringify(outcome.response, null, 2)}</pre>
                  )}
                  {outcome.error && <p className="tcm-error">{outcome.error}</p>}
                </motion.div>
              )}
            </div>

            <div className="tcm-foot">
              <button className="tcm-btn tcm-btn-ghost" onClick={close}>Close</button>
              <button className="tcm-btn tcm-btn-primary" onClick={send} disabled={sending}>
                {sending ? 'Sending…' : (<><Play size={12} /> Send through proxy</>)}
              </button>
            </div>
          </motion.div>

          <style>{`
.tcm-overlay {
  position: fixed; inset: 0; z-index: 120;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center; padding: 20px;
}
.tcm-modal {
  width: 560px; max-width: 100%;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 24px;
  box-shadow: 0 32px 64px rgba(0,0,0,0.2);
  max-height: 85vh; overflow: hidden;
  display: flex; flex-direction: column;
}
.tcm-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 24px 28px 16px; border-bottom: 1px solid var(--border-default);
}
.tcm-title { font-size: 18px; font-weight: 750; letter-spacing: -0.01em; color: var(--text-primary); margin: 0; }
.tcm-desc { font-size: 12px; font-weight: 500; color: var(--text-muted); margin: 4px 0 0; }
.tcm-close {
  width: 30px; height: 30px; border-radius: 50%;
  border: none; cursor: pointer;
  background: var(--bg-inset); color: var(--text-muted); font-size: 12px;
}
.tcm-close:hover { color: var(--text-primary); }
.tcm-body { padding: 20px 28px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
.tcm-label {
  font-size: 10.5px; font-weight: 700; color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.06em; margin-top: 8px;
}
.tcm-label:first-child { margin-top: 0; }
.tcm-methods { display: flex; flex-wrap: wrap; gap: 6px; }
.tcm-method {
  padding: 6px 12px; border-radius: 9999px; cursor: pointer;
  font-size: 11px; font-weight: 700; font-family: 'SF Mono', 'Fira Code', monospace;
  background: var(--bg-inset); color: var(--text-muted);
  border: 1px solid transparent; transition: all 200ms ease;
}
.tcm-method.active { background: rgba(255,90,95,0.1); color: var(--accent-coral); border-color: rgba(255,90,95,0.35); }
.tcm-input { width: 100%; }
.tcm-args { min-height: 120px; }
.tcm-outcome { margin-top: 10px; padding: 12px 14px; border-radius: 12px; }
.tcm-outcome.ok { background: rgba(0,166,153,0.06); border: 1px solid rgba(0,166,153,0.18); }
.tcm-outcome.fail { background: rgba(255,90,95,0.06); border: 1px solid rgba(255,90,95,0.18); }
.tcm-outcome-head { display: flex; align-items: center; gap: 8px; font-size: 11.5px; font-weight: 700; color: var(--text-primary); }
.tcm-badge { padding: 2px 8px; border-radius: 9999px; font-size: 9.5px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.04em; }
.tcm-badge-allow { background: rgba(0,166,153,0.15); color: #00a699; }
.tcm-badge-deny { background: rgba(255,90,95,0.15); color: #ff5a5f; }
.tcm-pre {
  margin: 10px 0 0; padding: 10px; border-radius: 8px;
  background: var(--bg-inset); font-size: 11px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  color: var(--text-primary); white-space: pre-wrap; word-break: break-all;
  max-height: 180px; overflow-y: auto;
}
.tcm-error { font-size: 11.5px; font-weight: 600; color: #ff5a5f; margin: 8px 0 0; }
.tcm-foot {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 16px 28px 22px; border-top: 1px solid var(--border-default);
}
.tcm-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 9px 16px; border-radius: 9999px; cursor: pointer;
  font-size: 12.5px; font-weight: 700; border: none;
  transition: all 200ms ease;
}
.tcm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.tcm-btn-ghost { background: var(--bg-inset); color: var(--text-primary); border: 1px solid var(--border-default); }
.tcm-btn-primary {
  background: linear-gradient(135deg, var(--accent-coral), #e0484d);
  color: #fff; box-shadow: 0 2px 12px rgba(255,90,95,0.2);
}
.tcm-btn-primary:hover:not(:disabled) { transform: translateY(-1px); }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
