# Security policy

## Model

Hardened mode separates an interactive launcher, a credential-owning broker
account, and a no-vault worker account. User mode preserves the same logical
controls but cannot defend against malicious code already running as that
macOS user. FileVault protects data at rest; it does not protect an unlocked
session or a credential already delivered to an authorized provider process.

Key security decisions:

- no Keychain, same-principal “encryption key”, remote listener, telemetry, or
  raw-secret export;
- exact repository approval on every operation, with no sticky selector;
- private Unix sockets (`0600` user mode; dedicated-group `0660` plus a
  single-user ACL for the hardened client socket), bounded/versioned messages,
  deadlines, and cancellation;
- `0700` state and `0600` regular unique files with no-follow/atomic writes;
- private management requests are owner-bound to the authenticated `SUDO_*`
  caller; hardened release files must be caller-owned, non-group/world-writable,
  digest-sealed, and installed as `root:wheel`;
- HMAC fingerprints and chained audit events, never raw credential hashes;
- absolute digest-pinned executables, `shell:false`, sanitized environment,
  isolated writable roots, output/time bounds, and process-group termination;
- source-bound work rejects local project execution and requires a validated
  byte snapshot or external workflow;
- clean browser sessions cannot inherit persistent project state.

## Boundaries

The core and provider protocols have automated evidence. Live-account
acceptance is pending and must not be inferred from registry metadata.
Root/kernel compromise,
physical access to an unlocked Mac, compromise of the broker UID, provider-side
account compromise, and malicious code already authorized to use an in-flight
worker credential are outside the claimed boundary.

Browser profiles are readable by the interactive user because browsers must run
in the GUI session. They are a fallback for dashboard-only work, not an API
credential store.

Package installation is the network and third-party-code trust transition. The
first hardened bootstrap must run only from a reviewed exact package version;
it reads prebuilt installed artifacts and never invokes npm, npx, TypeScript,
browser installation, or project code. Package-manager lifecycle scripts run as
the interactive user before bootstrap, never under sudo. The privileged helper
receives only the caller-owned digest-sealed stage and private owner-bound
request. After activation, normal credentials and provider operations stay
behind the separate broker/worker identities.

The archive contract allowlists compiled runtime/catalog/docs paths and rejects
source, tests, `.env`/npm config, credentials, profiles, artifacts, caches,
logs, `node_modules`, invalid executable mode, and excessive package size. CI
installs the actual tarball into an isolated prefix, verifies it is immutable
during bootstrap/runtime use, and uploads the validated tarball without any npm
publication credential.

## Reporting

Do not open a public issue containing credentials, cookies, private account
data, audit payloads, or local paths. For this private-stage repository, report
the finding privately to the repository owner with affected version, minimal
reproduction, impact, and whether a credential should be revoked.

## Never commit

Tokens, OAuth grants, cookies, `.env` contents, private keys, provider auth
files, vault/audit state, browser profiles, executable staging roots, or E2E
temporary data. The ignore file is defense in depth; review staged diffs before
every push.
