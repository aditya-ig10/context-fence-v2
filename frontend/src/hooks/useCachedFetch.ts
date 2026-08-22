import { useEffect, useRef, useState } from 'react';

// ============================================================================
// useCachedFetch — stale-while-revalidate cache for GET data (GRAPH PROMPT 9,
// N9 design note / N10 implementation).
//
// Semantics (by design):
//   - Fresh entry (age < maxAge): served from cache synchronously on mount —
//     zero network on every navigation back to the page. A timer scheduled for
//     the moment the entry expires triggers a single background revalidation
//     while the component stays mounted, so long sessions never show data
//     older than maxAge.
//   - Stale entry (age >= maxAge): cached data is still rendered immediately
//     (no blank/loading flash), revalidated in the background.
//   - No entry: normal fetch; `loading` true only in this case.
//   - Revalidation failure: previous data is kept; `error` surfaces only when
//     there is no data to show.
//
// Layers: an in-memory Map (authoritative, per-tab) + a best-effort
// sessionStorage mirror, hydrated once per tab on first use so a cold reload
// (Cmd-R) still renders instantly. In-memory always wins — it is fresher than
// anything on disk for the same tab. Storage failures (private mode, quota)
// are swallowed; the hook degrades to in-memory + network.
//
// Keying & invalidation: the caller passes an explicit key (endpoint + query)
// so mutation sites can purge exactly what they changed via invalidateCache().
// N12 security rule: Policies/AuditLog pass a short maxAgeMs (15s) — rule and
// log changes must be visible across tabs within seconds, so their stale
// window is deliberately tighter than the 60s default.
// ============================================================================

interface CacheEntry<T> {
  value: T;
  at: number;
}

const memory = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
// Versioned: bump STORE_VERSION whenever a cached payload's SHAPE changes
// (e.g. the 'servers' entry gained boundAgents/toolCount/authType in the
// connector redesign). An unversioned key would resurrect stale shapes from
// sessionStorage and crash consumers that assume the new fields.
const STORE_VERSION = 2;
const STORE_KEY = `cf_cache_v${STORE_VERSION}`;
let hydrated = false;

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = sessionStorage.getItem(STORE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, CacheEntry<unknown>>;
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object' && typeof v.at === 'number' && 'value' in v) {
        memory.set(k, v);
      }
    }
  } catch {
    /* storage unavailable — in-memory only */
  }
}

function persist(): void {
  try {
    sessionStorage.setItem(STORE_KEY, JSON.stringify(Object.fromEntries(memory)));
  } catch {
    /* storage unavailable */
  }
}

export function invalidateCache(predicate: (key: string) => boolean): void {
  for (const k of Array.from(memory.keys())) {
    if (predicate(k)) memory.delete(k);
  }
  persist();
  // Notify mounted hooks so invalidation is immediate, not timer-bound:
  // each listener re-checks whether ITS key disappeared and refetches.
  for (const l of listeners) l();
}

// Mounted hooks subscribe here; invalidateCache() pokes them so entries
// deleted from the cache are re-fetched right away (realtime push path).
const listeners = new Set<() => void>();

export interface CachedFetchResult<T> {
  data: T | null;
  loading: boolean;
  error: unknown;
  refresh: () => void;
}

export function useCachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  opts?: { maxAgeMs?: number }
): CachedFetchResult<T> {
  const maxAge = opts?.maxAgeMs ?? 60_000;
  hydrate();
  const entry = memory.get(key) as CacheEntry<T> | undefined;
  const age = entry ? Date.now() - entry.at : Infinity;
  const fresh = !!entry && age < maxAge;
  // Lazy initial state: a fresh/stale entry renders synchronously on the very
  // first render — no loading flash on remount, no network for fresh data.
  const [data, setData] = useState<T | null>(entry?.value ?? null);
  const [loading, setLoading] = useState(!entry);
  const [error, setError] = useState<unknown>(null);
  const [tick, setTick] = useState(0);
  const forceRef = useRef(false);
  const runRef = useRef<() => void>(() => {});

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = memory.get(key) as CacheEntry<T> | undefined;
    const force = forceRef.current;
    forceRef.current = false;

    const schedule = (at: number) => {
      const delay = Math.max(0, maxAge - (Date.now() - at));
      if (delay > 0) {
        timer = setTimeout(() => runRef.current(), delay);
      }
    };

    const run = () => {
      if (!inflight.has(key)) {
        const p = fetcher().then((v) => {
          memory.set(key, { value: v, at: Date.now() });
          persist();
          schedule(Date.now());
          return v;
        });
        inflight.set(key, p.finally(() => inflight.delete(key)));
      }
      (inflight.get(key) as Promise<T>)
        .then((v) => { if (!cancelled) { setData(v); setLoading(false); setError(null); } })
        .catch((e) => { if (!cancelled) { if (!current) setError(e); setLoading(false); } });
    };
    runRef.current = run;

    if (!force && current) {
      if (Date.now() - current.at < maxAge) {
        // Key changed to one with a fresh cached entry (e.g. a chart period
        // that was visited earlier): render it synchronously instead of
        // leaving the PREVIOUS key's data on screen until the revalidation
        // timer fires up to maxAge later.
        setData(current.value);
        setLoading(false);
        setError(null);
        schedule(current.at);
      } else {
        run();
      }
    } else {
      run();
    }
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [key, maxAge, tick]);

  // Security freshness: when the tab becomes visible again, refresh
  // immediately if the cached entry is already stale (background tabs may be
  // heavily throttled, so a user returning to Policies/AuditLog must not stare
  // at data older than maxAge).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== 'visible') return;
      const e = memory.get(key) as CacheEntry<T> | undefined;
      if (e && Date.now() - e.at >= maxAge) {
        forceRef.current = true;
        setTick((t) => t + 1);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [key, maxAge]);

  // Realtime push: if invalidateCache() removed OUR entry while mounted,
  // refetch immediately — no waiting for the next timer/visibility tick.
  useEffect(() => {
    const onChange = () => {
      if (memory.has(key)) return;
      if (inflight.has(key)) return; // a refetch is already in flight
      forceRef.current = true;
      setTick((t) => t + 1);
    };
    listeners.add(onChange);
    return () => { listeners.delete(onChange); };
  }, [key]);

  return { data, loading, error, refresh: () => { forceRef.current = true; setTick((t) => t + 1); } };
}
