# Operations and recovery

## Safe inspection

Run from an approved repository:

```bash
inframux project resolve --json
inframux status --json
inframux doctor --json
inframux audit verify --json
```

## Universal onboarding recovery

`inframux onboard start --services <csv> --json` may run only inside a Git
repository with exactly one canonical normalized remote. It creates a safe
`.inframux.toml` and a private 24-hour owner-bound session. Use `resume` after
any interruption; it detects credentials that completed verification before the
terminal or agent disconnected. Repeating identical configure/finish operations
is idempotent. A changed configuration requires a new session rather than an
in-place identity mutation.

`onboard authorize` must run in the user's interactive Terminal. It refuses a
pipe/non-TTY so an agent cannot capture static credentials. Google additionally
requires an absolute Desktop OAuth client JSON path. If a verified credential is
already used by another project, `onboard reuse ... --from-project ...` creates
only an explicit metadata binding and never copies or exports secret bytes.

Expired sessions remain inspectable but immutable. Start a new session with the
same service list; already verified credentials remain active. `finish` refuses
partial provider state and approves only the evidence captured at `start`.

`CHECKOUT_NOT_APPROVED` means the exact real path/common-dir/digest record is
missing or changed. Do not copy a manifest or weaken the remote check; submit a
new local approval through the management path.

`BROKER_UNAVAILABLE` means the socket/service must be repaired. Never fall back
silently to ambient CLI credentials or user mode.

## Lifecycle

`inframux bootstrap --json` is a non-mutating hardened preview.
`inframux bootstrap --apply` stages and seals the already-built installed
package as the current user, then invokes the narrow management helper through
one macOS authorization. It does not require a checkout and never runs a
compiler, package manager, browser download, or target-repository code.
The CLI completes `sudo -v` before rendering a low-overhead TTY spinner, then
runs the sealed helper with non-interactive sudo and clears the spinner before
the helper's first output. CI, redirected stdout/stderr, and non-TTY execution
emit no animation or control sequences.
It requires FileVault on/encrypting and installs `_inframux`, `_inframuxw`,
two LaunchDaemons, `/usr/local/bin/inframux`, and the central Playwright
launcher. No provider credential is requested during bootstrap.

The first hardened bootstrap establishes the local trust anchor. Install a
reviewed exact package version first, inspect the printed release version/file
count, and do not approve an unexpected sudo prompt. The helper accepts only a private
owner-bound request, exact Node `24.18.1`, caller-owned non-writable staging
files, `root:wheel` install ownership, the standard hardened target, and the
authenticated `SUDO_UID`/`SUDO_GID`/`SUDO_USER` identity.

Invoke both registry installation and the first bootstrap through the exact NVM
runtime rather than relying on ambient shell command resolution:

```bash
source "$HOME/.nvm/nvm.sh"
nvm exec 24.18.1 npm install --global inframux@0.1.0
nvm exec 24.18.1 inframux bootstrap --apply
```

An `EBADENGINE` warning or a Node version other than `v24.18.1` means no system
authorization should be accepted. Remove only the package from the incorrect
global prefix and reinstall it through the command above.

`inframux bootstrap --user-mode --apply` exists for isolated development and
tests; it applies the sealed filesystem/state without claiming service-account
isolation or a persistent launchd service.

`inframux update --check --json` reports the current release contract.
`inframux update --rollback` activates the retained previous sealed version and
requires its services to pass the probe before keeping it active.
`inframux uninstall --dry-run --json` lists software removal and explicitly
preserves credentials/browser profiles; `inframux uninstall` applies that
reviewed plan. Applying hardened install/update/
uninstall remains review-first and preserves credential/browser state by
default. Hardened lifecycle mutations are restricted to the management helper;
the ordinary CLI never impersonates it or runs npm under sudo.

Upgrade the npm package explicitly as the interactive user through
`nvm exec 24.18.1 npm`, then run
`nvm exec 24.18.1 inframux bootstrap --apply` again to stage and activate that
reviewed version.
`agent-playwright update` only prints this procedure; it never mutates the
sealed release. Do not use `npm update`, `@latest`, or `npx` implicitly from an
agent task without first choosing and reviewing the target version.

After bootstrap, bind each real checkout with `link --write-manifest`, approve
its short-lived request, and then run `status`. A changed manifest, moved
checkout, copied repository, or different remote requires a new approval.

Rollback atomically activates a previously verified version. Software rollback
does not roll back or duplicate credentials. Only current and one previous
runtime version are retained.

## Browser recovery

A persistent profile lock means another writer owns that exact
project/provider profile. Stop the owning browser cleanly. Safe repair may
remove a proven dead lock, never browser state. Use `browser mcp clean` to
reproduce logged-out/first-visit behavior without deleting the login profile.

## Incident response

If output may contain a credential: stop the task, preserve only redacted audit
metadata, revoke/rotate the provider credential, remove the affected process
lease, verify the audit chain, and re-enroll against the exact expected
identity. Do not paste the suspect value into logs or an issue.
