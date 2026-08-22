import { sendRequest } from '../mcp/proxy.js';
import db from '../db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// Reasoning pipeline (C2). Context Fence's multi-step reasoning tasks
// (decision explanation, install verification, anomaly triage) are routed
// through the sequential-thinking MCP server when it is connected — the same
// registered stdio child the proxy already spawned, so the full policy path
// (evaluate + audit) applies to the reasoning call too. When the MCP is not
// connected, absent, or times out, deepReason falls back to a local step
// decomposition so the caller never blocks on an unavailable server.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReasoningResult {
  routed: boolean;
  steps: string[];
  source: string;
  durationMs: number;
  error?: string;
}

const SERVER_NAME = 'sequential-thinking';
const TOOL_NAME = 'sequential_thinking';
const DEFAULT_TIMEOUT_MS = 5000;

function isReasoningMcpConnected(): boolean {
  try {
    const row = db
      .prepare('SELECT type, connected FROM mcp_servers WHERE name = ?')
      .get(SERVER_NAME) as { type: string; connected: number } | undefined;
    return !!row && row.type === 'stdio' && row.connected === 1;
  } catch {
    return false;
  }
}

// The server's reasoning tool has been renamed between package versions
// ("sequential_thinking" → "sequentialthinking"); resolve the REAL name from
// the synced tool inventory so routing never targets a stale name.
function resolveToolName(): string {
  try {
    const rows = db
      .prepare('SELECT tool_name FROM discovered_tools WHERE server_name = ? ORDER BY tool_name')
      .all(SERVER_NAME) as { tool_name: string }[];
    if (rows.length === 0) return TOOL_NAME;
    return rows.find((r) => /sequential/i.test(r.tool_name))?.tool_name ?? rows[0].tool_name;
  } catch {
    return TOOL_NAME;
  }
}

const ERROR_STEP_RE = /MCP error|Tool .* not found|-3260[0-9]/i;

function localFallback(task: string, error?: string): ReasoningResult {
  const sentences = task
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const steps =
    sentences.length >= 2
      ? sentences
      : ['Clarify the goal and constraints', 'Break the task into its independent parts', 'Evaluate each part against the policy context', 'Synthesize the final decision'];
  return {
    routed: false,
    steps,
    source: 'local-fallback (sequential-thinking MCP not connected)',
    durationMs: 0,
    ...(error ? { error } : {}),
  };
}

function extractStepsFromResult(result: unknown): string[] {
  // The sequential-thinking server returns its current chain in the
  // tools/call result's content array (text blocks).
  if (!result || typeof result !== 'object') return [];
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const texts = content
    .map((c) => (c && typeof c === 'object' ? (c as { text?: unknown }).text : undefined))
    .filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  const steps = texts.flatMap((t) => t.split('\n').map((l) => l.trim()).filter(Boolean));
  // The server echoes the reasoning chain as numbered lines; keep only the
  // real thought lines, capped so a runaway chain can't balloon the response.
  return steps.slice(0, 50);
}

/** Route a multi-step reasoning task through sequential-thinking MCP when
 *  available; graceful local fallback otherwise. Never throws. */
export async function deepReason(task: string, opts?: { timeoutMs?: number }): Promise<ReasoningResult> {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const t0 = Date.now();

  if (!isReasoningMcpConnected()) {
    return { ...localFallback(task), durationMs: Date.now() - t0 };
  }

  try {
    const res = await Promise.race([
      sendRequest(SERVER_NAME, 'tools/call', {
        name: resolveToolName(),
        arguments: { thought: task, thoughtNumber: 1, totalThoughts: 1, nextThoughtNeeded: false },
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    const durationMs = Date.now() - t0;

    if (res === null) {
      return { ...localFallback(task, 'sequential-thinking timed out'), routed: false, source: 'local-fallback (sequential-thinking timed out)', durationMs };
    }
    if (!res.ok || res.decision === 'deny' || res.error) {
      return {
        ...localFallback(task, res.error ?? `policy decision: ${res.decision}`),
        routed: false,
        source: 'local-fallback (sequential-thinking call rejected)',
        durationMs,
      };
    }
    const steps = extractStepsFromResult(res.result);
    // Some servers surface tool-not-found / invalid-params as a result
    // payload instead of an error envelope — treat that as a failed call.
    const looksFailed = steps.some((s) => ERROR_STEP_RE.test(s));
    if (steps.length === 0 || looksFailed) {
      return {
        ...localFallback(task, looksFailed ? steps.find((s) => ERROR_STEP_RE.test(s)) : 'no reasoning steps returned'),
        routed: false,
        source: 'local-fallback (empty or error response)',
        durationMs,
      };
    }
    return { routed: true, steps, source: 'sequential-thinking MCP', durationMs };
  } catch (err) {
    const durationMs = Date.now() - t0;
    return {
      ...localFallback(task, err instanceof Error ? err.message : String(err)),
      routed: false,
      source: 'local-fallback (error calling sequential-thinking)',
      durationMs,
    };
  }
}
