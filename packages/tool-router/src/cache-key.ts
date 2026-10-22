import { createHash } from 'node:crypto';
import type { RouterPoint } from './plugin';

export interface DecisionCacheKeyParts {
  tenantId: string;
  point: Exclude<RouterPoint, 'gate'>;
  provider: string;
  model: string;
  /** Fingerprint of the tenant catalog (changes when tools change). */
  catalog: string;
  /** Redacted query or intent. */
  text: string;
  /** Candidate names (order-insensitive). */
  candidates: string[];
}

/** Redis key of a cached rerank/shortlist decision; the gate is never cached. */
export function decisionCacheKey(p: DecisionCacheKeyParts): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([p.point, p.provider, p.model, p.catalog, p.text.trim().toLowerCase(), [...p.candidates].sort()]))
    .digest('hex')
    .slice(0, 40);
  return `tr:${p.tenantId}:${digest}`;
}
