# inframux implementation journal

## Working protocol

- Start implementation requests with a dated scope entry.
- Record verification evidence without credentials, private identifiers, or
  machine-specific paths.
- Keep only publication-safe project history in this file.

## 2026-08-22 — Repeated Sentry MCP OAuth investigation

**Status:** Resolved locally; inframux runtime unchanged

**Scope:** Identify the process repeatedly opening Sentry OAuth browser tabs,
separate Codex MCP client behavior from inframux provider verification, and
remove the loop without reading, replacing, or exposing saved credentials. If
inframux is involved, add a failing regression test before changing production
code and verify the installed hardened runtime after the fix.

### Resolution evidence

- The browser target was the OAuth endpoint of a third-party remote MCP proxy,
  not an inframux provider request. Process ancestry showed multiple duplicate
  proxy instances owned by the local agent host while both inframux launchd
  services remained stable.
- Two duplicate, globally enabled Sentry MCP registrations caused every active
  agent session to start parallel OAuth clients. Both registrations were made
  reversibly disabled in the user's local agent configuration, and only the
  already-running Sentry proxy processes were terminated.
- No credential or OAuth state bytes were read, deleted, or replaced. Existing
  provider credentials in the hardened vault were preserved.
- The disabled state is visible through the agent CLI. Repeated observation
  found zero Sentry MCP processes and no new auth-state writes after the
  change.
- A fresh repository-bound inframux `status` and live `doctor` completed with
  Sentry healthy; that API verification spawned no MCP or browser process.
  Therefore no inframux source, release, or privileged bootstrap change was
  required.

## 2026-08-21 — Live hardened 0.1.4 acceptance

**Status:** Accepted live

**Scope:** Confirm the user-authorized `0.1.4` activation from independent live
evidence: sealed `current` target and manifest, both launchd jobs and PIDs,
listening replacement sockets, cleared bounded diagnostics, preserved
persistent-state metadata, repository-bound status, provider doctor results,
and audit-chain validity. Do not read secret bytes or request reauthorization.

### Acceptance evidence

- The active symlink and sealed package manifest both report `0.1.4` on exact
  Node `24.18.1`; the retained rollback version remains installed separately.
- Both launchd jobs are continuously `running` with live PIDs. Direct private
  RPC reports the exact release, broker readiness, and an attached worker.
- Both socket inodes were recreated at the `0.1.4` activation time with the
  intended service ownership and modes. The installed plists contain the new
  runtime-manifest and per-service diagnostic roots.
- Repository-bound `status` completed in hardened mode with the checkout still
  approved and all five previously enrolled credentials present and healthy.
- A fresh live `doctor` verified all five external provider identities and
  expected resources without reauthorization. `audit verify` returned a valid
  chain, and `agent-instructions` returned a complete machine journey.
- `/usr/local/bin/inframux update --check --json` reports current/local `0.1.4`,
  `updateAvailable: false`, and no next action. No secret file or credential
  bytes were inspected during acceptance.

## 2026-08-21 — Hardened daemon health and transactional upgrade

**Status:** Release-verified; one user-authorized live hardened activation remains

**Scope:** Diagnose both hardened daemons exiting after the `0.1.3` activation
despite a successful bootstrap result. Reproduce the upgrade from an existing
runtime with stale Unix socket paths and populated persistent state; replace
filesystem-only health checks with real process/protocol health; reject and
roll back an unhealthy release; retain bounded redacted daemon diagnostics;
return actionable broker recovery; and verify the repaired packaged upgrade
end to end before another live privileged attempt.

### Activity log

- Captured the installed failure without reading credential contents: both
  launchd jobs repeatedly exited with code 1, both socket inodes predated the
  upgrade and accepted no connections, and persistent state remained outside
  the sealed runtime.
- Traced the crash to `listenUnixSocket` rejecting stale paths and the false
  success to a probe that checked only inode type plus launchd registration.
- Restart now waits for both jobs to disappear, validates both exact socket
  paths before deleting either, refuses links/non-sockets/live listeners, and
  then starts the replacement services.
- Added a broker protocol health response containing the active sealed release
  and actual worker attachment state. Hardened activation additionally requires
  both launchd jobs to be running; crash-looping jobs, stale sockets, version
  mismatches, and broker-only startup all fail the probe.
- A failed upgrade restores `current`, restarts and probes the retained runtime,
  and preserves the credential sentinel. Legacy protocol acceptance is limited
  to explicit rollback/recovery and requires repeated stable launchd/RPC passes.
- Broker and worker now atomically replace one private, bounded, structurally
  redacted `last-error.json` and remove it after a healthy start. No stack or
  credential payload is written. `BROKER_UNAVAILABLE` now directs the user to
  `inframux bootstrap --apply`, whose candidate failure path rolls back.
- Advanced the immutable release identity to `0.1.4`; updated launchd, synthetic
  process, fresh-bootstrap, packaged-consumer, documentation, and publication
  contracts. The exact Node 24.18.1 tarball is installed globally; no provider
  credential was requested or replaced.
- Fresh `npm run verify` passed with 158/158 unit/integration tests, 96.10% line,
  92.82% function, and 80.67% branch coverage; compiled two-process E2E,
  fresh-bootstrap and tarball/global-prefix consumer smokes; publication and
  secret scans; zero dependency vulnerabilities; and 15/15 central Playwright
  runtime tests. The remaining live step is separated because sudo requires the
  user to enter the macOS password directly.

## 2026-08-21 — Complete launchctl absence semantics

**Status:** Validated; awaiting live hardened bootstrap

**Scope:** Correct the incomplete `0.1.2` launchd race fix after live bootstrap
showed that `launchctl bootout` reports an already-absent job as exit code 3
while `launchctl print` reports the same state as exit code 113. Build an
explicit operation-specific result matrix, test stopped/fresh/delayed/error
journeys, preserve all persistent state, and do not request another privileged
run until the complete local and packaged upgrade path is verified.

### Activity log

- Live evidence confirmed that both services and the partial `0.1.2` runtime
  were absent, while `current` and all persistent roots remained on `0.1.0`.
- Reproduced the exact stopped-service failure in a red test using launchctl's
  real `bootout` result: exit code 3 with `No such process`.
- Replaced the shared absence check with operation-specific, fail-closed
  contracts: exact code/message 3 for `bootout`, exact code/message 113 for
  `print`; unrelated failures are never swallowed.
- Added tests for already-stopped services, delayed asynchronous removal,
  unexpected bootout failure, and inability to confirm removal. Advanced the
  corrected artifact to immutable patch version `0.1.3`.
- Full exact-Node verification passed with 147/147 tests, 96.21% line coverage,
  92.82% function coverage, 80.67% branch coverage, synthetic CLI journeys,
  bootstrap and installed-package smoke, publication/secret scans, zero
  high-severity dependency findings, and 15/15 Playwright runtime tests.

## 2026-08-21 — Hardened 0.1.1 launchd upgrade failure

**Status:** Validated; awaiting live hardened bootstrap

**Scope:** Diagnose the macOS `launchctl bootstrap system` input/output failure
observed while upgrading the active hardened runtime from `0.1.0` to `0.1.1`.
Preserve all credential, catalog, trust, audit, and browser state; capture the
actual launchd/runtime state before changing code; add a regression test for
the identified lifecycle defect; then ship and verify a state-preserving patch
through the same one-command bootstrap journey.

### Activity log

- The failed install rolled `current` back to `0.1.0` and removed the partial
  `0.1.1` runtime; persistent state remained outside the version directory.
- Unified launchd logs identified the real failure hidden behind exit code 5:
  the replacement broker bootstrap returned `37: Operation already in
  progress` one millisecond before launchd finished removing the old broker.
- Added a red regression test proving that `restartServices()` bootstrapped
  replacements without observing job removal. The test now passes after
  bounded `launchctl print` polling was added for both services.
- `bootout` now ignores only launchd's explicit service-missing result; other
  failures propagate instead of being mistaken for first-install state.
- Advanced the corrected artifact to `0.1.2` rather than reusing the immutable
  `0.1.1` identity.
- Full exact-Node release verification passed with 144/144 tests, 96.10% line
  coverage, 92.82% function coverage, 80.67% branch coverage, synthetic CLI
  journeys, bootstrap and installed-package smoke, publication/secret scans,
  zero high-severity dependency findings, and 15/15 Playwright runtime tests.

## 2026-08-21 — Release 0.1.1 and hardened runtime activation

**Status:** Superseded by the `0.1.2` launchd race fix above

**Scope:** Prepare the completed unified CLI journeys for release `0.1.1`,
limit automatic CI to pushes on `main`, verify the feature branch, merge it
into `main`, build and globally install the reviewed npm tarball with exact
Node.js `24.18.1`, activate the same release through hardened bootstrap while
preserving broker state, and black-box verify that the active runtime and
system `current` link both resolve to `0.1.1`.

## 2026-08-19 — Unified CLI journey contract

**Status:** Implemented; final verification recorded below

**Scope:** Turn every inframux command into a coherent human and machine
journey, beginning with the live onboarding failures observed during a
multi-provider setup. Define one additive `state`/`nextActions` contract,
repair onboarding reconfiguration and reconciliation, make hardened checkout
access diagnosable and safely repairable, return canonical agent instructions,
standardize command help and recovery, and verify the complete experience with
unit, integration, synthetic E2E, installed-package, TTY, accessibility, and
security tests.

### Activity log

- Classified the change as architectural because it modifies public CLI,
  broker, onboarding state-machine, trust, and error contracts.
- Reviewed the live onboarding incident, current CLI parser/rendering,
  onboarding session store, broker operations, provider adapters, public docs,
  test suite, and the existing CLI UX roadmap.
- Compared three approaches and selected an additive unified journey contract
  with independent human and machine presenters. The user approved this
  architecture before implementation.
- Updated `PLANS.md` with every incident-derived P0 requirement and the
  canonical journey contract.
- Wrote and self-reviewed the normative design in
  `docs/superpowers/specs/2026-08-19-unified-cli-journeys-design.md`. Removed a
  contradiction between onboarding completion and later health checks,
  required an action on every incomplete error, and documented UptimeRobot's
  identity limitation without claiming unverified administrative scope.
- Implemented the public journey/action model and additive JSON/error envelope,
  then generated human output from the same canonical state.
- Added nested catalog help, safe pre-verification reconfiguration, internal
  finish reconciliation, replay-safe completion, and repository-bound agent
  instructions.
- Added TTY-gated progress, ASCII/`TERM=dumb` behavior, signal cleanup, hidden
  credential input lifecycle, and accurate saved/not-saved failure copy.
- Added hardened checkout traversal diagnosis and preview/apply repair. The
  privileged helper accepts only the fixed principal and standard target,
  records session/inode/device-bound ACL receipts, and removes only owned ACLs.
- Replaced raw operational JSON in human mode with bounded presenters and
  corrected UptimeRobot identity reporting to a keyed credential fingerprint,
  monitor count, and mutable resource digest.
- Added a real macOS PTY synthetic journey covering failure/retry, interrupted
  authorization reconciliation, repeated finish, nested help, process restart,
  project isolation, and trust preflight. Added an installed-artifact journey
  smoke that rejects malformed machine JSON.
- Split CI into least-privilege `quality`, `security`, `journeys`, and `package`
  jobs on exact Node.js 24.18.1 with pinned actions and bounded timeouts.
- The user approved the written spec. Added and self-reviewed the executable
  TDD plan at
  `docs/superpowers/plans/2026-08-19-unified-cli-journeys.md`, covering nine
  independently testable deliveries from public contracts through packaged
  E2E and CI. Inline execution was selected because project policy forbids
  subagent delegation.
- Final exact Node.js 24.18.1 verification passed: 143/143 unit/integration
  tests, 95.82% lines / 92.82% functions / 80.67% branches, real-PTY synthetic
  multi-process journeys, fresh user-mode bootstrap, installed-package consumer
  smoke, publication and secret scans over 182 tracked files, dependency audit
  with zero vulnerabilities, and 15/15 central Playwright runtime tests. The
  validated npm archive contains 380 files and is 199016 bytes packed / 986825
  bytes unpacked.

## 2026-08-19 — CLI user experience roadmap

**Status:** Planned

**Scope:** Define a public, implementation-ready roadmap for replacing raw CLI
session dumps with a secure human presentation layer, interactive onboarding
progress, explicit completion states, actionable recovery, and copyable next
steps while preserving stable `--json` automation contracts.

### Activity log

- Added `PLANS.md` as the public roadmap and linked it from the README.
- Prioritized onboarding as the P0 milestone, followed by operational commands,
  maintenance lifecycle, and accessibility/discoverability.
- Specified exact English success, failure, and agent-handoff copy; TTY and
  machine-output boundaries; security constraints; file-level implementation
  tasks; TDD steps; and acceptance gates.
- No runtime behavior changed in this planning scope.

## 2026-08-19 — Public-release anonymization

**Status:** Complete

**Scope:** Remove private project catalogs, example repositories, migration
inventories, account identifiers, local paths, personal package ownership, and
internal historical planning artifacts from the publishable Git tree. Add a
deterministic publication-safety gate, switch to a neutral package identity,
verify the complete product, and replace the branch history with a clean public
root commit so removed context cannot reappear through Git history.

### Activity log

- A test-first publication scanner initially reported 84 findings across the
  tracked tree: forbidden private paths, local home paths, and fingerprinted
  private identifiers.
- Removed bundled project catalogs, example repositories, migration inventories,
  machine-local launchers, internal reports, and historical implementation plans.
- Completed package/runtime/test fixture neutralization and final verification.
- Replaced the owner-scoped package identity with the neutral unpublished
  `inframux` name. Removed package-baked catalogs from the npm archive and
  sealed bootstrap; repository onboarding remains dynamic.
- Added `scan:publication` to CI. It checks tracked paths, concrete local home
  paths, personal-email domains, and privately reviewed identifier fingerprints
  without embedding the original identifiers in source.
- Final exact Node.js 24.18.1 verification passed: 114/114 unit/integration
  tests, 95.52% lines / 93.09% functions / 82.03% branches, synthetic
  multi-process E2E, fresh bootstrap smoke, installed-package consumer smoke,
  15/15 central Playwright tests, publication and secret scans over 162 tracked
  files, dependency audit with zero vulnerabilities, package dry-run, and diff
  check. The sanitized npm archive contains 344 files and is 176815 bytes packed
  / 879123 bytes unpacked.
- The public branch is delivered as one clean root commit so removed private
  context is not reachable through the published Git history.

## 2026-08-19 — Derived provider identity repair

**Status:** Complete

**Scope:** Repair static-provider onboarding when the identity pin is derived
from safe provider configuration rather than entered as a separate catalog
field. Preserve existing onboarding sessions and fail closed during live
identity verification.

### Activity log

- Reproduced the Resend authorization failure with a broker integration test:
  an empty, valid non-secret configuration reached enrollment without the
  expected `accountScope` identity pin.
- Extended provider identity contracts with an optional pure derivation step.
  Resend now derives its required full-access capability pin, while
  UptimeRobot deterministically derives its monitor-set fingerprint from sorted
  configured monitor IDs.
- Catalog values remain authoritative and verified adapter output must still
  exactly match the derived identity. No credential value is defaulted,
  persisted in project configuration, or exposed to the agent.
- Verification passed on exact Node.js 24.18.1: 115/115 unit/integration tests,
  95.96% lines / 93.09% functions / 82.12% branches, synthetic multi-process
  E2E, and publication and secret scans over 162 tracked files.
- A live follow-up exposed incompatible spellings for the same Resend
  permission: the official API uses `full_access`, while the initial adapter
  contract used `full-access`. Added a second red-green regression test and
  canonical normalization. Both spellings and omitted legacy configuration are
  accepted, but stored and verified identity metadata always uses the official
  `full_access` value.
- Live onboarding then exposed an ambiguous collection shape: agents naturally
  supplied arrays of Supabase project refs, Vercel project IDs, and UptimeRobot
  monitor IDs, while the adapters accepted only richer named records. Captured
  each failure in sequence and added backward-compatible array shorthand.
  Rich records still enforce optional names and production domains; shorthand
  still verifies every ID against the pinned organization or team and returns
  provider-discovered resource metadata.
