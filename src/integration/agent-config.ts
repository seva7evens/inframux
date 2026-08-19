import { z } from 'zod';

export function renderAgentIntegrationGuide(input: {
  readonly project: string;
  readonly providers: readonly string[];
}): string {
  const project = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/).parse(input.project);
  const providers = z.array(z.string().regex(/^[a-z][a-z0-9-]{1,126}$/)).parse(input.providers);
  const unique = [...new Set(providers)].sort();
  return `# inframux integration for ${project}

Infrastructure context is automatically resolved from this exact approved Git checkout. Do not select a global profile and do not repeat the project name in normal commands.

Available provider contexts: ${unique.join(', ')}.

- Inspect context with \`inframux status --json\` and verify live identities with \`inframux doctor --json\`.
- Prefer the fixed-origin \`api.request\` surface. Use \`inframux run\` or \`launch mcp\` only when \`inframux capabilities <provider>\` explicitly advertises an installed executable.
- Use the fixed-origin API path with \`inframux call cloudflare api.request --input-json '{"method":"GET","path":"/..."}'\`.
- Reuse project browser state with \`inframux browser mcp persistent --provider <provider>\`.
- When isolation is required, use \`inframux browser mcp clean\`; it starts with no persistent cookies or origin storage.
- Never read local inframux state files, add a project selector to normal commands, or place credential material in repository files or command arguments.
`;
}

export function renderUniversalOnboardingPrompt(): string {
  return `Set up inframux for this repository completely and finish with verified health checks.

Services: <ENTER COMMA-SEPARATED SERVICES>

Run \`inframux onboard start --services ... --json\` from the current Git repository and follow only the machine-readable next actions it returns. Infer the project identity from the repository; do not invent a global account or project selector.

Never ask me to paste a secret, password, cookie, OAuth code, API credential, or token into chat. Configure only non-secret account, organization, team, project, region, domain, and resource identifiers through \`inframux onboard configure\`. Reject secret material in repository files and command arguments.

When inframux reports that user authorization is ready, give me the exact separate \`inframux onboard authorize\` command to run in my own Terminal. Wait for me to confirm that it completed, then resume autonomously. Use inframux OAuth/PKCE where advertised and its hidden Terminal prompt for static credentials. Never use ambient CLI credentials, Keychain, or another repository's browser profile.

Finish with \`inframux onboard finish\`, \`inframux status --json\`, \`inframux doctor --json\`, and \`inframux audit verify --json\`. Report the resolved project, verified provider identities, and any remaining action without exposing credential values or local secret paths.
`;
}
