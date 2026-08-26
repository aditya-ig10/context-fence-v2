import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { loadPolicyFromDisk } from './loader.js';
import db from '../db/index.js';
import { getMergedPolicies } from '../routes/policies.js';

export interface PolicyRule {
  name: string;
  description?: string;
  // Conditions (all must match if present)
  methods?: string[];          // e.g. ['tools/call']
  tools?: string[];            // tool names to match
  servers?: string[];          // connector/server names to scope the rule to
  path_patterns?: string[];    // regex patterns for file paths in params
  domain_patterns?: string[];  // v2: matched against host of http_request/fetch  // regex patterns for HTTP domains
  param_contains?: string[];   // strings that must NOT be in params
  // Action
  action: 'allow' | 'deny' | 'log';
  reason: string;
}

function normalizeUnicode(s: string): string { return s.normalize('NFKC').toLowerCase(); }
function decodeBase64EnvSafe(b64: string): string {
  try { return Buffer.from(b64, 'base64').toString('utf8'); } catch { return b64; }
}

export interface PolicyConfig {
  version: number;
  log_only: boolean;
  rules: PolicyRule[];
    // v2: stricter base64 env decode (fixes false-negative on padded payloads)
  context_filter: {
    enabled: boolean;
    patterns: string[];  // regex patterns for secrets/sensitive data
  };
}

const DEFAULT_POLICY: PolicyConfig = {
  version: 1,
  log_only: true,
  rules: [
    {
      name: 'block-destructive-file-ops',
      description: 'Prevent deletion of files and directories',
      methods: ['tools/call'],
      tools: ['delete_file', 'remove_file', 'rm', 'unlink'],
      action: 'deny',
      reason: 'Destructive file operation blocked by policy',
    },
    {
      name: 'block-db-drops',
      description: 'Prevent DROP TABLE and DROP DATABASE',
      methods: ['tools/call'],
      param_contains: ['DROP TABLE', 'DROP DATABASE', 'TRUNCATE TABLE'],
      action: 'deny',
      reason: 'Destructive database operation blocked by policy',
    },
    {
      name: 'block-env-exfil',
      description: 'Block .env file content leaving via HTTP tools',
      methods: ['tools/call'],
      tools: ['http_request', 'fetch', 'web_request', 'curl'],
      param_contains: ['OPENAI_API_KEY', 'DATABASE_URL', 'SECRET_KEY', 'PRIVATE_KEY'],
      action: 'deny',
      reason: 'Potential secret exfiltration blocked by policy',
    },
    {
      name: 'log-filesystem-access',
      description: 'Log all filesystem read/write operations',
      methods: ['tools/call'],
      tools: ['read_file', 'write_file', 'list_directory', 'create_directory'],
      action: 'log',
      reason: 'Filesystem access logged for audit',
    },
    {
      name: 'allow-all',
      description: 'Default allow rule',
      action: 'allow',
      reason: 'Allowed by default policy',
    },
  ],
    // v2: stricter base64 env decode (fixes false-negative on padded payloads)
  context_filter: {
    enabled: true,
    // Case-insensitive patterns carry a leading (?i) marker — V8 does not
    // support inline (?i) modifiers, so compilePattern() strips the marker
    // and applies the flag at compile time; a bare (?i) would make
    // new RegExp() THROW and the try/catch would silently kill the pattern.
    // Patterns WITHOUT the marker are case-sensitive (e.g. the ${VAR} /
    // $VAR env-var shapes are deliberately uppercase-only so lowercase
    // template literals like ${name} are not false positives).
    patterns: [
      '(?i)(api[_-]?key|apikey)\\s*[:=]\\s*[\\w-]{20,}',
      '(?i)(secret|password|passwd|pwd)\\s*[:=]\\s*\\S{8,}',
      '(?i)(bearer|token)\\s+[\\w.-]{20,}',
      'eyJ[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+\\.[a-zA-Z0-9_-]+',  // JWT
      '(?i)database[_-]?url\\s*[:=]\\s*\\S+',
      'sk-[a-zA-Z0-9]{20,}',  // OpenAI keys
      'ghp_[a-zA-Z0-9]{36}',  // GitHub tokens
      '-----BEGIN [A-Z ]+ PRIVATE KEY-----',
      '\\$\\{[A-Z][A-Z0-9_]{2,}\\}',                    // ${VAR} env-var reference
      '(?:process\\.env|os\\.environ|environ)\\.[A-Za-z_][A-Za-z0-9_]*',  // process.env.X / os.environ.X
      '(?<![A-Za-z0-9_$])\\$[A-Z][A-Z0-9_]{2,}(?![A-Z0-9_])',  // $VAR shell-style reference
    ],
  },
};

/** Compile a context-filter pattern: a leading (?i) marker is stripped and
 *  applied as the RegExp 'i' flag (V8 rejects inline (?i)); patterns without
 *  the marker stay case-sensitive. */
function compilePattern(pattern: string, flags: string): RegExp {
  const ci = pattern.startsWith('(?i)');
  return new RegExp(ci ? pattern.slice(4) : pattern, flags + (ci ? 'i' : ''));
}

let currentPolicy: PolicyConfig = DEFAULT_POLICY;
let policyPath: string | null = null;

export function loadPolicy(dir: string): PolicyConfig {
  const candidates = [
    join(dir, 'context-fence.yaml'),
    join(dir, 'context-fence.yml'),
    join(dir, 'mcp-firewall.yaml'),
    join(dir, '.context-fence.yaml'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf-8');
        const parsed = yaml.load(raw) as PolicyConfig;
        currentPolicy = { ...DEFAULT_POLICY, ...parsed };
        policyPath = candidate;
        console.log(`[policy] Loaded from ${candidate} — ${currentPolicy.rules.length} rules`);
        return currentPolicy;
      } catch (err) {
        console.error(`[policy] Failed to parse ${candidate}:`, err);
      }
    }
  }

  console.log('[policy] No policy file found, using defaults');
  return DEFAULT_POLICY;
}

export function getPolicy(): PolicyConfig {
  return currentPolicy;
}

// Effective log_only: a settings override (written by the Settings page
// "Policy defaults" toggle) takes precedence over the YAML's log_only field.
// The override is ALSO written through to the policy YAML when one is loaded,
// so the setting survives restarts even if the settings table were reset.
export function isLogOnly(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'log_only'")
    .get() as { value: string } | undefined;
  if (row !== undefined) return row.value !== 'false';
  return currentPolicy.log_only;
}

export function setLogOnly(enabled: boolean): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('log_only', String(enabled));
  currentPolicy = { ...currentPolicy, log_only: enabled };
  if (policyPath && existsSync(policyPath)) {
    try {
      const doc = yaml.load(readFileSync(policyPath, 'utf-8')) as PolicyConfig;
      doc.log_only = enabled;
      writeFileSync(policyPath, yaml.dump(doc));
    } catch (err) {
      console.error(`[policy] Failed to write log_only to ${policyPath}:`, err);
    }
  }
}

export function getPolicyPath(): string | null {
  return policyPath;
}

export interface EvalResult {
  decision: 'allow' | 'deny' | 'log';
  reason: string;
  rule: string;
  durationMs: number;
}

/** Verbatim deny reason for env/API/JWT-context calls — what the agent sees
 *  in the JSON-RPC error and what the audit log shows for those denies. */
export const ENV_BLOCK_MESSAGE =
  'ContextFence: Firewall blocked the mcp call since this session has env/ API/ JWT context in it. If you still want to proceed disable mcp-firewall or disable block env mcp req in settings';

/** Log-only counterpart: the session carries env context but log-only mode is
 *  on, so the call is not blocked — only recorded. */
export const ENV_LOG_MESSAGE =
  'ContextFence: env/ API/ JWT context detected — logged (log-only mode, not blocked). Disable log-only mode to enforce the block';

/** Kill-switch for MCP calls carrying env/API/JWT context. Controlled by the
 *  `block_env_mcp` setting (Settings → Policy Defaults); DEFAULT ON (opt-out)
 *  so env/secret reads are blocked (or at minimum audited) out of the box. */
export function isEnvBlockEnabled(): boolean {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = 'block_env_mcp'")
    .get() as { value: string } | undefined;
  return row === undefined ? true : row.value !== 'false';
}

// ── Session-scoped env context ──────────────────────────────────────────────
// The ENV_BLOCK_MESSAGE promises session scope ("this session has env/ API/
// JWT context in it"), so the flag must be tracked per session, not per call.
// Keyed by transport session (TCP connection, HTTP remote key). Once a
// session carries env/API/JWT context — in a request OR in an upstream MCP
// response (e.g. a shell/filesystem tool returning .env contents) — every
// subsequent MCP call from that session is blocked with ENV_BLOCK_MESSAGE.
const envFlaggedSessions = new Map<string, number>();
const MAX_ENV_SESSIONS = 10_000;

export function isSessionEnvFlagged(key: string): boolean {
  return envFlaggedSessions.has(key);
}

/** Mark a session as env-contaminated. Returns true only on the FIRST flag
 *  (callers use that to emit a single realtime audit row per session). */
export function markSessionEnv(key: string): boolean {
  if (envFlaggedSessions.has(key)) return false;
  if (envFlaggedSessions.size >= MAX_ENV_SESSIONS) {
    let oldest: string | null = null;
    let oldestAt = Infinity;
    for (const [k, at] of envFlaggedSessions) {
      if (at < oldestAt) {
        oldestAt = at;
        oldest = k;
      }
    }
    if (oldest !== null) envFlaggedSessions.delete(oldest);
  }
  envFlaggedSessions.set(key, Date.now());
  return true;
}

export function envFlaggedSessionCount(): number {
  return envFlaggedSessions.size;
}

/** Does the request carry env/API/JWT context? Reuses the context-filter
 *  patterns (API keys, JWTs, bearer tokens, $VAR / ${VAR} / process.env.X
 *  env-var references, PEM blocks), scanning raw params AND base64-decoded
 *  tokens so encoded payloads are still caught. */
export function hasEnvSecretContext(params: unknown): boolean {
  const policy = getPolicy();
  const paramStr = JSON.stringify(params || {});
  const searchStr = paramStr + '\n' + decodeBase64Tokens(paramStr);
  for (const pattern of policy.context_filter.patterns) {
    try {
      if (compilePattern(pattern, '').test(searchStr)) return true;
    } catch { /* skip bad regex */ }
  }
  return false;
}

const NON_ALNUM = /[^a-z0-9]+/g;
const B64_TOKEN = /[a-z0-9+/]{16,}={0,2}/gi;

/** Lowercase + strip every non-alphanumeric char so "rm -rf", "rm\u2013rf",
 *  "RM \n-RF", "rm\\ -rf", "drop\tTABLE" all collapse to one shape.
 *  JSON.stringify re-escapes control chars as literal \n / \t / \r / \f / \b,
 *  so those two-char sequences are collapsed first. */
function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/\\[nrtfb]/g, '').replace(NON_ALNUM, '');
}

/** Pull base64-looking tokens out of a string and decode them, so encoded
 *  payloads (e.g. Buffer.from('rm -rf /tmp/evil').toString('base64')) are
 *  still visible to string needles and context-filter regexes. */
function decodeBase64Tokens(s: string): string {
  const decoded: string[] = [];
  for (const tok of s.match(B64_TOKEN) ?? []) {
    try {
      const text = Buffer.from(tok, 'base64').toString('utf-8');
      if (text && !text.includes('\uFFFD') && text.length >= 4) decoded.push(text);
    } catch {
      /* not valid base64 */
    }
  }
  return decoded.join('\n');
}

/** Collect every leaf string value in a params tree (recursively), plus any
 *  base64-decoded tokens — path/domain patterns match against these, not
 *  against the serialized JSON wrapper (a '^file:' anchor must match the
 *  start of the URL value, not the start of the whole params object). */
function collectParamValues(params: unknown): string[] {
  const values: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      values.push(v);
      values.push(...decodeBase64Tokens(v).split('\n').filter(Boolean));
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === 'object') {
      for (const child of Object.values(v)) walk(child);
    }
  };
  walk(params);
  return values;
}

function matchesRule(rule: PolicyRule, method: string, params: unknown, serverName?: string): boolean {
  const paramStr = JSON.stringify(params || {});
  const decoded = decodeBase64Tokens(paramStr);
  const haystack = normalizeForMatch(paramStr + '\n' + decoded);
  const paramValues = collectParamValues(params);

  if (rule.methods && !rule.methods.some((m) => m.toLowerCase() === method.toLowerCase())) return false;

  if (rule.servers) {
    const lowerServers = rule.servers.map((s) => s.toLowerCase());
    // Server-scoped rules only apply when we KNOW the request came from that
    // connector. An unknown server name is a miss for scoped rules — a
    // per-connector deny must never leak onto another connector.
    if (!serverName || !lowerServers.includes(serverName.toLowerCase())) return false;
  }

  if (rule.tools) {
    const toolName = (params as Record<string, unknown>)?.name as string | undefined;
    if (toolName !== undefined && toolName !== null) {
      const lowerTools = rule.tools.map((t) => t.toLowerCase());
      if (!lowerTools.includes(String(toolName).toLowerCase())) return false;
    }
    // Tool name absent: we cannot confirm the tool identity, so we do not let
    // the tools condition force a miss — remaining conditions still apply.
  }

  if (rule.param_contains) {
    const hasMatch = rule.param_contains.some((s) => haystack.includes(normalizeForMatch(s)));
    if (!hasMatch) return false;
  }

  if (rule.path_patterns) {
    const hasMatch = rule.path_patterns.some((p) => {
      try { return paramValues.some((v) => new RegExp(p, 'i').test(v)); } catch { return false; }
    });
    if (!hasMatch) return false;
  }

  if (rule.domain_patterns) {
    const hasMatch = rule.domain_patterns.some((p) => {
      try { return paramValues.some((v) => new RegExp(p, 'i').test(v)); } catch { return false; }
    });
    if (!hasMatch) return false;
  }

  return true;
}

export function evaluateRequest(method: string, params: unknown, serverName?: string, sessionKey?: string): EvalResult {
  const t0 = Date.now();
  const policy = getPolicy();

  // Session-scoped env block: the session has ALREADY carried env/API/JWT
  // context (an earlier request, or an upstream response that leaked it), so
  // every further MCP call from it is blocked with the ContextFence message.
  // Runs first — the contamination is a session fact, not a param fact.
  if (sessionKey && isEnvBlockEnabled() && isSessionEnvFlagged(sessionKey)) {
    const duration = Date.now() - t0;
    const decision = isLogOnly() ? 'log' : 'deny';
    return {
      decision,
      reason: decision === 'deny' ? ENV_BLOCK_MESSAGE : ENV_LOG_MESSAGE,
      rule: 'block-env-context',
      durationMs: duration,
    };
  }

  // Env-context block ("block env mcp req" setting, default ON): any call
  // whose params carry env/API/JWT context is denied with a user-facing
  // ContextFence message. Audited as deny (or log in log-only mode) so env
  // reads show up in the audit log. Runs before the context filter so the
  // agent-facing message is this one, not the generic pattern reason.
  if (isEnvBlockEnabled() && hasEnvSecretContext(params)) {
    if (sessionKey) markSessionEnv(sessionKey);
    const duration = Date.now() - t0;
    const decision = isLogOnly() ? 'log' : 'deny';
    return {
      decision,
      reason: decision === 'deny' ? ENV_BLOCK_MESSAGE : ENV_LOG_MESSAGE,
      rule: 'block-env-context',
      durationMs: duration,
    };
  }

  // Context filter: check for secret bleed before rules
  if (policy.context_filter.enabled) {
    const paramStr = JSON.stringify(params || {});
    const searchStr = paramStr + '\n' + decodeBase64Tokens(paramStr);
    for (const pattern of policy.context_filter.patterns) {
      try {
        if (compilePattern(pattern, '').test(searchStr)) {
          const duration = Date.now() - t0;
          const decision = isLogOnly() ? 'log' : 'deny';
          return {
            decision,
            reason: `Context filter: sensitive data pattern detected in request params (matched: ${pattern})`,
            rule: 'context-filter',
            durationMs: duration,
          };
        }
      } catch { /* skip bad regex */ }
    }
  }

  // Evaluate the MERGED rule list (YAML + custom_policies overrides), so a
  // Modified built-in rule's reason/action/conditions are what actually
  // enforces — the audit_log reason proves the override is live. Custom
  // rules created in the UI are enforced here too. The cast is safe: the
  // merged rows come from the same YAML/DB sources and action is CHECK-
  // constrained to ('allow','deny','log') in custom_policies.
  //
  // Rule selection is most-restrictive-wins over ALL matching rules, not
  // first-match-wins: custom rules are appended AFTER the YAML rules, so a
  // generic allow-all (or a log-only rule like log-filesystem-access) would
  // otherwise shadow a later custom deny rule and make it unreachable.
  // Ties keep the first match (documented precedence).
  const merged = getMergedPolicies();
  const rules = (merged.length > 0 ? merged : policy.rules) as PolicyRule[];
  const rank: Record<string, number> = { deny: 3, log: 2, allow: 1 };
  let best: EvalResult | null = null;
  for (const rule of rules) {
    if (matchesRule(rule, method, params, serverName)) {
      const duration = Date.now() - t0;
      // In log_only mode, deny rules become log
      const decision = isLogOnly() && rule.action === 'deny' ? 'log' : rule.action;
      const candidate: EvalResult = { decision, reason: rule.reason, rule: rule.name, durationMs: duration };
      if (!best || rank[candidate.decision] > rank[best.decision]) best = candidate;
    }
  }
  if (best) return best;

  const duration = Date.now() - t0;
  return { decision: 'allow', reason: 'No matching rule', rule: 'default', durationMs: duration };
}

export function maskSecrets(obj: unknown): unknown {
  if (typeof obj === 'string') {
    // Blob guard: large payloads (base64 screenshots, file dumps) must pass
    // through unmasked — pattern-matching over them produces false-positive
    // redaction and corrupts the payload. Short strings are scanned.
    if (obj.length > 10000) return obj;
    const policy = getPolicy();
    let result = obj;
    for (const pattern of policy.context_filter.patterns) {
      try {
        result = result.replace(compilePattern(pattern, 'g'), '[REDACTED]');
      } catch { /* skip */ }
    }    return result;
  }
  if (Array.isArray(obj)) return obj.map(maskSecrets);
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const keyLower = k.toLowerCase();
      if (['password', 'secret', 'api_key', 'apikey', 'token', 'private_key', 'access_token'].some(s => keyLower.includes(s))) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out;
  }
  return obj;
}