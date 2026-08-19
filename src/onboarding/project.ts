import type { ProviderRegistry } from '../providers/registry.js';

export function parseServiceList(source: string, registry: ProviderRegistry): readonly string[] {
  const values = [...new Set(source.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  if (values.length === 0) throw new Error('Onboarding requires at least one service');
  for (const value of values) {
    try { registry.require(value); } catch { throw new Error(`Unknown provider in service list: ${value}`); }
  }
  return Object.freeze(values);
}

export function deriveProjectIdentity(normalizedRemotes: readonly string[]): {
  readonly id: string; readonly displayName: string; readonly canonicalRemote: string;
} {
  if (normalizedRemotes.length !== 1) throw new Error('Onboarding requires exactly one canonical remote');
  const canonicalRemote = normalizedRemotes[0];
  if (canonicalRemote === undefined) throw new Error('Onboarding requires exactly one canonical remote');
  const repository = canonicalRemote.split('/').at(-1)?.replace(/\.git$/i, '') ?? '';
  const displayName = repository.replace(/[._-]+/g, ' ').trim().toLowerCase();
  let id = repository.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!/^[a-z]/.test(id)) id = `project-${id}`;
  id = id.slice(0, 63).replace(/-+$/g, '');
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(id)) throw new Error('Canonical remote cannot produce a valid project ID');
  return Object.freeze({ id, displayName, canonicalRemote });
}
