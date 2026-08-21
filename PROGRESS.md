# inframux implementation journal

## Working protocol

- Start implementation requests with a dated scope entry.
- Record verification evidence without credentials, private identifiers, or
  machine-specific paths.
- Keep only publication-safe project history in this file.

## 2026-08-21 — Release 0.1.1 and hardened runtime activation

**Status:** In progress

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
