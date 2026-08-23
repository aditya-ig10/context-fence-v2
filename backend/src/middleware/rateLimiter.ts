// v2 rate limiter — simple in-memory sliding window (100 req/min per IP)
const WINDOW_MS = 60_000;
const LIMIT = Number(process.env.CF_RATE_LIMIT_PER_MIN || 100);
const hits = new Map<string, number[]>();

export function rateLimiter(req: any, res: any, next: any) {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (arr.length > LIMIT) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: Math.ceil((arr[0] + WINDOW_MS - now)/1000) });
  }
  next();
}
export function _resetForTests(){ hits.clear(); }
