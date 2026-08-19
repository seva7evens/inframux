# Unified CLI journeys implementation report

Date: 2026-08-19

## Outcome

inframux now exposes one journey contract to humans and agents. Finite machine
responses carry `state`, `complete`, and ordered `nextActions`; default human
output presents the same outcome and exact next command without internal
session dumps. Existing success fields, error codes, exit statuses, legacy
recovery strings, provider streams, and MCP tunnels remain compatible.

## Delivered product behavior

- Root and nested help resolve before positional validation.
- Onboarding configuration is replaceable only before provider verification.
- Authorization uses a hidden user-owned Terminal, TTY-only progress, accurate
  saved/not-saved failures, and a copyable agent handoff.
- `finish` reconciles interrupted enrollment, is replay-safe, approves only the
  captured checkout, and returns canonical repository agent instructions.
- Hardened checkout access is diagnosed before credentials are requested. The
  repair is preview-first, search-only, fixed-principal, session-bound, and
  tracked with private inode/device receipts for idempotent cleanup.
- Status, doctor, audit, capabilities, trust, and lifecycle commands have
  bounded human presenters; JSON remains one undecorated document.
- UptimeRobot output no longer invents an account identity or empty monitor
  fingerprint.

## Security decisions

No credential enters argv, repository configuration, agent instructions, or
journey actions. Secret buffers are zeroed, terminal controls are sanitized,
actions accept only validated command bytes, and animation is disabled for
JSON, pipes, CI, and dumb terminals. ACL management rejects arbitrary paths and
principals, does not claim pre-existing ACLs, and cleans only receipts matching
the original directory device/inode.

## Verification architecture

The local `npm run verify` gate and GitHub Actions cover four independent risk
areas:

1. source quality, unit/integration behavior, coverage, and shared Playwright;
2. publication safety, secret scanning, and dependency audit;
3. real macOS PTY CLI journeys plus broker/worker and bootstrap lifecycle;
4. actual npm tarball installation in a disposable global prefix.

No automated test contacts a real provider. Live-account acceptance remains a
separate user-controlled step after this synthetic and installed-artifact gate.

## Final evidence

Fresh test counts, coverage, archive size, scans, and full verification status
are recorded in `PROGRESS.md` after the final release-readiness run.
