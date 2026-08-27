// v2: centralized secret masking
export const SECRET_PATTERNS = [ /sk-[A-Za-z0-9]{20,}/g, /ghp_[A-Za-z0-9]{20,}/g, /Bearer\s+[A-Za-z0-9._-]+/gi ];
export function maskSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '***');
  return out;
}
