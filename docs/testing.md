# Testing

## Local gates

Node must be exactly `24.18.1`.

```bash
npm ci --ignore-scripts
npm run check
npm run build
npm test
npm run test:coverage
npm run test:e2e
npm run test:journeys
npm run test:bootstrap
npm run test:package
npm run scan:publication
npm run scan:secrets
npm audit --audit-level=high
npm run test:runtime
npm run package:dry-run
```

Unit/integration tests cover configuration, path/file attacks, Git trust,
vault/redaction/audit, bounded RPC, provider policies, worker isolation,
broker/CLI/MCP, provider adapters, OAuth, browsers, source snapshots, sealed
coordinator, macOS management simulation, and lifecycle rollback. Synthetic
E2E rebuilds the project, creates two temporary logical projects/credentials,
starts separate broker/worker children, invokes compiled CLI commands, and
deletes the entire root. Run it twice when changing lifecycle, sockets, leases,
or cleanup. The separate-process scenario also proves restart persistence,
successful token rotation, project-scoped revoke, and that the other project
continues to operate.

Provider verification is intentionally layered: protocol-faithful loopback
servers exercise every real static adapter and Google OAuth/API partition,
while the separate-process E2E uses the synthetic adapter. Production broker
origins cannot be redirected by environment variables, so CI cannot
accidentally send a test credential to an arbitrary host.

The release-readiness run has two installed-artifact layers. The first performs
a fresh user-mode sealed bootstrap from the built checkout. The second runs
`npm pack`, validates the archive allowlist/modes/sizes, installs the actual
`.tgz` globally into a disposable prefix with an isolated npm cache, changes to
an unrelated cwd, and invokes only the installed bin. It guards npm/npx/corepack/
tsc during bootstrap, starts the sealed broker/worker, checks the central
Playwright doctor/API, proves the npm package tree was not mutated, and verifies
preserving-state uninstall. This catches relocation, dependency-closure, npm
`.bin`, lifecycle-script, and package-content defects source tests cannot expose.

GitHub Actions exposes four independent required signals:

- `quality` — typecheck, build, unit/integration tests, coverage, and central Playwright runtime;
- `security` — publication policy, secret scanning, and high-severity dependency audit;
- `journeys` — real PTY authorization, retry/reconciliation, broker/worker isolation, and bootstrap lifecycle;
- `package` — npm pack, disposable global install, installed CLI journey smoke, and release artifact upload.

Every job runs on `macos-15` with exact Node.js `24.18.1`, read-only repository
permissions, pinned actions, a bounded timeout, and lifecycle scripts disabled
during dependency installation.

No test may contact a real provider or contain a real token/cookie/session.
Use obvious `SYNTHETIC-*` canaries and assert they are absent from every
non-vault artifact. Real-provider checks are manual acceptance after enrollment,
not CI.

The in-process coverage gate is 85% lines, 85% functions, and 70% branches.
Compiled CLI/broker/worker entrypoints execute in child processes and are
therefore validated by the separate mandatory E2E gate instead of being
misreported as uncovered parent-process branches.

## Failure discipline

Every behavior change starts with a focused failing test, then the minimal
implementation, focused GREEN, and full gate. A timeout or hung child is a
failure; do not increase waits until the process/socket/cleanup root cause is
understood.
