#!/usr/bin/env node
// trigger-mcp-fetch — on-demand trigger for Context Fence's MCP setup
// sequence. "Any MCP I add via npm or any other source should set itself up
// automatically" — this script makes that sequence runnable by hand or by
// cron/launchd:
//
//   node scripts/trigger-mcp-fetch.mjs                → full discovery scan
//   node scripts/trigger-mcp-fetch.mjs mem filesystem → fetch those servers
//
// Full scan (no args) runs the same pass as the 30s interval + config
// watcher: rescan agent configs → auto-register newly added MCPs → heal
// self-loops → rewire protected agents → spawn stdio children → tool-sync.
// With names it ensures each named server is spawned and fetches its tools.
//
// Targets the backend HTTP API: CF_API_HOST (default 127.0.0.1) and
// CF_API_PORT (default 3000). Exit code 0 = all requested steps ok.

const BASE = `http://${process.env.CF_API_HOST || '127.0.0.1'}:${process.env.CF_API_PORT || '3000'}`;
const names = process.argv.slice(2).filter(Boolean);

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  let failed = false;

  if (names.length === 0) {
    console.log(`[fetch] full discovery scan → ${BASE}/api/connectors/scan`);
    const { status, body } = await post('/api/connectors/scan');
    if (status === 200 && body.ok) {
      console.log(`[fetch] scan ok — registered/updated: ${(body.scanned || []).join(', ') || '(nothing new)'}`);
    } else {
      console.error(`[fetch] scan FAILED (${status}): ${body.error || 'unknown'}`);
      process.exit(1);
    }
    return;
  }

  for (const name of names) {
    const { status, body } = await post(`/api/servers/${encodeURIComponent(name)}/fetch`);
    if (status === 200 && body.ok) {
      console.log(`[fetch] ${name}: ok — spawned=${body.spawned} tools=${body.toolCount} (${body.durationMs}ms)`);
    } else {
      failed = true;
      console.error(`[fetch] ${name}: FAILED (${status}) — ${body.error || body.spawnError || 'unknown'}`);
    }
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(`[fetch] could not reach backend at ${BASE}: ${err.message}`);
  console.error('       is Context Fence running? (CF_API_HOST/CF_API_PORT to override)');
  process.exit(1);
});
