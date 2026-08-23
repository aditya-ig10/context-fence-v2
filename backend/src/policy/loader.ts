import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { PolicyConfig } from './engine.js';

export function loadPolicyFromDisk(policyDir: string): PolicyConfig | null {
  const p = join(policyDir, 'context-fence.yaml');
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf8');
  return yaml.load(raw) as PolicyConfig;
}
export function validatePolicy(cfg: PolicyConfig): string[] {
  const errs: string[] = [];
  if (!Array.isArray(cfg.rules)) errs.push('rules must be array');
  return errs;
}
