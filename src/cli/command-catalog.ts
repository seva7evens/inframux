export interface CommandHelp {
  readonly path: readonly string[];
  readonly usage: string;
  readonly purpose: string;
  readonly details?: string;
  readonly example: string;
}

const COMMANDS: readonly CommandHelp[] = Object.freeze([
  entry([], 'inframux <command>', 'Repository-bound infrastructure access for people and coding agents.', 'inframux prompt onboarding'),
  entry(['prompt', 'onboarding'], 'inframux prompt onboarding', 'Print the reusable project onboarding prompt.', 'inframux prompt onboarding'),
  entry(['onboard', 'start'], 'inframux onboard start --services <comma-separated>', 'Start repository-bound service onboarding.', 'inframux onboard start --services vercel,supabase --json'),
  entry(['onboard', 'configure'], 'inframux onboard configure <session-id> --service <provider> --input-json <json>', 'Store non-secret provider identity configuration.', "inframux onboard configure 018f47d2-8737-7a19-8000-123456789abc --service vercel --input-json '{\"teamId\":\"team_example\"}' --json"),
  entry(['onboard', 'reuse'], 'inframux onboard reuse <session-id> --service <provider> --from-project <project>', 'Bind an existing verified credential without copying secret bytes.', 'inframux onboard reuse 018f47d2-8737-7a19-8000-123456789abc --service vercel --from-project shared-infra --json'),
  entry(['onboard', 'authorize'], 'inframux onboard authorize <session-id> [--oauth-client-json /absolute/file]', 'Authorize configured services in a user-owned interactive Terminal.', 'inframux onboard authorize 018f47d2-8737-7a19-8000-123456789abc'),
  entry(['onboard', 'resume'], 'inframux onboard resume <session-id>', 'Reconcile credentials after an interruption.', 'inframux onboard resume 018f47d2-8737-7a19-8000-123456789abc --json'),
  entry(['onboard', 'finish'], 'inframux onboard finish <session-id>', 'Reconcile credentials and trust the exact captured checkout.', 'inframux onboard finish 018f47d2-8737-7a19-8000-123456789abc --json'),
  entry(['trust', 'prepare-checkout'], 'inframux trust prepare-checkout <session-id> [--apply]', 'Preview or apply minimal directory traversal access for the hardened broker.', 'inframux trust prepare-checkout 018f47d2-8737-7a19-8000-123456789abc'),
  entry(['status'], 'inframux status [--json]', 'Show project, checkout trust, and provider health.', 'inframux status'),
  entry(['doctor'], 'inframux doctor [--service <provider>] [--repair-safe] [--json]', 'Verify local and provider health and show recovery.', 'inframux doctor --json'),
  entry(['capabilities'], 'inframux capabilities <provider> [--json]', 'List reviewed surfaces and operations for one provider.', 'inframux capabilities vercel'),
  entry(['audit', 'verify'], 'inframux audit verify [--json]', 'Verify the local audit chain for this checkout.', 'inframux audit verify'),
  entry(['agent-instructions'], 'inframux agent-instructions [--json]', 'Print canonical instructions for agents in the current repository.', 'inframux agent-instructions'),
  entry(['bootstrap'], 'inframux bootstrap [--user-mode] [--apply]', 'Preview or install inframux.', 'inframux bootstrap --apply'),
  entry(['update'], 'inframux update [--check|--rollback]', 'Check, install, or roll back an inframux release.', 'inframux update --check'),
  entry(['uninstall'], 'inframux uninstall --dry-run', 'Preview removal while naming preserved state.', 'inframux uninstall --dry-run'),
]);

export function resolveCommandHelp(argv: readonly string[]): CommandHelp | undefined {
  const requested = argv.length === 0 || argv.some((value) => value === '--help' || value === '-h' || value === 'help');
  if (!requested) return undefined;
  const path = argv
    .slice(0, argv.findIndex((value) => value === '--help' || value === '-h' || value === 'help') < 0 ? 0 : argv.findIndex((value) => value === '--help' || value === '-h' || value === 'help'))
    .filter((value) => !value.startsWith('-'));
  const matches = COMMANDS.filter((candidate) => candidate.path.every((part, index) => path[index] === part));
  return matches.sort((left, right) => right.path.length - left.path.length)[0] ?? COMMANDS[0];
}

export function renderCommandHelp(help: CommandHelp): string {
  if (help.path.length === 0) {
    return `Usage: ${help.usage}\n\n${help.purpose}\n\nSet up a project:\n  prompt onboarding\n  onboard start --services <services>\n\nInspect and repair a project:\n  status\n  doctor\n  audit verify\n  trust prepare-checkout <session-id>\n\nUse a provider:\n  capabilities <provider>\n  run <provider> -- <command>\n  call <provider> <operation>\n\nManage inframux:\n  bootstrap\n  update\n  uninstall --dry-run\n\nExample:\n  ${help.example}\n`;
  }
  return `Usage: ${help.usage}\n\n${help.purpose}${help.details === undefined ? '' : `\n\n${help.details}`}\n\nOutput modes:\n  Human-readable output is the default. Add --json for one machine-readable document.\n\nExample:\n  ${help.example}\n`;
}

function entry(path: readonly string[], usage: string, purpose: string, example: string, details?: string): CommandHelp {
  return Object.freeze({ path: Object.freeze([...path]), usage, purpose, example, ...(details === undefined ? {} : { details }) });
}
