// ============================================================================
// Unified Typed Fetch Client Architecture (mcp-firewall)
//
// Shared standard across Context Fence and Payment Gateway:
//   1. Typed Result Envelope: { ok: true, data: T } | { ok: false, error: string, code: string }
//   2. Idempotency-guarded retry with exponential backoff & jitter (max 3 attempts, GET/idempotent only)
//   3. Separate, explicit auth attachment mechanisms:
//      - Firebase Auth ID token for user-authenticated API routes
//   4. Request timeout via AbortController (default 8s)
// ============================================================================

export type ApiResult<T> =
  | { ok: true; data: T; status: number }
  | { ok: false; error: string; code: string; status?: number };

export interface ApiRequestOptions extends Omit<RequestInit, "headers"> {
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  idempotent?: boolean;
  firebaseToken?: string | null;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_IDEMPOTENT_RETRIES = 3;

function isIdempotentMethod(method = "GET"): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" || m === "PUT" || m === "DELETE";
}

function getJitteredBackoffMs(attempt: number, baseMs = 300, maxMs = 3000): number {
  const expDelay = Math.min(maxMs, baseMs * Math.pow(2, attempt));
  return Math.floor(Math.random() * expDelay);
}

export async function apiRequest<T>(
  url: string,
  options: ApiRequestOptions = {}
): Promise<ApiResult<T>> {
  const method = (options.method || "GET").toUpperCase();
  const isIdempotent = options.idempotent ?? isIdempotentMethod(method);
  const maxRetries = isIdempotent ? Math.min(options.retries ?? MAX_IDEMPOTENT_RETRIES, MAX_IDEMPOTENT_RETRIES) : 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const headers: Record<string, string> = {
    Accept: "application/json",
    ...options.headers,
  };

  if (options.body && typeof options.body === "string" && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  if (options.firebaseToken) {
    headers["Authorization"] = `Bearer ${options.firebaseToken}`;
  }

  let attempt = 0;
  let lastError = "Request failed";
  let lastCode = "NETWORK_ERROR";
  let lastStatus: number | undefined;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        method,
        headers,
        signal: controller.signal,
      });

      clearTimeout(timer);
      lastStatus = response.status;

      const text = await response.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }

      if (response.ok) {
        if (json && typeof json === "object" && "ok" in json && (json as { ok: boolean }).ok === false) {
          const errObj = json as { error?: string; code?: string };
          return {
            ok: false,
            error: errObj.error || "Operation failed",
            code: errObj.code || `HTTP_${response.status}`,
            status: response.status,
          };
        }

        const data = (json !== null ? json : (text as unknown)) as T;
        return {
          ok: true,
          data,
          status: response.status,
        };
      }

      const errObj = json && typeof json === "object" ? (json as { error?: string; code?: string; message?: string }) : null;
      lastError = errObj?.error || errObj?.message || text || `HTTP error ${response.status}`;
      lastCode = errObj?.code || `HTTP_${response.status}`;

      const isTransientServerError = response.status >= 500 && response.status <= 504;
      if (!isIdempotent || !isTransientServerError || attempt >= maxRetries) {
        return {
          ok: false,
          error: lastError,
          code: lastCode,
          status: response.status,
        };
      }
    } catch (err: unknown) {
      clearTimeout(timer);
      const isAbort = err instanceof Error && err.name === "AbortError";
      lastError = isAbort ? `Request timeout after ${timeoutMs}ms` : (err instanceof Error ? err.message : String(err));
      lastCode = isAbort ? "TIMEOUT" : "FETCH_ERROR";

      if (!isIdempotent || attempt >= maxRetries) {
        return {
          ok: false,
          error: lastError,
          code: lastCode,
          status: lastStatus,
        };
      }
    }

    attempt++;
    const backoffMs = getJitteredBackoffMs(attempt);
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  return {
    ok: false,
    error: lastError,
    code: lastCode,
    status: lastStatus,
  };
}
