# inframux

Product roadmap: [PLANS.md](PLANS.md).

Repository-bound local infrastructure broker for coding agents.

inframux resolves an exact approved Git checkout on every request, selects the
logical project, and gives one verified CLI/MCP process only that
project/provider credential. There is no global “current account”, raw-secret
API, generic inframux MCP server, Keychain dependency, or repository-provided
executable in the credential boundary.

## Status

The production core is implemented on exact Node.js `24.18.1`: sealed macOS
bootstrap, separate launchd broker/worker identities, repository trust,
broker-owned credentials, HMAC audit, bounded Unix RPC, fixed-origin provider
adapters, Desktop Google OAuth, central Playwright, a unified human/machine CLI
journey, and separate-process
synthetic E2E. Cloudflare, Vercel, Supabase, Sentry, UptimeRobot, Resend,
PostHog, and Google adapters are protocol-tested locally.

**Real-account acceptance is intentionally pending.** Universal onboarding is
implemented and synthetic-process tested; the next operational step is ordinary
user acceptance in a live repository. See
[universal onboarding](docs/onboarding.md) and [provider enrollment](docs/provider-enrollment.md).

## Installation

The package is prepared as `inframux` but is not published by this
repository yet. After the reviewed version is available on npm, installation is:

```bash
source "$HOME/.nvm/nvm.sh"
nvm exec 24.18.1 npm install --global inframux@0.1.2
nvm exec 24.18.1 inframux bootstrap --apply
```

The final command is the entire bootstrap. It works from any directory, stages
only the prebuilt installed package, performs no `npm`/`npx`/TypeScript/browser
download, and hands the terminal to macOS only for the hardened authorization.
After sudo accepts the password, an interactive-terminal spinner remains active
until the management helper produces its first result or diagnostic; the line
is cleared before that output. Pipes, CI, and non-TTY execution stay animation-free.
Package installation is the network trust boundary; bootstrap is local and
deterministic. `nvm exec` intentionally resolves both npm and the installed CLI
inside the exact Node 24.18.1 prefix even when an interactive shell has a stale
Homebrew command cache or alias. Treat an `EBADENGINE` warning, a reported Node
version other than `v24.18.1`, or an unexpected global prefix as a hard failure;
do not continue to the authorization step.

Before the registry release, maintainers exercise the identical consumer path
with a locally packed `.tgz` through `npm run test:package`. See
[release policy](docs/releasing.md) rather than installing directly from a Git
checkout.

## Architecture

```text
approved Git checkout → unprivileged CLI → private client.sock → broker/vault
                                                           │
                                                           └→ worker.sock → pinned official tool
```

- Checkout resolution compares real root, Git common directory, manifest
  digest, normalized remote, enrolled catalog, and local approval record.
- The broker owns credentials and returns metadata only.
- The worker gets a bounded one-operation lease, isolated HOME/TMP/config,
  sanitized environment, literal argv, and one credential.
- Official MCP stdio is tunneled unchanged; inframux adds no tool catalog.
- Browser state runs as the interactive user and never contains API tokens.

See [architecture](docs/architecture.md) and [security](SECURITY.md).

## CLI

Human output is the default. It reports the outcome and exact next action
without dumping internal broker/session objects:

```bash
inframux prompt onboarding
inframux onboard start --services cloudflare,vercel,supabase
inframux onboard configure <session-id> --service <provider> --input-json '{}'
inframux onboard authorize <session-id>
inframux onboard finish <session-id>
inframux agent-instructions
inframux project resolve
inframux status
inframux doctor
inframux trust prepare-checkout <session-id>
inframux call <provider> <operation> --input-json '{}'
inframux browser mcp clean
inframux browser mcp persistent --provider <provider>
inframux audit verify
inframux capabilities <provider>
inframux bootstrap
inframux bootstrap --apply
inframux update --check
inframux update --rollback
inframux uninstall --dry-run
inframux uninstall
```

Agents and automation add `--json`. Every finite machine result is one JSON
document with additive `state`, `complete`, and ordered `nextActions`; errors
use the same journey fields while preserving stable codes, exit statuses, and
legacy `recovery`. Provider streams and MCP byte tunnels remain unwrapped.
Use root or nested help at any depth, for example
`inframux onboard authorize --help`.

`prompt onboarding` prints the reusable agent prompt. Its only user-editable
placeholder is a comma-separated service list. Projects and catalogs are
derived dynamically from the exact Git remote; package-baked examples are not
required. Static credentials are entered only in the user's own hidden Terminal
prompt. Google uses the same `onboard authorize` command with
`--oauth-client-json /absolute/desktop-client.json`. `onboard finish`
reconciles an already-saved credential after an interrupted Terminal handoff,
so `resume` is optional inspection/recovery rather than a mandatory step.
Successful finish is replay-safe and returns the same repository-bound agent
instructions.

Initial repository binding is explicit and non-secret:

```bash
inframux link --project <project-id> /absolute/repository
inframux link --project <project-id> /absolute/repository --write-manifest
inframux trust approve <request-id>
```

Static-token enrollment reads the secret from a hidden TTY or stdin, never
argv. Google uses Desktop OAuth with PKCE and a random loopback callback:

```bash
inframux enroll <project> --service <provider>
inframux enroll <project-id> --service google-cloud --oauth-client-json /absolute/client.json
```

Normal commands contain no project selector; the exact approved Git checkout
selects the project. Production provider management uses the guarded
`api.request` capability. `run`/`launch mcp` are available only when
`capabilities` advertises a sealed executable; they never improvise through an
ambient CLI installation.

## Browser modes

- `persistent --provider <id>` locks and preserves
  `browser-state/<project>/<provider>`: cookies, localStorage, IndexedDB,
  Cache Storage, and service workers remain inside that one project/provider.
- `clean` creates a random task profile, never seeds it from persistent state,
  permits parallel tasks, and removes it after success, failure, or cancel.

Both modes use the pinned central runtime shipped by the inframux package;
project-local browser downloads are unnecessary. See
[Playwright usage](docs/playwright.md).

## Development

```bash
nvm use 24.18.1
npm ci --ignore-scripts
npm run verify
```

`npm run verify` includes a clean tarball/global-prefix consumer installation;
it never publishes or touches the real hardened install.

The E2E suite creates only temporary synthetic projects, tokens, tools, and
sockets. It never contacts a provider. Full commands and expected gates are in
[testing](docs/testing.md); operational recovery is in
[operations](docs/operations.md).

## Repository map

```text
src/broker, src/worker       credential and execution boundaries
src/git, src/trust           repository binding
src/security, src/ipc        vault, redaction, audit, protocol
src/providers                capability/identity/command contracts
src/browser, src/source      Playwright and source isolation
src/install                  sealed lifecycle primitives
test/                        unit, integration, synthetic E2E
runtime/playwright           shared launcher source (dependencies live at package root)
```

The repository remains private during live enrollment. npm publication is
deliberately disabled until the history/identifier/secret review, repository
visibility, trusted publisher, provenance, and licensing decisions in
[releasing](docs/releasing.md) are complete.
