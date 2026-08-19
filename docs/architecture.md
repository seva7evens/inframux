# Architecture

## Request flow

1. The CLI collects the nearest Git root, canonical common directory, all
   fetch/push remotes, and `.inframux.toml` digest without executing hooks.
2. The broker compares that evidence with its enrolled catalog and exact local
   approval ledger, producing an immutable request-scoped project context.
3. A typed provider definition classifies the operation and selects a
   fixed-origin API or an explicitly installed sealed executable. Unknown,
   source-bound, identity-changing, config-changing,
   plugin, debug, and auto-update paths fail closed.
4. The broker opens one credential inside a callback, registers it with the
   redactor, and emits one bounded execution lease.
5. The outbound-connected worker re-hashes the absolute executable, builds a
   new lease root and minimal environment, runs literal argv with no shell, and
   cleans the entire root on every exit path.
6. The broker appends credential-free HMAC-chained audit metadata before
   reporting acceptance of the operation.

There is no process-global active project and no inframux MCP tool server.
Parallel repositories therefore cannot change one another’s selection.

## State ownership

- Hardened broker state: `/Library/Application Support/inframux/state`.
- Hardened worker scratch: `/Library/Application Support/inframux/worker`.
- User-mode state: `~/.config/inframux/state`.
- Interactive browser state: `~/.config/inframux/browser-state`.

The hardened lifecycle builds as the interactive user, seals every runtime
file with path/mode/owner/size/SHA-256, and gives a narrow root helper only the
private validated request. The helper verifies `SUDO_*`, FileVault, fixed
service-account attributes, launchd environment, sockets and probes before the
atomic `current` activation is accepted. Package managers never run as root.

## Source and browser exceptions

The worker never receives a checkout path for source-bound operations. The
launcher creates deterministic, bounded, secret-scanned bytes from `git
ls-files -z`, with mandatory cache/build/credential exclusions. If an official
tool cannot avoid local hooks/plugins/build scripts, the operation is
unsupported.

Playwright runs under the GUI user. Persistent state is keyed by resolved
project/provider and exclusively locked. Clean state is random, empty, and
deleted after child exit.
