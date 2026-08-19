# Unified CLI Journeys Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a production-grade human and machine CLI journey, with complete onboarding recovery, deterministic next actions, hardened checkout preparation, help, CI, and installed-package E2E coverage.

**Architecture:** Pure domain projections compute state and next actions from broker/session results. Human and JSON renderers consume the same projection; mutations remain in the broker and privileged helper. Existing JSON fields remain additive-compatible and streaming provider protocols remain unwrapped.

**Tech Stack:** TypeScript 7, exact Node.js 24.18.1, Zod 4, Node test runner, Unix RPC, macOS ACL tooling, GitHub Actions macOS runners.

**Spec:** `docs/superpowers/specs/2026-08-19-unified-cli-journeys-design.md`

## Global Constraints

- Use exact Node.js 24.18.1 and add no runtime dependency.
- Never print, log, persist, or interpolate credential bytes into commands.
- Human output is default; `--json` emits one JSON document on stdout.
- Progress and prompts use stderr and animation is TTY-only.
- Existing JSON success fields, error fields, and exit codes remain compatible.
- Reconfiguration is allowed only before provider verification.
- ACL changes are preview-first, session-bound, and grant search only.
- All implementation and verification runs sequentially without subagents.

---

### Task 1: Canonical Journey and Error Contracts

**Files:**
- Create: `src/cli/journey.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/cli/render.ts`
- Test: `test/unit/journey.test.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Produces: `JourneyState`, `JourneyAction`, `JourneyProjection`, `withJourney()`, `journeyError()`.
- Consumes: validated identifiers and existing `InframuxError` codes.

- [ ] Write failing tests asserting deterministic actions, immutable projections, additive JSON results, action-bearing errors, legacy `recovery`, and no secret/control bytes.
- [ ] Run `npx tsx --test test/unit/journey.test.ts test/unit/cli.test.ts`; expect missing journey exports and new error codes.
- [ ] Implement the exact spec types, safe action construction, three new error codes, structured error projection, and non-colliding exit codes.

```ts
export interface JourneyAction {
  readonly type: string;
  readonly actor: 'user' | 'agent';
  readonly command: string;
  readonly description: string;
  readonly interactive: boolean;
  readonly privileged: boolean;
}
export interface JourneyProjection {
  readonly state: JourneyState;
  readonly complete: boolean;
  readonly nextActions: readonly JourneyAction[];
}
```

- [ ] Run the focused tests and `npm run check`; expect pass.
- [ ] Commit `feat(cli): add canonical journey contract`.

### Task 2: Command Catalog and Nested Help

**Files:**
- Create: `src/cli/command-catalog.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/main.ts`
- Test: `test/unit/cli.test.ts`
- Test: `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: existing `CliCommand` union.
- Produces: `resolveHelp(argv)`, `renderHelp(path)`, command metadata for every public finite command.

- [ ] Add failing cases for root help, `onboard --help`, `onboard authorize --help`, `trust prepare-checkout --help`, invalid nested syntax, and safe examples.
- [ ] Run focused tests; expect `--help` to be parsed as a UUID and fail.
- [ ] Implement help pre-resolution before operand validation and catalog-backed English help.

```ts
export interface CommandHelp {
  readonly path: readonly string[];
  readonly usage: string;
  readonly purpose: string;
  readonly example: string;
}
export function resolveHelp(argv: readonly string[]): CommandHelp | undefined;
export function renderHelp(help: CommandHelp): string;
```

- [ ] Run focused tests and typecheck; expect pass.
- [ ] Commit `feat(cli): add discoverable command help`.

### Task 3: Onboarding Projection and Safe Reconfiguration

**Files:**
- Create: `src/onboarding/projection.ts`
- Modify: `src/onboarding/session-store.ts`
- Modify: `src/broker/broker.ts`
- Test: `test/unit/onboarding.test.ts`
- Test: `test/integration/onboarding-session.test.ts`
- Test: `test/integration/broker.test.ts`

**Interfaces:**
- Consumes: `OnboardingSession`, provider registry metadata, checkout readiness.
- Produces: `projectOnboardingJourney(session, registry, access)`, replacement of unverified configuration, enriched broker responses.

- [ ] Add failing tests for all persisted states, exact next commands, replacing wrong unverified config, exact-repeat no-op, and verified/completed immutability.
- [ ] Run focused tests; expect the current `Provider is already configured` failure.
- [ ] Implement pure projection and safe replacement while preserving timestamps and caller ownership.

```ts
export function projectOnboardingJourney(
  session: OnboardingSession,
  providers: ProviderRegistry,
  checkoutAccess: 'ready' | 'required',
): JourneyProjection;
```

- [ ] Make start/configure/reuse/status/resume return existing fields plus projection.
- [ ] Run focused tests and typecheck; expect pass.
- [ ] Commit `feat(onboarding): add recoverable journey state`.

### Task 4: Idempotent Finish and Agent Instructions

**Files:**
- Modify: `src/broker/broker.ts`
- Modify: `src/broker/operations.ts`
- Modify: `src/broker/service.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/main.ts`
- Modify: `src/integration/agent-config.ts`
- Test: `test/integration/broker.test.ts`
- Test: `test/integration/cli.test.ts`
- Test: `test/unit/agent-config.test.ts`

**Interfaces:**
- Consumes: onboarding projection and credential metadata reconciliation.
- Produces: `onboardingCompletionResult()`, `agent-instructions`, replayable `finish` and completed `resume`.

- [ ] Add failing tests for finish without explicit resume, incomplete typed recovery, first/repeated finish equivalence, completed resume, and repository-bound agent instructions.
- [ ] Run focused tests; expect incomplete or missing instruction failures.
- [ ] Extract broker reconciliation, make finish replay-safe, return `agentInstructions`, and add `agent-instructions [--json]`.

```ts
export interface OnboardingCompletionResult extends JourneyProjection {
  readonly schema: 1;
  readonly complete: true;
  readonly project: string;
  readonly providers: readonly string[];
  readonly agentInstructions: string;
}
```

- [ ] Run focused tests and typecheck; expect pass.
- [ ] Commit `feat(onboarding): make completion replayable`.

### Task 5: TTY-Safe Human Presentation and Authorization Progress

**Files:**
- Create: `src/cli/terminal.ts`
- Create: `src/cli/progress.ts`
- Create: `src/cli/onboarding-ui.ts`
- Create: `src/cli/operations-ui.ts`
- Modify: `src/cli/render.ts`
- Modify: `src/cli/main.ts`
- Test: `test/unit/terminal.test.ts`
- Test: `test/unit/progress.test.ts`
- Test: `test/unit/onboarding-ui.test.ts`
- Test: `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: canonical journey projection and safe broker result fields.
- Produces: `detectTerminalCapabilities()`, `ProgressController`, command presenters, authorization handoff.

- [ ] Add failing fake-TTY tests for frame lifecycle, cleanup, CI/pipe/JSON silence, `NO_COLOR`, ASCII, 80 columns, and hostile labels.
- [ ] Add failing CLI tests proving human mode never dumps raw sessions and JSON mode remains one document.
- [ ] Implement terminal capabilities, a single unref-backed progress controller, pure presenters, and per-provider authorization events.

```ts
export function detectTerminalCapabilities(input: {
  readonly isTTY: boolean;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly columns?: number;
  readonly json: boolean;
}): TerminalCapabilities;

export class ProgressController {
  start(label: string): void;
  succeed(label: string): void;
  fail(label: string): void;
  stop(): void;
}
```

- [ ] Ensure every secret buffer is zeroed and failed verification says it was not saved.
- [ ] Run focused tests, integration tests, and typecheck; expect pass.
- [ ] Commit `feat(cli): deliver guided onboarding UX`.

### Task 6: Hardened Checkout Access Preflight and Repair

**Files:**
- Create: `src/trust/access.ts`
- Modify: `src/broker/operations.ts`
- Modify: `src/broker/broker.ts`
- Modify: `src/broker/service.ts`
- Modify: `src/install/management.ts`
- Modify: `src/install/macos-system.ts`
- Modify: `src/bin/manage.ts`
- Modify: `src/cli/parse.ts`
- Modify: `src/cli/main.ts`
- Test: `test/integration/trust.test.ts`
- Test: `test/integration/management.test.ts`
- Test: `test/integration/broker.test.ts`
- Test: `test/integration/cli.test.ts`

**Interfaces:**
- Produces: broker traversal probe result, ACL repair plan, sealed `checkout-access` management request, preview/apply command.
- Consumes: session-bound checkout evidence, caller UID, installed `_inframux` principal.

- [ ] Add failing tests for the first inaccessible ancestor, ready access, symlink/path/caller tampering, exact ACL argv, preview, retry, and typed recovery.
- [ ] Run focused tests; expect missing access operation and management schema.
- [ ] Implement traversal probing without directory listing and a session-bound repair plan.

```ts
export interface CheckoutAccessPlan {
  readonly ready: boolean;
  readonly principal: '_inframux';
  readonly ancestors: readonly string[];
}
export function planCheckoutAccess(input: {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly inaccessibleAncestors: readonly string[];
}): CheckoutAccessPlan;
```

- [ ] Extend the privileged helper with `checkout-access`; independently validate standard install root, caller, target ancestors, and principal before `/bin/chmod +a "group:_inframux allow search"`.
- [ ] Wire start/finish preflight and `trust prepare-checkout <session> [--apply]`.
- [ ] Run focused tests, bootstrap smoke, and typecheck; expect pass.
- [ ] Commit `feat(trust): add minimal checkout access repair`.

### Task 7: Provider Identity and Operational Presenters

**Files:**
- Modify: `src/providers/adapters/uptimerobot.ts`
- Modify: `src/providers/definitions/others.ts`
- Modify: `src/broker/broker.ts`
- Modify: `src/cli/operations-ui.ts`
- Modify: `src/cli/render.ts`
- Test: `test/integration/provider-adapters.test.ts`
- Test: `test/integration/broker.test.ts`
- Test: `test/unit/cli.test.ts`

**Interfaces:**
- Consumes: credential HMAC metadata, provider resources, operational command results.
- Produces: safe UptimeRobot credential/resource summary and human status/doctor/audit/capability/maintenance output.

- [ ] Add failing tests for zero/populated monitors, no `monitors:` identity, no admin-scope overclaim, and concise operational outputs.
- [ ] Run focused tests; expect current empty fingerprint and JSON human dumps.
- [ ] Render truncated keyed credential fingerprint only at the broker boundary and label monitor digest mutable.

```ts
export interface UptimeRobotOperatorIdentity {
  readonly credentialFingerprint: string;
  readonly monitorCount: string;
  readonly resourceFingerprint: string;
}
```

- [ ] Add command-specific human summaries while leaving streams and JSON unchanged.
- [ ] Run focused tests, integration tests, and typecheck; expect pass.
- [ ] Commit `feat(cli): unify operational journeys`.

### Task 8: Installed-Package E2E and CI

**Files:**
- Modify: `test/e2e/synthetic.e2e.test.ts`
- Modify: `scripts/e2e-synthetic.mjs`
- Modify: `scripts/package-smoke.mjs`
- Create: `scripts/cli-journey-smoke.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/testing.md`

**Interfaces:**
- Consumes: built and packed CLI, isolated broker/worker fixtures.
- Produces: `test:journeys` and CI gates for human, machine, recovery, package, and macOS lifecycle journeys.

- [ ] Add an installed-package journey smoke that parses every JSON stdout and asserts human next steps without credential canaries.
- [ ] Add failure/retry, interrupted authorization reconciliation, repeated finish, nested help, and access-repair simulation to synthetic E2E.
- [ ] Split CI into `quality`, `security`, `journeys`, and `package` jobs with least-privilege permissions, exact Node, timeouts, and artifact handoff.

```yaml
permissions:
  contents: read
jobs:
  quality:
    runs-on: macos-15
  security:
    runs-on: macos-15
  journeys:
    runs-on: macos-15
  package:
    runs-on: macos-15
```

- [ ] Run each new script locally and verify a deliberately malformed JSON result fails the smoke.
- [ ] Run `npm run verify`; expect all gates pass.
- [ ] Commit `test: cover complete CLI journeys in CI`.

### Task 9: Public Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/onboarding.md`
- Modify: `docs/operations.md`
- Modify: `docs/testing.md`
- Modify: `PLANS.md`
- Modify: `PROGRESS.md`
- Create: `docs/reports/2026-08-19-unified-cli-journeys.md`

**Interfaces:**
- Consumes: verified command output and test evidence.
- Produces: publication-safe user/agent docs and final implementation report.

- [ ] Update human-first onboarding, reusable agent prompt, exact recovery commands, JSON schema, trust preparation, and command help.
- [ ] Mark delivered roadmap items and record actual test counts, coverage, package size, and CI matrix without private identifiers.
- [ ] Run `npm run verify`, `npm pack --dry-run`, `git diff --check`, publication scan, secret scan, and clean-worktree review.
- [ ] Inspect the installed binary's root/nested help and human/JSON onboarding output.
- [ ] Commit `docs: publish unified CLI journey guide`.
