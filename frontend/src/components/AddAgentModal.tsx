import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

const QUICK_AGENTS: { name: string; type: string; path: string }[] = [
  { name: 'OpenCode', type: 'opencode', path: '~/.config/opencode/opencode.jsonc' },
  { name: 'Claude Code', type: 'claude', path: '~/.claude/settings.json' },
  { name: 'Claude Desktop', type: 'claude', path: '~/.config/claude/claude_desktop_config.json' },
  { name: 'Cursor', type: 'cursor', path: '~/.cursor/mcp.json' },
  { name: 'Codex', type: 'codex', path: '~/.codex/config.toml' },
  { name: 'GitHub Copilot', type: 'copilot', path: '~/.config/github-copilot/config.json' },
  { name: 'Cline', type: 'cline', path: '~/.cline/mcp.json' },
  { name: 'Continue', type: 'continue', path: '~/.continue/config.json' },
  { name: 'Windsurf', type: 'windsurf', path: '~/.windsurf/mcp.json' },
  { name: 'Aider', type: 'aider', path: '~/.aider/aider.conf.yml' },
];

interface AddAgentModalProps {
  open: boolean;
  logos: Record<string, string>;
  onClose: () => void;
  onAdded?: () => void;
}

/**
 * Shared "Add Agent" flow (quick-add presets + custom config path), the same
 * one the Agents page uses. Posts to POST /api/detect/manual and reports back
 * via onAdded so callers can refresh their own data.
 */
export default function AddAgentModal({ open, logos, onClose, onAdded }: AddAgentModalProps) {
  const [manualPath, setManualPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');

  function close() {
    onClose();
    setManualPath('');
    setAddError('');
  }

  async function handleAddAgent(path?: string) {
    const target = path || manualPath.trim();
    if (!target) return;
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch('/api/detect/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAddError(data.error || 'Not found at default path');
      } else {
        setManualPath('');
        onAdded?.();
        onClose();
      }
    } catch {
      setAddError('Failed to add agent');
    }
    setAdding(false);
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
          className="ag-overlay"
          onClick={close}
        >
          <motion.div
            key="modal"
            initial={{ opacity: 0, scale: 0.92, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 20 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            onClick={(e) => e.stopPropagation()}
            className="ag-modal"
          >
            <div className="ag-modal-head">
              <div>
                <h3 className="ag-modal-title">Add Agent</h3>
                <p className="ag-modal-desc">Select an AI agent to monitor</p>
              </div>
              <motion.button
                whileHover={{ scale: 1.1, rotate: 90 }}
                whileTap={{ scale: 0.9 }}
                onClick={close}
                className="ag-modal-close"
              >✕</motion.button>
            </div>

            <div className="ag-modal-body">
              <motion.div
                initial="hidden"
                animate="visible"
                variants={{
                  visible: { transition: { staggerChildren: 0.04 } },
                }}
                className="ag-quick-grid"
              >
                {QUICK_AGENTS.map((qa) => {
                  const logo = logos[qa.type];
                  return (
                    <motion.button
                      key={qa.type}
                      variants={{
                        hidden: { opacity: 0, y: 16 },
                        visible: { opacity: 1, y: 0 },
                      }}
                      whileHover={{ scale: 1.04, y: -2 }}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => handleAddAgent(qa.path)}
                      disabled={adding}
                      className="ag-quick-btn"
                      data-adding={adding || undefined}
                    >
                      {logo ? (
                        <img src={logo} alt={qa.name} referrerPolicy="no-referrer" className="ag-quick-logo" />
                      ) : (
                        <div className="ag-quick-logo-fallback">{qa.name.charAt(0)}</div>
                      )}
                      <span className="ag-quick-name">{qa.name}</span>
                      <span className="ag-quick-type">{qa.type}</span>
                      {adding && <div className="ag-quick-loader" />}
                    </motion.button>
                  );
                })}
              </motion.div>
            </div>

            <div className="ag-modal-foot">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--text-muted)', flexShrink: 0 }}>
                <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
              </svg>
              <input
                className="glass-input"
                placeholder="Or enter a custom config path…"
                value={manualPath}
                onChange={(e) => setManualPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleAddAgent(); }}
              />
              <motion.button
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={() => handleAddAgent()}
                disabled={adding || !manualPath.trim()}
                className="ag-btn ag-btn-primary"
                style={{ flexShrink: 0, borderRadius: 12 }}
              >
                {adding ? 'Adding…' : 'Add'}
              </motion.button>
            </div>
            {addError && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="ag-modal-error"
              >{addError}</motion.p>
            )}
          </motion.div>
        </motion.div>
      )}

      <style>{`
/* Shared Add-Agent modal styles (moved out of Agents.tsx so the Dashboard's
   "Connect Server" flow reuses the exact same markup). */
.ag-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0,0,0,0.5);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
}
.ag-modal {
  width: 640px; max-width: 100%;
  background: var(--bg-surface-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 28px;
  box-shadow: 0 32px 64px rgba(0,0,0,0.2);
  max-height: 85vh; overflow: hidden;
  display: flex; flex-direction: column;
}
.ag-modal-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  padding: 28px 32px 20px;
  border-bottom: 1px solid var(--border-default);
}
.ag-modal-title {
  font-size: 20px; font-weight: 750; letter-spacing: -0.01em;
  color: var(--text-primary); margin: 0;
}
.ag-modal-desc {
  font-size: 13px; color: var(--text-muted);
  margin: 4px 0 0; font-weight: 500;
}
.ag-modal-close {
  background: var(--bg-inset); border: none; border-radius: 10px;
  width: 32px; height: 32px; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-muted); font-size: 16px;
  transition: background 0.2s;
}
.ag-modal-close:hover {
  background: var(--bg-surface-hover);
}

.ag-modal-body {
  padding: 24px 32px; overflow: auto; flex: 1;
}
.ag-quick-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 12px;
}
.ag-quick-btn {
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  padding: 18px 8px 14px; border-radius: 18px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface); cursor: pointer;
  transition: all 0.25s;
  position: relative; overflow: hidden;
}
.ag-quick-btn:hover {
  border-color: var(--accent-coral);
  background: rgba(255,90,95,0.04);
}
.ag-quick-btn[data-adding] { opacity: 0.5; }
.ag-quick-logo {
  width: 40px; height: 40px; object-fit: contain; border-radius: 10px;
}
.ag-quick-logo-fallback {
  width: 40px; height: 40px; border-radius: 10px;
  background: var(--bg-inset);
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; color: var(--text-muted);
}
.ag-quick-name {
  font-size: 11px; font-weight: 650;
  color: var(--text-primary); text-align: center; line-height: 1.25;
}
.ag-quick-type {
  font-size: 9px; font-weight: 500;
  color: var(--text-muted);
  text-transform: uppercase; letter-spacing: 0.04em;
}
.ag-quick-loader {
  position: absolute; bottom: 0; left: 0; height: 2px;
  background: var(--accent-coral); border-radius: 1px;
  animation: agLoader 1.5s infinite;
}

.ag-modal-foot {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 32px 24px;
  border-top: 1px solid var(--border-default);
}
.ag-modal-foot input {
  flex: 1; font-size: 13px; padding: 10px 14px;
}
.ag-modal-error {
  font-size: 12px; color: #ff5a5f;
  margin: -8px 32px 16px; font-weight: 500;
}

.ag-btn {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 16px; border-radius: 9999px;
  font-size: 13px; font-weight: 600;
  cursor: pointer; border: none;
  transition: all 0.2s cubic-bezier(0.22,1,0.36,1);
  white-space: nowrap;
}
.ag-btn-primary {
  background: linear-gradient(135deg, var(--accent-coral), #e0484d);
  color: #fff; box-shadow: 0 4px 12px rgba(255,90,95,0.25);
}
.ag-btn-primary:hover {
  box-shadow: 0 6px 20px rgba(255,90,95,0.4);
  transform: translateY(-1px);
}
.ag-btn-primary:disabled {
  opacity: 0.5; cursor: not-allowed;
  transform: none; box-shadow: none;
}

@keyframes agLoader {
  0% { width: 0; left: 0; }
  50% { width: 100%; left: 0; }
  100% { width: 0; left: 100%; }
}

@media (max-width: 768px) {
  .ag-quick-grid { grid-template-columns: repeat(3, 1fr); }
  .ag-modal-foot { flex-direction: column; }
  .ag-modal-foot input { width: 100%; }
}
      `}</style>
    </AnimatePresence>
  );
}
