import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIG_PATHS,
  fetchMcpsFromConfig,
  fetchAllMcps,
  parseJsoncConfig,
  parseMcpEntries,
  injectMcpEntry,
  __setFsForTests,
} from '../agent-det/config-fetch.js';
import { homedir } from 'os';
import { join } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// mcp-fetch.test.ts — the config fetch pipeline against a VIRTUAL filesystem.
//
// A5 scenarios: JSONC with comments parses; empty mcp → []; comment-only and
// trailing-comma files parse; missing files return [] without throwing; both
// opencode.json and opencode.jsonc merge with name dedup.
// B5 scenarios: add/remove/delete a config between fetches → the refresh sees
// the new disk state on every read (zero cache); rapid consecutive reads
// return consistent snapshots.
// ─────────────────────────────────────────────────────────────────────────────

// A tiny in-memory fs: node:test has no vi.mock, so the pipeline's injectable
// fs slot (__setFsForTests) is pointed at this Map. Paths are the real
// home-derived CONFIG_PATHS keys — they just never touch the disk.
function makeVirtualFs() {
  const files = new Map<string, string>();
  let tick = 0;
  const fsStub = {
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string, _enc: 'utf-8') => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    statSync: (p: string) => ({ mtimeMs: (files.has(p) ? ++tick : 0) }),
    writeFileSync: (p: string, data: string) => { files.set(p, data); },
    mkdirSync: (_p: string, _o?: { recursive?: boolean }) => {},
  };
  return { files, fsStub };
}

let fs: ReturnType<typeof makeVirtualFs>;

beforeEach(() => {
  fs = makeVirtualFs();
  __setFsForTests(fs.fsStub);
});

afterEach(() => {
  __setFsForTests(null as never); // restored to real node:fs inside the setter
});

const HOME = homedir();
const OPENCODE_JSONC = join(HOME, '.config', 'opencode', 'opencode.jsonc');
const OPENCODE_JSON = join(HOME, '.config', 'opencode', 'opencode.json');
const CURSOR_MCP = join(HOME, '.cursor', 'mcp.json');

const CONFIG_WITH_COMMENTS = `{
  // opencode config with comments (JSONC)
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    /* block comment: playwright via npx */
    "playwright": {
      "type": "local",
      "command": ["npx", "@playwright/mcp@latest"],
      "enabled": true
    },
    "sequential-thinking": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-sequential-thinking"],
      "enabled": true
    }
  }
}
`;

// ── A5 ───────────────────────────────────────────────────────────────────────

test('A5 S1: JSONC with comments + 2 MCPs parses and returns both entries', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.exists, true);
  assert.equal(res.parseError, undefined);
  assert.equal(res.entries.length, 2);
  const pw = res.entries.find((e) => e.name === 'playwright')!;
  assert.deepEqual(pw.command, ['npx', '@playwright/mcp@latest']);
  assert.equal(pw.enabled, true);
  assert.equal(pw.source, OPENCODE_JSONC);
  assert.equal(pw.type, 'local');
  const st = res.entries.find((e) => e.name === 'sequential-thinking')!;
  assert.deepEqual(st.command, ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking']);
});

test('A5 S2: empty mcp object returns [] without crashing', () => {
  fs.files.set(OPENCODE_JSONC, '{\n  "mcp": {}\n}\n');
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.exists, true);
  assert.deepEqual(res.entries, []);
});

test('A5 S3: line comments + block comments + trailing commas parse without error', () => {
  fs.files.set(OPENCODE_JSONC, `{
    // line comment
    "mcp": {
      "only": { "command": ["echo", "hi"], },  // trailing comma + inline comment
    },
  }`);
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.parseError, undefined);
  assert.equal(res.entries.length, 1);
  assert.deepEqual(res.entries[0].command, ['echo', 'hi']);
});

test('A5 S3b: a "http://" inside a string value is NOT mistaken for a comment', () => {
  // Naive comment-strippers corrupt this file; the real JSONC tokenizer
  // must keep the URL intact.
  fs.files.set(OPENCODE_JSONC, `{
    "mcp": {
      "remote": { "type": "http", "url": "http://example.com/mcp?query=a//b" }
    }
  }`);
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.parseError, undefined);
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].url, 'http://example.com/mcp?query=a//b');
});

test('A5 S4: file missing entirely → exists:false, entries [], no throw', () => {
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.exists, false);
  assert.deepEqual(res.entries, []);
  // The fetch-all pipeline likewise reports it without throwing.
  const all = fetchAllMcps();
  const missing = all.results.find((r) => r.path === OPENCODE_JSONC)!;
  assert.equal(missing.exists, false);
});

test('A5 S4b: unreadable file (EACCES) → entries [] with an explanatory parseError, no throw', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  const fsWithEacc = {
    ...fs.fsStub,
    readFileSync: (p: string, _e: 'utf-8') => {
      const err = new Error(`EACCES: permission denied, open '${p}'`) as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    },
  };
  __setFsForTests(fsWithEacc);
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.exists, true);
  assert.deepEqual(res.entries, []);
  assert.match(res.parseError ?? '', /Unreadable/);
});

test('A5 S6: opencode.json + opencode.jsonc both exist → merged, deduplicated by name', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS); // playwright, sequential-thinking
  fs.files.set(OPENCODE_JSON, `{
    "mcp": {
      "playwright": { "command": ["npx", "@playwright/mcp@latest"] },
      "filesystem": { "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/tmp"] }
    }
  }`);
  const all = fetchAllMcps();
  const names = all.entries.map((e) => e.name);
  assert.ok(names.includes('playwright'));       // dedup: appears once
  assert.equal(names.filter((n) => n === 'playwright').length, 1);
  assert.ok(names.includes('sequential-thinking'));
  assert.ok(names.includes('filesystem'));
  assert.equal(all.entries.length, 3);
  // First file in scan order wins the name (jsonc before json).
  const pw = all.entries.find((e) => e.name === 'playwright')!;
  assert.equal(pw.source, OPENCODE_JSONC);
});

test('parseJsoncConfig: BOM + comment-only file + non-object roots never throw', () => {
  assert.equal(parseJsoncConfig('\uFEFF{\n  "mcp": {}\n}\n')?.mcp !== undefined, true);
  assert.equal(parseJsoncConfig('// just a comment\n/* and a block */'), null);
  assert.equal(parseJsoncConfig('   '), null);
  assert.equal(parseJsoncConfig(''), null);
  assert.equal(parseJsoncConfig('[1,2,3]'), null);
  assert.equal(parseJsoncConfig('{ "broken": '), null);
});

// ── B5 ───────────────────────────────────────────────────────────────────────

test('B5 S1: 2 MCPs in config → fetchAllMcps returns 2', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  assert.equal(fetchAllMcps().entries.length, 2);
});

test('B5 S2: MCP added to config → refresh (re-fetch) shows it WITHOUT restart', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  assert.equal(fetchAllMcps().entries.length, 2);
  // Add an entry the way a real install would (byte-preserving injection).
  const injected = injectMcpEntry(OPENCODE_JSONC, { name: 'filesystem', command: ['npx', 'server-filesystem'] });
  assert.equal(injected.ok, true);
  const after = fetchAllMcps();
  assert.equal(after.entries.length, 3);
  assert.ok(after.entries.some((e) => e.name === 'filesystem'));
});

test('B5 S3: MCP removed from config → refresh shows it gone', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  assert.equal(fetchAllMcps().entries.length, 2);
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS.replace(/,\n    "sequential-thinking": \{[\s\S]*?\n    \}/, ''));
  const after = fetchAllMcps();
  assert.equal(after.entries.length, 1);
  assert.ok(!after.entries.some((e) => e.name === 'sequential-thinking'));
});

test('B5 S4: config file deleted → refresh reports "not found" and the pipeline returns []', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  assert.equal(fetchAllMcps().entries.length, 2);
  fs.files.delete(OPENCODE_JSONC);
  const after = fetchAllMcps();
  assert.equal(after.entries.length, 0);
  const missing = after.results.find((r) => r.path === OPENCODE_JSONC)!;
  assert.equal(missing.exists, false); // the "Config not found" surface
});

test('B5 S5: 5 rapid consecutive fetches → consistent, non-overlapping snapshots', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  fs.files.set(CURSOR_MCP, '{"mcpServers": {"github": {"command": ["npx", "gh-mcp"]}}}');
  const snapshots = Array.from({ length: 5 }, () => fetchAllMcps());
  for (const s of snapshots) {
    assert.equal(s.entries.length, 3);
    assert.deepEqual(
      s.entries.map((e) => e.name).sort(),
      ['github', 'playwright', 'sequential-thinking'],
    );
  }
  // And a write between reads is always reflected (no cache).
  fs.files.set(CURSOR_MCP, '{"mcpServers": {"github": {"command": ["npx", "gh-mcp"]}, "slack": {"command": ["npx", "slack-mcp"]}}}');
  assert.equal(fetchAllMcps().entries.length, 4);
});

test('mcpServers key (non-opencode agents) is extracted too', () => {
  fs.files.set(CURSOR_MCP, '{"mcpServers": {"github": {"command": ["npx", "gh-mcp"], "enabled": false}}}');
  const all = fetchAllMcps();
  const gh = all.entries.find((e) => e.name === 'github')!;
  assert.equal(gh.source, CURSOR_MCP);
  assert.equal(gh.enabled, false);
  assert.equal(gh.type, 'local');
});

test('malformed config file → parseError surfaced, entries [], pipeline continues', () => {
  fs.files.set(OPENCODE_JSONC, '{ "mcp": { "broken": { "command": ["x"], } '); // unbalanced
  fs.files.set(CURSOR_MCP, '{"mcpServers": {"ok": {"command": ["echo", "y"]}}}');
  const all = fetchAllMcps();
  assert.equal(all.entries.length, 1);
  const bad = all.results.find((r) => r.path === OPENCODE_JSONC)!;
  assert.match(bad.parseError ?? '', /Malformed/);
});

// ── C1 (injection) ───────────────────────────────────────────────────────────

test('C1: injectMcpEntry preserves comments byte-for-byte and parses cleanly after', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  const before = CONFIG_WITH_COMMENTS;
  const result = injectMcpEntry(OPENCODE_JSONC, {
    name: 'new-server',
    type: 'local',
    command: ['npx', '-y', 'some-server'],
  });
  assert.equal(result.ok, true);
  const after = fs.files.get(OPENCODE_JSONC)!;
  assert.ok(after.includes('// opencode config with comments'));   // comment kept
  assert.ok(after.includes('/* block comment: playwright via npx */')); // kept
  assert.ok(after.includes('"new-server"'));
  // The splice must not have corrupted anything else.
  assert.ok(after.includes('"playwright"') && after.includes('"sequential-thinking"'));
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.parseError, undefined);
  assert.equal(res.entries.length, 3);
  assert.deepEqual(res.entries.find((e) => e.name === 'new-server')!.command, ['npx', '-y', 'some-server']);
});

test('C1: injectMcpEntry adds an mcp block when the root has no mcp key', () => {
  fs.files.set(OPENCODE_JSONC, '{\n  "$schema": "https://opencode.ai/config.json"\n}\n');
  const result = injectMcpEntry(OPENCODE_JSONC, { name: 'sequential-thinking', command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'] });
  assert.equal(result.ok, true);
  const after = fs.files.get(OPENCODE_JSONC)!;
  assert.ok(after.includes('"$schema"'));
  assert.ok(after.includes('"mcp"'));
  const res = fetchMcpsFromConfig({ path: OPENCODE_JSONC, name: 'OpenCode', type: 'opencode' });
  assert.equal(res.entries.length, 1);
  assert.equal(res.entries[0].name, 'sequential-thinking');
});

test('C1: injecting an entry that already exists is refused, file untouched', () => {
  fs.files.set(OPENCODE_JSONC, CONFIG_WITH_COMMENTS);
  const result = injectMcpEntry(OPENCODE_JSONC, { name: 'sequential-thinking', command: ['npx', 'x'] });
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /already exists/);
  assert.equal(fs.files.get(OPENCODE_JSONC), CONFIG_WITH_COMMENTS);
});

test('CONFIG_PATHS covers the full required path list (A1)', () => {
  const paths = CONFIG_PATHS.map((p) => p.path);
  assert.ok(paths.includes(join(HOME, '.config', 'opencode', 'opencode.jsonc')));
  assert.ok(paths.includes(join(HOME, 'opencode.jsonc')));
  assert.ok(paths.includes(join(HOME, '.cursor', 'mcp.json')));
  assert.ok(paths.some((p) => p.includes(join('Claude', 'claude_desktop_config.json'))));
  assert.ok(paths.some((p) => p.includes(join(HOME, '.continue', 'config.json'))));
  assert.ok(paths.some((p) => p.includes(join(HOME, '.cline', 'config.json'))));
  // The no-`c` opencode.json variants (the shadcn silent-install gap).
  assert.ok(paths.includes(join(HOME, '.config', 'opencode', 'opencode.json')));
  assert.ok(paths.includes(join(HOME, '.opencode', 'opencode.json')));
  assert.ok(paths.includes(join(HOME, 'opencode.json')));
});

// ── Cline CLI live-config interception ───────────────────────────────────────
// The CLI reads ~/.cline/data/settings/cline_mcp_settings.json at startup.
// That path MUST be registered BEFORE the ~/.cline/data directory entry:
// "first existing path wins" hands the config to protectAgent, and only this
// JSON file is rewritable (the data dir is a SQLite store). Without it a
// Cline-only user's stdio MCPs (e.g. Playwright) spawn OUTSIDE the proxy and
// their calls are never audit-logged.

const CLINE_SETTINGS = join(HOME, '.cline', 'data', 'settings', 'cline_mcp_settings.json');
const CLINE_DATA_DIR = join(HOME, '.cline', 'data');

test('Cline CLI: the live settings file is a known config path, scanned before the data dir', () => {
  const paths = CONFIG_PATHS.filter((p) => p.type === 'cline').map((p) => p.path);
  assert.ok(paths.includes(CLINE_SETTINGS), 'CLI settings file must be registered as a cline config path');
  assert.ok(paths.includes(CLINE_DATA_DIR), 'data-dir fallback must stay registered');
  assert.ok(
    paths.indexOf(CLINE_SETTINGS) < paths.indexOf(CLINE_DATA_DIR),
    'settings file must precede the data dir so the rewritable JSON wins',
  );
});

test('Cline CLI: cline_mcp_settings.json parses (mcpServers + bare command:string entry)', () => {
  // Byte-for-byte the file found on a real Cline CLI install: no `type`
  // field, MCP-spec command(string)+args(array) style.
  fs.files.set(CLINE_SETTINGS, `{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest"
      ]
    }
  }
}`);
  const res = fetchMcpsFromConfig({ path: CLINE_SETTINGS, name: 'Cline', type: 'cline' });
  assert.equal(res.exists, true);
  assert.equal(res.parseError, undefined);
  assert.equal(res.entries.length, 1);
  const pw = res.entries[0];
  assert.equal(pw.name, 'playwright');
  assert.deepEqual(pw.command, ['npx', '@playwright/mcp@latest']);
  assert.equal(pw.source, CLINE_SETTINGS);
  // Shows up in the aggregate scan too (this is what discovery surfaces).
  assert.ok(fetchAllMcps().entries.some((e) => e.name === 'playwright' && e.source === CLINE_SETTINGS));
});

test('Cline CLI: clineFormat injection round-trips through the settings file', () => {
  fs.files.set(CLINE_SETTINGS, '{\n  "mcpServers": {}\n}');
  const result = injectMcpEntry(CLINE_SETTINGS, {
    name: 'sequential-thinking',
    command: ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking'],
    clineFormat: true,
  });
  assert.equal(result.ok, true);
  const res = fetchMcpsFromConfig({ path: CLINE_SETTINGS, name: 'Cline', type: 'cline' });
  assert.equal(res.entries.length, 1);
  assert.deepEqual(res.entries[0].command, ['npx', '-y', '@modelcontextprotocol/server-sequential-thinking']);
});
