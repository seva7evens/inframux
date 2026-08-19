import { sanitizeTerminalText } from './terminal.js';

interface ProviderRow {
  readonly id: string;
  readonly health: string;
  readonly identity?: Readonly<Record<string, string>>;
  readonly fingerprint?: string;
  readonly recovery?: string;
}

interface ActionRow { readonly actor: string; readonly command: string }

export function renderOperationalHuman(
  command: string,
  input: unknown,
  options: { readonly unicode: boolean; readonly verbose: boolean },
): string {
  const value = input as Record<string, unknown>;
  const ok = options.unicode ? '✓' : '[ok]';
  const fail = options.unicode ? '✗' : '[failed]';
  if (command === 'status' || command === 'doctor' || command === 'auth.status') {
    const project = text(value.project ?? 'unknown');
    const providers = Array.isArray(value.providers) ? value.providers as ProviderRow[] : [];
    const lines = [command === 'doctor' ? `inframux doctor · ${project}` : `${project} · ${text(value.securityMode ?? 'credentials')}`];
    if (command !== 'auth.status') lines[0] += ` · checkout ${value.checkoutApproved === true ? 'approved' : 'not approved'}`;
    for (const provider of providers) {
      const healthy = provider.health === 'healthy';
      const identity = provider.identity === undefined ? [] : Object.values(provider.identity).map(safeIdentity);
      if (provider.id === 'uptimerobot' && provider.fingerprint !== undefined) {
        identity.unshift(`credential ${shortFingerprint(provider.fingerprint)}`);
      }
      lines.push(`${healthy ? ok : fail} ${text(provider.id)} · ${text(provider.health)}${identity.length === 0 ? '' : ` · ${identity.join(' / ')}`}`);
      if (provider.recovery !== undefined) lines.push(`  Recovery: ${text(provider.recovery, 4_096)}`);
    }
    return `${lines.join('\n')}\n`;
  }
  if (command === 'capabilities') {
    const capabilities = Array.isArray(value.capabilities) ? value.capabilities as Array<Record<string, unknown>> : [];
    return `${[
      `${text(value.displayName ?? value.id ?? 'Provider')} capabilities`,
      ...capabilities.map((capability) => [
        capability.operation, capability.surface, capability.support,
        capability.destructive === true ? 'destructive' : 'read-only',
        capability.classification === 'source-bound' ? 'source-bound' : undefined,
      ].filter(Boolean).map((item) => text(item)).join(' · ')),
    ].join('\n')}\n`;
  }
  if (command === 'trust.prepare-checkout') {
    const ready = value.ready === true;
    const lines = [ready ? `${ok} Hardened broker checkout access is ready` : 'Minimal checkout access required'];
    if (!ready) lines.push('The helper grants only directory search to the fixed _inframux group.');
    return `${appendActions(lines, value.nextActions).join('\n')}\n`;
  }
  if (command === 'bootstrap' && typeof value.version === 'string') {
    return `${ok} inframux ${text(value.version)} installed\n\nMode: ${text(value.mode ?? 'unknown')}\n`;
  }
  if (command === 'audit.verify') {
    return `${value.valid === true ? ok : fail} audit chain ${value.valid === true ? 'valid' : 'invalid'}${typeof value.events === 'number' ? ` · ${value.events} events` : ''}\n`;
  }
  const lines = [`${ok} ${text(command)} complete`];
  for (const key of ['project', 'provider', 'currentVersion', 'updated', 'rolledBack', 'uninstalled', 'removed', 'revoked']) {
    if (value[key] !== undefined && ['string', 'number', 'boolean'].includes(typeof value[key])) lines.push(`${label(key)}: ${text(value[key])}`);
  }
  return `${appendActions(lines, value.nextActions).join('\n')}\n`;
}

function appendActions(lines: string[], input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0) return lines;
  lines.push('', `Next step — ${text((input[0] as ActionRow).actor)}:`);
  for (const action of input as ActionRow[]) lines.push(`  ${text(action.command, 4_096)}`);
  return lines;
}

function shortFingerprint(value: string): string {
  const digest = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
  return digest.slice(0, 12);
}

function safeIdentity(value: string): string {
  const safe = text(value);
  return /^(?:sha256|hmac-sha256):[a-f0-9]{32,}$/u.test(safe) ? `${safe.slice(0, safe.indexOf(':') + 1)}${safe.slice(safe.indexOf(':') + 1, safe.indexOf(':') + 13)}` : safe;
}

function label(value: string): string { return value.replace(/[A-Z]/gu, (letter) => ` ${letter.toLowerCase()}`).replace(/^./u, (letter) => letter.toUpperCase()); }
function text(value: unknown, max = 256): string { return sanitizeTerminalText(String(value), max); }
