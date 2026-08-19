import type { Capability, ProviderSurface, OperationClassification, CapabilitySupport } from './types.js';

export function capability(
  operation: string,
  options: {
    surface: ProviderSurface;
    classification?: OperationClassification;
    support?: CapabilitySupport;
    identityCheck?: boolean;
    requiredScopes?: readonly string[];
    destructive?: boolean;
    idempotent?: boolean;
    dryRun?: boolean;
  },
): Capability {
  return Object.freeze({
    operation,
    surface: options.surface,
    classification: options.classification ?? 'control-plane',
    support: options.support ?? 'stable',
    identityCheck: options.identityCheck ?? true,
    requiredScopes: Object.freeze([...(options.requiredScopes ?? [])]),
    destructive: options.destructive ?? false,
    idempotent: options.idempotent ?? true,
    dryRun: options.dryRun ?? false,
  });
}

export const commonBlockedFlags = Object.freeze([
  '--token', '--auth-token', '--api-key', '--account', '--scope', '--team',
  '--org', '--organization', '--project', '--config', '--global-config',
  '--cwd', '--chdir', '--home', '--profile', '--debug', '--verbose-debug',
  '--update', '--upgrade', '--plugin', '--plugins', '--hook', '--telemetry', '--',
]);
