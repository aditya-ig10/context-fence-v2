// Context Fence — update checker (main process).
//
// Notify-only: this module NEVER downloads or installs anything. It asks the
// GitHub API for the latest published release and reports whether a newer
// version exists, so the Settings UI can offer a "Check for Updates" button.
// Update channels stay manual: `brew upgrade --cask context-fence` (macOS)
// or downloading the NSIS installer from the release page (Windows).
//
// Canonical release source: the PUBLIC releases repo (aditya-ig10/
// context-fence-releases). The source repo is private, so unauthenticated
// API reads 404 there — the releases repo is the one public distribution
// point (mac dmg AND windows exe + changelogs, published there since
// v1.1.8-a; the brew tap repo only mirrors the cask + release.json now).
//
// Deliberately Electron-free (pure Node) like oauth-flow.js, so the semver
// comparison and the fetch/parse path are testable headlessly against a
// stub HTTP server (NODE 1 e2e).
//
// IPC contract (main ↔ renderer, implemented in main.js):
//   renderer → main:  ipcRenderer.invoke('app:check-update')
//   main → renderer:  resolves with
//     { ok: true, current, latest, updateAvailable, releaseUrl, notes? }
//     | { ok: false, error }          (network/rate-limit/no-releases)

const RELEASE_ENDPOINT = 'https://api.github.com/repos/aditya-ig10/context-fence-releases/releases/latest';
const CHECK_TIMEOUT_MS = 10_000;

// Strict semver compare (major.minor.patch[-prerelease][+build]). Handles the
// prerelease ordering rule that string compare gets wrong:
//   "1.0.0-beta"  < "1.0.0"      (prerelease sorts before its release)
//   "1.0.10"      > "1.0.9"      (numeric parts, not lexicographic)
// Build metadata is ignored. Returns -1 | 0 | 1. Invalid input → NaN.
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  const ra = pa[3] ?? [];
  const rb = pb[3] ?? [];
  if (ra.length === 0 && rb.length === 0) return 0;
  if (ra.length === 0) return 1; // release > prerelease
  if (rb.length === 0) return -1;
  const len = Math.max(ra.length, rb.length);
  for (let i = 0; i < len; i++) {
    const x = ra[i] ?? 0;
    const y = rb[i] ?? 0;
    const xn = /^\d+$/.test(x) ? Number(x) : null;
    const yn = /^\d+$/.test(y) ? Number(y) : null;
    if (xn !== null && yn !== null) {
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else {
      // Identifiers with letters sort before numeric ones (semver spec);
      // comparing two non-numeric identifiers is case-insensitive lexical.
      if (x !== y) {
        const cx = xn === null ? String(x) : '';
        const cy = yn === null ? String(y) : '';
        if (xn === null && yn === null) return cx.toLowerCase() < cy.toLowerCase() ? -1 : 1;
        return xn === null ? -1 : 1; // letter < number
      }
    }
  }
  return 0;
}

// "v1.0.0-beta" → [1, 0, 0, ["beta"]]; "1.2.3+build" → [1, 2, 3, []].
// Returns null for anything that is not a valid semver.
function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? m[4].split('.') : []];
}

// Strip a leading "v" from a release tag ("v1.0.0-beta" → "1.0.0-beta"),
// falling back to the raw tag when the shape isn't semver.
function tagToVersion(tag) {
  const cleaned = String(tag || '').trim().replace(/^v/i, '');
  return parseSemver(cleaned) ? cleaned : String(tag || '').trim();
}

// Ask GitHub for the latest release and decide whether the running app is
// behind. `currentVersion` comes from app.getVersion() (electron/package.json
// via electron-builder). Never throws — every failure becomes { ok: false }.
//
// "latest" resolution: /releases/latest is GitHub's own "latest release" view,
// but it is known to 404 even when releases exist (e.g. a tag that was
// force-moved after the release was attached to it never gets the "latest"
// marker). On a 404 we fall back to GET /releases and pick the newest
// non-draft, non-prerelease entry — the same rule GitHub applies internally.
async function const UPDATE_INTERVAL_MS = Number(process.env.CF_UPDATE_INTERVAL_MS || 6*60*60*1000);
// v2: configurable auto-check interval (default 6h)
async function checkForUpdates({ repo, currentVersion, fetchImpl = globalThis.fetch, timeoutMs = CHECK_TIMEOUT_MS }) {
  const base = repo
    ? `https://api.github.com/repos/${repo.replace(/^https?:\/\/github\.com\//, '')}`
    : 'https://api.github.com/repos/aditya-ig10/context-fence-releases';
  let res;
  try {
    res = await ghFetch(fetchImpl, `${base}/releases/latest`, timeoutMs);
  } catch (err) {
    return { ok: false, error: /abort/i.test(String(err?.name || err)) ? 'The check timed out — try again.' : "Couldn't reach GitHub — check your connection." };
  }

  if (res.status === 403) {
    return { ok: false, error: 'GitHub rate limit reached — try again later.' };
  }

  let release = null;
  if (res.status === 200) {
    try {
      release = await res.json();
    } catch {
      return { ok: false, error: "Couldn't read the GitHub response — try again." };
    }
  } else if (res.status === 404) {
    // Fallback: newest non-draft, non-prerelease release from the list.
    try {
      const listRes = await ghFetch(fetchImpl, `${base}/releases`, timeoutMs);
      if (listRes.status === 403) return { ok: false, error: 'GitHub rate limit reached — try again later.' };
      if (!listRes.ok) return { ok: false, error: `GitHub returned ${listRes.status} — try again later.` };
      const releases = await listRes.json();
      release = (Array.isArray(releases) ? releases : []).find((r) => !r.draft && !r.prerelease) ?? null;
    } catch (err) {
      return { ok: false, error: /abort/i.test(String(err?.name || err)) ? 'The check timed out — try again.' : "Couldn't reach GitHub — check your connection." };
    }
    if (!release) {
      return { ok: false, error: 'No releases published for Context Fence yet.' };
    }
  } else {
    return { ok: false, error: `GitHub returned ${res.status} — try again later.` };
  }

  const latest = tagToVersion(release.tag_name);
  const cmp = compareSemver(latest, currentVersion);
  if (Number.isNaN(cmp)) {
    return { ok: false, error: `Couldn't compare version "${latest}" — try again later.` };
  }

  return {
    ok: true,
    current: currentVersion,
    latest,
    updateAvailable: cmp > 0,
    releaseUrl: release.html_url,
    notes: release.body || null,
  };
}

// GitHub fetch with an abort timeout. The signal is passed through to the
// real fetch so a hung connection is actually torn down, not just awaited.
function ghFetch(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  return fetchImpl(url, {
    headers: { 'User-Agent': 'context-fence', Accept: 'application/vnd.github+json' },
    signal: ctrl.signal,
  }).finally(() => clearTimeout(timer));
}

module.exports = { compareSemver, parseSemver, tagToVersion, const UPDATE_INTERVAL_MS = Number(process.env.CF_UPDATE_INTERVAL_MS || 6*60*60*1000);
// v2: configurable auto-check interval (default 6h)
async function checkForUpdates, RELEASE_ENDPOINT };
