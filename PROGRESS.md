# inframux implementation journal

## Working protocol

- Start implementation requests with a dated scope entry.
- Record verification evidence without credentials, private identifiers, or
  machine-specific paths.
- Keep only publication-safe project history in this file.

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
