// auditRule — "Create rule from this" mapping: audit_log row → policy rule
// prefill + duplicate-coverage detection. Pure functions, no React, no
// network: unit-testable and shared between AuditLog (click target) and
// Policies (prefill editor).

export interface AuditEntryLike {
  id?: string;
  timestamp?: string;
  tool: string;
  method: string;
  decision: string;
  reason: string;
  server?: string | null;
}

export interface PolicyRuleLike {
  name: string;
  action: string;
  reason: string;
}

export interface AuditCoverage {
  kind: 'context-filter' | 'rule';
  ruleName?: string;
  pattern?: string;
}

export interface AuditPrefill {
  name: string;
  description: string;
  action: 'deny';
  reason: string;
  methods: string;
  tools: string;
  servers: string;
  param_contains: string;
}

const CONTEXT_FILTER_PREFIX = 'Context filter:';
// Engine reasons end with " (matched: <pattern>)" — capture the pattern
// up to the wrapper's closing paren (display-only hint, not enforcement).
const MATCHED_RE = /matched:\s*(.+?)\)\s*$/;

// Was this entry already blocked by something that already exists?
//   - context-filter denies (reason starts with "Context filter:") are
//     covered by the built-in pattern engine — creating a custom rule on top
//     is a redundant duplicate.
//   - rule denies carry the matched rule's reason verbatim (engine.ts sets
//     reason: rule.reason), so a deny whose reason equals an existing deny
//     rule's reason is covered by that rule. First match wins.
export function auditCoverage(entry: AuditEntryLike, rules: PolicyRuleLike[]): AuditCoverage | null {
  if (entry.decision !== 'deny') return null;
  if (entry.reason && entry.reason.startsWith(CONTEXT_FILTER_PREFIX)) {
    const m = MATCHED_RE.exec(entry.reason);
    return { kind: 'context-filter', pattern: m?.[1]?.trim() };
  }
  const hit = (rules ?? []).find((r) => r.action === 'deny' && r.reason === entry.reason);
  return hit ? { kind: 'rule', ruleName: hit.name } : null;
}

// Default granularity decision: server + tool. This blocks the exact call
// pattern (same tool on the same connector) while still stopping retries
// with different arguments — param_contains is deliberately NOT prefilled
// because argument-level matching would let a slightly different payload
// through, and any entry that was ALREADY blocked by a pattern match is
// covered by its own rule (see auditCoverage). The editor lets the user
// widen (all connectors) or narrow (add param_contains) before saving.
export function auditPrefill(entry: AuditEntryLike): AuditPrefill {
  const tool = entry.tool || 'unknown tool';
  const server = entry.server ?? '';
  const name = server ? `Block ${tool} on ${server}` : `Block ${tool}`;
  // tools/call is the universal tool-invocation method — leaving methods
  // empty keeps the rule robust against method casing/alternatives. Any
  // other method (initialize, custom) is pinned so the rule only matches
  // that exact method.
  const methods = entry.method === 'tools/call' ? '' : (entry.method ?? '');
  return {
    name,
    description: `Created from audit log${entry.id ? ` entry ${entry.id}` : ''}`,
    action: 'deny',
    reason: `Blocked: ${tool}${server ? ` on ${server}` : ''}`,
    methods,
    tools: tool,
    servers: server,
    param_contains: '',
  };
}
