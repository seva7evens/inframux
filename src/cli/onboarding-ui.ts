import { sanitizeTerminalText } from './terminal.js';

interface ActionView {
  readonly actor: 'user' | 'agent';
  readonly command: string;
}

interface OnboardingView {
  readonly id?: string;
  readonly project?: string;
  readonly providers?: readonly string[];
  readonly plan?: ReadonlyArray<{ readonly id: string }>;
  readonly services?: Readonly<Record<string, { readonly profile?: string }>>;
  readonly state: string;
  readonly complete: boolean;
  readonly nextActions: readonly ActionView[];
}

export function renderOnboardingHuman(
  command: string,
  input: unknown,
  options: { readonly unicode: boolean },
): string {
  const value = input as OnboardingView;
  const mark = options.unicode ? '✓' : '[ok]';
  const providers = value.providers ?? value.plan?.map((provider) => provider.id) ?? Object.keys(value.services ?? {});
  const verified = Object.values(value.services ?? {}).filter((service) => service.profile !== undefined).length;
  const lines: string[] = [];
  if (command === 'onboard.start') {
    lines.push(`${mark} inframux onboarding started`);
  } else if (command === 'onboard.authorize' && value.state === 'ready-to-finish') {
    lines.push(`${mark} ${verified} of ${providers.length} services connected`, '', 'Authorization is complete. Repository trust is still pending.');
  } else if (command === 'onboard.finish' && value.complete) {
    lines.push(`${mark} inframux onboarding complete`, '', `Project: ${safe(value.project ?? 'unknown')}`,
      `Services: ${providers.length} connected`, 'Checkout trust: approved');
  } else {
    lines.push(`${mark} onboarding state updated`);
  }
  if (command === 'onboard.start') {
    lines.push('', `Project: ${safe(value.project ?? 'unknown')}`, `Services: ${providers.map((provider) => safe(provider)).join(', ')}`);
    if (value.id !== undefined) lines.push(`Session: ${safe(value.id)}`);
  }
  if (value.nextActions.length > 0) {
    const actor = value.nextActions[0]!.actor;
    lines.push('', `Next step — ${actor}:`);
    for (const action of value.nextActions) lines.push(`  ${safe(action.command, 4_096)}`);
  }
  if (command === 'onboard.authorize' && value.state === 'ready-to-finish') lines.push('', 'You can safely close this terminal.');
  return `${lines.join('\n')}\n`;
}

function safe(value: string, max = 256): string { return sanitizeTerminalText(value, max); }
