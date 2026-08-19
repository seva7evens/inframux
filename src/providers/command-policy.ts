import type { ProviderDefinition } from './types.js';

export function validateProviderCommand(
  provider: ProviderDefinition,
  args: readonly string[],
): string[] {
  const policy = provider.commandPolicy;
  if (provider.executables.cli === undefined || policy === undefined) {
    throw new Error(`${provider.displayName} does not expose an approved CLI`);
  }
  const topLevel = args[0];
  if (topLevel === undefined || topLevel.startsWith('-') || !policy.allowedTopLevel.includes(topLevel)) {
    throw new Error(`Command is not approved for ${provider.id}: ${topLevel ?? '<empty>'}`);
  }
  for (const argument of args) {
    if (argument.includes('\0')) throw new Error('NUL bytes are blocked in provider arguments');
    for (const flag of policy.blockedFlags) {
      if (argument === flag || argument.startsWith(`${flag}=`)) {
        throw new Error(`Blocked provider flag: ${flag}`);
      }
    }
  }
  return [...args];
}
