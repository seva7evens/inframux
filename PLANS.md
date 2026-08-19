# CLI User Experience Implementation Plan

> **For agentic workers:** Implement one milestone at a time with test-driven
> development. Keep `--json` backward compatible and do not begin a later
> milestone until the preceding acceptance gate passes.

**Goal:** Make inframux understandable and pleasant for an ordinary developer
without weakening its repository isolation, secret handling, or machine API.

**Architecture:** The CLI will have two explicit presentation contracts over
the same domain results. Human mode is the default and renders concise English
progress, summaries, recovery, and next actions. Machine mode is selected with
`--json`, emits exactly one stable JSON document on stdout, and never emits
animation or decoration.

**Tech stack:** TypeScript, Node.js 24.18.1, ANSI only when supported, Node test
runner, existing broker protocol and provider registry. No UI dependency is
needed.

**Spec:** Product requirements and copy contract in this document.

## Global constraints

- Never print, log, echo, cache, or interpolate credential bytes.
- Prompts and progress use stderr; final results use stdout.
- `--json` stdout remains parseable JSON with no spinner, color, or prose.
- Animation requires an interactive TTY and is disabled for pipes, CI,
  `TERM=dumb`, and non-interactive execution.
- `NO_COLOR` disables color but not useful text or status symbols.
- Provider, project, account, and resource labels must be length-bounded and
  stripped of control and terminal escape characters before rendering.
- Human mode must remain useful without color, Unicode, or animation.
- A failed credential verification must say that the credential was not saved.
- The CLI must never claim onboarding is complete before `onboard finish` and
  the required health checks succeed.
- Provider API and broker protocol behavior remain unchanged unless a milestone
  explicitly defines a versioned protocol change.

## Product requirements

### Output modes

Running a command without `--json` is human mode. Human mode must not dump
internal session objects. It shows only information needed to understand the
result and continue.

Running with `--json` is machine mode. Existing field names and exit codes are
preserved. Interactive commands may still request hidden input on stderr, but
stdout contains only the final JSON document.

`--verbose` adds safe diagnostic context in either mode. It must never expose
secret values or local secret paths.

### Authorization experience

For a five-provider session, the terminal should behave like this:

```text
inframux · Connect project services

  ✓ Resend       Connected · full access
  ✓ Sentry       Connected · organization example-org
  ◐ Supabase     Verifying credentials…
  ○ UptimeRobot  Waiting
  ○ Vercel       Waiting
```

Only one line animates. Completed lines remain stable. The animation begins
after hidden input is submitted and is cleared before any new prompt or error.

After all credentials are verified:

```text
✓ 5 of 5 services connected

Authorization is complete. The repository is not trusted yet.

Next step — tell your coding agent:
  "inframux authorization is complete for session {sessionId}.
   Run `inframux onboard finish {sessionId}`, then verify
   `inframux status --json`, `inframux doctor --json`, and
   `inframux audit verify --json`."

You can safely close this terminal.
```

The session ID is non-secret and must be easy to select and copy. The CLI does
not run `onboard finish` automatically because repository trust and tracked
documentation remain agent-owned steps.

### Failure and retry experience

Failures retain the stable exit code and use actionable English:

```text
✗ Supabase could not be verified

Reason: the credential does not have access to the configured organization.
The credential was not saved. Previously connected services are unchanged.

Retry:
  inframux onboard authorize {sessionId}
```

Network failures distinguish safe categories: timeout, DNS, TLS, connection,
and provider HTTP failure. Raw URLs containing queries, authorization headers,
tokens, response bodies, and low-level stack traces are never printed in normal
mode. `--verbose` may include a whitelisted error code and provider origin.

### Completion experience

`onboard finish` must render a distinct completion state:

```text
✓ inframux onboarding complete

Project: example-project
Repository: current Git checkout
Services: 5 connected and verified
Checkout trust: approved
Audit chain: valid

Agents in this repository can now use the configured provider contexts.
Run `inframux status` at any time to review them.
```

If health checks are not run by `finish`, the CLI must print the exact remaining
commands and describe onboarding as configured, not fully verified.

## Roadmap

### Milestone 1 — Onboarding human interface (P0)

Deliver the authorization progress view, safe provider summaries, success
handoff, partial-failure recovery, and human output for `start`, `resume`,
`authorize`, and `finish`.

### Milestone 2 — Operational command consistency (P1)

Apply the same presentation contract to `status`, `doctor`, `auth status`,
`capabilities`, and `audit verify`. Human mode uses aligned tables and plain
summaries; `--json` remains unchanged.

### Milestone 3 — Maintenance and lifecycle UX (P1)

Standardize `bootstrap`, `update`, `rollback`, and `uninstall`: previews list
effects, destructive boundaries are explicit, preserved state is named, and
long-running work has one non-janky TTY animation.

### Milestone 4 — Discoverability and accessibility (P2)

Add focused command help, examples, shell completion, `NO_COLOR` coverage,
ASCII fallback, narrow-terminal behavior, and a short first-run path from
installation to the reusable onboarding prompt.

---

## Milestone 1 implementation tasks

### Task 1: Define the human presentation boundary

**Files:**

- Create: `src/cli/onboarding-ui.ts`
- Modify: `src/cli/render.ts`
- Test: `test/unit/onboarding-ui.test.ts`

**Interfaces:**

```ts
export type OnboardingProviderView = Readonly<{
  id: string;
  displayName: string;
  state: 'waiting' | 'prompting' | 'verifying' | 'connected' | 'failed';
  identity?: Readonly<Record<string, string>>;
}>;

export type OnboardingSummary = Readonly<{
  sessionId: string;
  project: string;
  providers: readonly OnboardingProviderView[];
  complete: boolean;
}>;

export function renderOnboardingSummary(
  value: OnboardingSummary,
  options: { unicode: boolean; color: boolean },
): string;

export function renderAgentHandoff(sessionId: string): string;
```

- [ ] Write a failing unit test asserting that a successful five-provider
  summary contains all provider names, `5 of 5 services connected`, explicitly
  says repository trust is not complete, and includes the exact `onboard
  finish` handoff command.
- [ ] Run `npx tsx --test test/unit/onboarding-ui.test.ts`; verify it fails
  because the presenter does not exist.
- [ ] Implement pure rendering functions with bounded, escape-free labels and
  deterministic ordering from the provider registry.
- [ ] Add tests for zero color, ASCII fallback, 80-column wrapping, and hostile
  control characters in labels.
- [ ] Run the unit test and `npm run check`; both must pass.
- [ ] Commit as `feat(cli): add onboarding human presenter`.

### Task 2: Add a TTY-safe progress controller

**Files:**

- Modify: `src/cli/onboarding-ui.ts`
- Test: `test/unit/onboarding-ui.test.ts`
- Reference: `src/cli/privileged.ts`

**Interface:**

```ts
export interface ProgressOutput {
  readonly isTTY?: boolean;
  write(value: string): boolean;
}

export class OnboardingProgress {
  constructor(options: {
    output: ProgressOutput;
    environment: Readonly<NodeJS.ProcessEnv>;
    intervalMs?: number;
  });
  update(providers: readonly OnboardingProviderView[]): void;
  stop(): void;
}
```

- [ ] Write failing fake-TTY tests proving only the active line animates and
  `stop()` clears the animation before subsequent output.
- [ ] Add failing tests proving pipes, CI, and `TERM=dumb` never schedule a
  timer or emit cursor-control bytes.
- [ ] Implement one `unref()`-backed interval with idempotent cleanup on normal
  completion, exceptions, SIGINT, and SIGTERM.
- [ ] Use a four-frame Unicode sequence and a four-frame ASCII fallback. Keep
  the interval at 100 ms or slower to avoid terminal flooding.
- [ ] Run the unit tests under both TTY and non-TTY fakes and commit as
  `feat(cli): add safe onboarding progress`.

### Task 3: Wire authorization events and success handoff

**Files:**

- Modify: `src/cli/main.ts`
- Modify: `src/cli/render.ts`
- Test: `test/integration/cli.test.ts`

- [ ] Add a failing integration test for a three-provider session. Assert that
  stderr shows prompting then verification in provider order, stdout ends with
  a human summary, and the complete internal session JSON is absent.
- [ ] Add a failing `--json` test asserting stdout parses as one JSON value and
  contains no ANSI escape sequences or prose handoff.
- [ ] Update `onboard authorize` to drive `OnboardingProgress` around each
  hidden input and broker enrollment call. Mark providers already carrying a
  profile as connected without prompting again.
- [ ] Render verified identity fields from broker metadata only. Never infer a
  successful identity from submitted configuration.
- [ ] Print the copyable English agent handoff only after every requested
  provider has a verified profile.
- [ ] Run `npm run test:integration` and commit as
  `feat(cli): guide users after authorization`.

### Task 4: Make failures actionable and safely diagnosable

**Files:**

- Modify: `src/providers/http-transport.ts`
- Modify: `src/core/errors.ts`
- Modify: `src/cli/onboarding-ui.ts`
- Test: `test/unit/http-transport.test.ts`
- Test: `test/integration/cli.test.ts`

- [ ] Add failing transport tests for timeout, DNS, TLS, connection reset, 401,
  403, 429, redirect, malformed JSON, and invalid local header input.
- [ ] Introduce a bounded non-secret error detail such as
  `networkCategory: 'timeout' | 'dns' | 'tls' | 'connection'` while preserving
  existing public error codes.
- [ ] Retry a provider identity GET once only when it is idempotent and the
  category is timeout, DNS, TLS handshake interruption, or connection reset.
  Use a bounded jittered delay below one second and respect cancellation.
- [ ] Render the provider, safe reason, unsaved-credential guarantee, preserved
  progress, and exact retry command. Do not print raw causes in normal mode.
- [ ] Verify a failed verification never calls `CredentialStore.put` and the
  input buffer is zeroed.
- [ ] Run unit and integration tests and commit as
  `feat(cli): add actionable provider recovery`.

### Task 5: Render start, resume, and finish as a coherent journey

**Files:**

- Modify: `src/cli/main.ts`
- Modify: `src/cli/render.ts`
- Modify: `src/cli/onboarding-ui.ts`
- Test: `test/integration/cli.test.ts`
- Test: `test/e2e/synthetic.e2e.test.ts`

- [ ] Add failing human-mode tests for `onboard start`, `resume`, and `finish`.
  Assert every success output answers: what happened, what is configured, and
  what the user or agent does next.
- [ ] Preserve current JSON result objects byte-for-field in `--json` mode.
- [ ] Make `finish` distinguish credential completion, exact-checkout trust,
  provider health, and audit verification. Never collapse them into one vague
  success message.
- [ ] Extend synthetic E2E to run the complete human journey and separately
  parse every machine-mode response.
- [ ] Run `npm run test:e2e` and commit as
  `feat(cli): complete onboarding journey`.

### Task 6: Document and package the UX contract

**Files:**

- Modify: `README.md`
- Modify: `docs/onboarding.md`
- Modify: `docs/operations.md`
- Modify: `docs/testing.md`
- Modify: `scripts/package-smoke.mjs`

- [ ] Document human mode first and show `--json` only in agent/automation
  examples.
- [ ] Add the exact post-authorization agent handoff and explain why `finish`
  remains separate.
- [ ] Add package-smoke assertions that installed human mode contains no raw
  session dump and installed `--json` output still parses.
- [ ] Run `npm run verify`; require typecheck, all tests, coverage, synthetic
  E2E, bootstrap smoke, package smoke, publication scan, secret scan,
  dependency audit, and Playwright runtime tests to pass.
- [ ] Review all English copy for consistent terms: `service`, `credential`,
  `project`, `repository checkout`, `connected`, `verified`, and `complete`.
- [ ] Commit as `docs(cli): document the human output contract`.

## Milestone 1 acceptance gate

- A new user can identify every connected service without reading JSON.
- After authorization, the next agent instruction is visible and copyable.
- Partial success is retained and explained after a failure.
- Human output never claims repository trust before `onboard finish`.
- Every error says whether credential data was saved.
- No animation appears in pipes, CI, logs, or `--json` output.
- Existing scripts consuming `--json` require no changes.
- No secret, authorization header, credential fingerprint, or private state
  path appears in snapshots, logs, errors, documentation examples, or package
  artifacts.

## Later-milestone acceptance gates

### Operational consistency

- `status` and `auth status` show one readable row per provider.
- `doctor` separates local health, identity verification, provider reachability,
  and recovery actions.
- `capabilities` explains stable, preview, destructive, and source-bound
  operations without requiring knowledge of the internal schema.
- `audit verify` reports validity, event count, and safe recovery in one screen.

### Maintenance lifecycle

- Every maintenance preview names what changes and what state is preserved.
- Password submission is followed immediately by a responsive progress state.
- Successful update and rollback identify active and previous versions.
- Same-version development builds cannot require repeated uninstall/bootstrap;
  the development release channel must produce a distinct immutable version.

### Discoverability and accessibility

- `inframux --help` leads to one obvious first action for new users.
- Every command supports focused `--help` with one safe example.
- zsh completion is generated from the same provider and command registries.
- Human output is understandable at 80 columns, without color, and with ASCII
  fallback.
