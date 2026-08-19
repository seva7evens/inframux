# Universal inframux onboarding

This guide is written for an ordinary inframux user and for a coding agent with
no context from the inframux development chat.

## One-time Mac bootstrap

Install the reviewed package under exact Node.js 24.18.1 and run the hardened
bootstrap once. macOS authorization is intentionally separate from agent work:

```bash
"$HOME/.nvm/versions/node/v24.18.1/bin/inframux" bootstrap --apply
```

No provider credential is requested during system bootstrap.

## Reusable prompt

Paste this into the chat opened for the target repository. Edit only the
`Services` line:

```text
Set up inframux for this repository completely and finish with verified health checks.

Services: <ENTER COMMA-SEPARATED SERVICES>

Run `inframux onboard start --services ... --json` from the current Git repository and follow only the machine-readable next actions it returns. Infer the project identity from the repository; do not invent a global account or project selector.

Never ask me to paste a secret, password, cookie, OAuth code, API credential, or token into chat. Configure only non-secret account, organization, team, project, region, domain, and resource identifiers through `inframux onboard configure`. Reject secret material in repository files and command arguments.

When inframux reports that user authorization is ready, give me the exact separate `inframux onboard authorize` command to run in my own Terminal. Wait for me to confirm that it completed, then resume autonomously. Use inframux OAuth/PKCE where advertised and its hidden Terminal prompt for static credentials. Never use ambient CLI credentials, Keychain, or another repository's browser profile.

Finish with `inframux onboard finish`, `inframux status --json`, `inframux doctor --json`, and `inframux audit verify --json`. Report the resolved project, verified provider identities, and any remaining action without exposing credential values or local secret paths.
```

The installed package prints the canonical current copy with:

```bash
inframux prompt onboarding
```

## Agent flow

1. Run `onboard start` with the requested service CSV. Read its `plan` array;
   it supplies auth type, required/optional non-secret fields, setup URL, and
   official documentation URL for each provider.
2. Discover or ask only for ambiguous non-secret account/team/project choices.
   Submit them with `onboard configure`. Never place credentials in JSON.
3. Give the user the exact `onboard authorize <session>` command. For Google,
   append `--oauth-client-json /absolute/desktop-client.json`.
4. After the user confirms completion, run `onboard resume <session> --json`.
   Resume is safe after cancellation or disconnect and recognizes credentials
   already committed by the broker.
5. Run `onboard finish`. It succeeds only when every requested provider is
   verified and then trusts the exact checkout captured at start.
6. Run status, doctor, and audit verification from the repository.

## Account isolation and reuse

New project/provider credentials are isolated by default and receive a
project-namespaced alias. Normal commands contain no project selector: the exact
approved Git checkout selects the account.

If two projects intentionally use the same verified provider account, configure
the target identity pins and run:

```bash
inframux onboard reuse <session-id> --service <provider> --from-project <source-project>
```

The broker verifies matching identity metadata and creates a reference binding.
It does not copy or export secret bytes. Browser cookies/localStorage remain
separate by project/provider even when the credential is shared.

## Supported providers

| ID | Initial authorization | Key non-secret configuration |
| --- | --- | --- |
| `cloudflare` | API token | `accountId`; optional zones/resources |
| `vercel` | access token | `teamId`; optional user/projects |
| `supabase` | management PAT | `organizationId`; optional projects |
| `sentry` | organization token | `origin`, `organization`; optional projects |
| `uptimerobot` | account API key | optional monitors |
| `resend` | full-access key | optional account/domain status |
| `posthog` | personal API key | `origin`, `organizationId`, `projectId` |
| `google-cloud` | Desktop OAuth PKCE | `account`, `scopes`; optional projects |

Provider APIs evolve. The machine plan's shipped documentation URL is the
authority for creating the current credential. OAuth is used only where the
installed adapter implements the exact official client contract; there is no
ambient CLI fallback.

## Security boundary

- The agent never receives a token through chat or arguments.
- Static input is hidden and requires the user's TTY.
- OAuth uses the system browser, S256 PKCE, random state, and a random
  `127.0.0.1` callback.
- Session/catalog files contain only non-secret mappings.
- Identity is checked before a credential replaces active state.
- Normal CLI/MCP/API leases expose exactly one project/provider credential.
- Persistent browser state is project/provider scoped; clean mode is disposable.
