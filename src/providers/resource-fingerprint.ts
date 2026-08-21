import { createHash } from 'node:crypto';

export function stableResourceFingerprint(values: readonly string[]): string {
  const normalized = [...values].sort();
  return `sha256:${createHash('sha256').update(normalized.join(',')).digest('hex')}`;
}
