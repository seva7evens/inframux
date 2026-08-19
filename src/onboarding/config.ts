import type { ProviderDefinition } from '../providers/types.js';

const forbidden = /^(?:api[_-]?key|api[_-]?token|access[_-]?token|refresh[_-]?token|secret|password|private[_-]?key|cookie|authorization)$/i;

export function sanitizeServiceConfig(provider: ProviderDefinition, input: unknown): Readonly<Record<string, unknown>> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Service config must be an object');
  rejectSecrets(input, []);
  const config = input as Record<string, unknown>;
  const allowed = new Set([...provider.onboarding.requiredConfig, ...provider.onboarding.optionalConfig]);
  for (const key of Object.keys(config)) if (!allowed.has(key)) throw new Error(`Unsupported config field for ${provider.id}: ${key}`);
  for (const key of provider.onboarding.requiredConfig) {
    const value = config[key];
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
      throw new Error(`Missing required config field for ${provider.id}: ${key}`);
    }
  }
  return deepFreeze({ credential: `${provider.id}-admin`, ...structuredClone(config) });
}

function rejectSecrets(value: unknown, path: string[]): void {
  if (Array.isArray(value)) return value.forEach((item, index) => rejectSecrets(item, [...path, String(index)]));
  if (value === null || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.test(key)) throw new Error(`Service config contains secret material field: ${[...path, key].join('.')}`);
    rejectSecrets(child, [...path, key]);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
