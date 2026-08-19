# Unified CLI Journeys Design

**Date:** 2026-08-19

**Status:** Approved architecture; normative design awaiting document review

**Target:** inframux CLI and broker on macOS

**Runtime:** TypeScript on exact Node.js 24.18.1

## Summary

inframux will expose one canonical journey contract for both people and
automation. Command handlers and the broker will return structured outcomes
that answer four questions: what happened, what state the system is in,
whether the journey is complete, and what may be done next. Human output and
`--json` output will be independent presentations of the same outcome.

The first complete journey is project onboarding. The design repairs the live
failures observed during multi-provider onboarding: uncorrectable provider
configuration, missing machine next steps, implicit resume, inaccessible
hardened checkouts, missing agent instructions, non-idempotent completion,
weak UptimeRobot identity, and broken nested help. The same presentation and
recovery rules then cover operational, trust, credential, browser, and
maintenance commands.

## Goals

- Make every finite CLI command understandable without reading internal JSON.
- Give agents stable, additive, machine-readable states and exact commands.
- Preserve repository-bound account selection and hardened secret isolation.
- Let an unverified provider configuration be corrected in the same session.
- Remove mandatory knowledge of `resume` from the happy path.
- Detect hardened broker checkout-access problems before credentials are
  entered and offer a minimal, explicit repair.
- Make completion replayable and always return canonical agent instructions.
- Provide accurate progress without corrupting pipes, CI logs, or JSON.
- Make help and recovery discoverable at every command depth.
- Verify every critical customer journey through installed-package E2E tests.

## Non-goals

- Replacing provider APIs, official CLIs, or MCP servers.
- Adding a cloud control plane or syncing credentials between Macs.
- Moving secrets into project files, environment files, Keychain, or chat.
- Automatically weakening home-directory permissions.
- Inventing a general workflow engine or migrating to a CLI framework.
- Changing repository identity selection or adding a sticky project selector.
- Making provider health checks part of an atomic trust transaction.

## Technology choice

The implementation remains TypeScript on exact Node.js 24.18.1.

- **Performance:** CLI work is I/O-bound. Built-in streams, timers, Unix
  sockets, and filesystem APIs avoid startup and dependency overhead.
- **Security:** the current broker, schemas, redaction, safe-file operations,
  and tests are already strongly typed and reviewed in TypeScript.
- **Ecosystem maturity:** Node provides stable TTY primitives and signal-aware
  process APIs. TTY detection follows the official `isTTY` contract.
- **Maintainability:** one language and the existing test stack keep domain,
  broker, renderer, and E2E contracts aligned.
- **Team scalability:** pure projection and rendering modules can be reviewed
  independently without introducing another framework abstraction.

No runtime dependency is added. ANSI output is generated only by a small,
tested terminal capability module.

## Design principles

1. Domain state is authoritative; presentation never invents workflow state.
2. Human and machine modes differ in rendering, not semantics.
3. Existing JSON fields remain valid; journey fields are additive.
4. Every incomplete state has at least one exact next action.
5. Every error says what was preserved and whether a secret was saved.
6. Destructive or privileged actions are preview-first and explicit.
7. Human copy describes only postconditions that were actually verified.
8. All provider-controlled text is sanitized and length-bounded.
9. Non-interactive execution is deterministic and free of terminal controls.
10. A repeated safe command returns the same semantic outcome.

## Canonical contracts

### Journey state

```ts
export type JourneyState =
  | 'planned'
  | 'configuration-required'
  | 'authorization-required'
  | 'ready-to-finish'
  | 'checkout-access-required'
  | 'complete'
  | 'healthy'
  | 'degraded'
  | 'failed';

export type JourneyActor = 'user' | 'agent';

export interface JourneyAction {
  readonly type: string;
  readonly actor: JourneyActor;
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

`type` values are lower-case kebab-case identifiers. `command` is a complete
shell command without secret values or shell interpolation. Commands use only
values already validated by inframux. `description` is safe plain English.

Success results retain their current top-level fields and add the three
projection fields:

```json
{
  "schema": 1,
  "id": "<session-id>",
  "project": "example-project",
  "state": "configuration-required",
  "complete": false,
  "nextActions": [
    {
      "type": "configure-provider",
      "actor": "agent",
      "command": "inframux onboard configure <session-id> --service vercel --input-json '<json>' --json",
      "description": "Configure non-secret Vercel identity pins.",
      "interactive": false,
      "privileged": false
    }
  ]
}
```

Errors keep the existing `error` object and stable exit code, with projection
fields beside it:

```json
{
  "schema": 1,
  "error": {
    "code": "SESSION_AUTHORIZATION_REQUIRED",
    "message": "Two services still require authorization."
  },
  "state": "authorization-required",
  "complete": false,
  "nextActions": [
    {
      "type": "authorize-providers",
      "actor": "user",
      "command": "inframux onboard authorize <session-id>",
      "description": "Authorize the remaining services in your Terminal.",
      "interactive": true,
      "privileged": false
    }
  ]
}
```

The generic error system accepts structured actions. The legacy scalar
`recovery` string remains populated with the first action command for consumers
that have not adopted `nextActions`.

### Output channels

- Human final results go to stdout.
- Prompts, transient progress, and privileged-operation notices go to stderr.
- `--json` stdout contains exactly one JSON document followed by one newline.
- `--json` never emits ANSI, animation, prose headings, or multiple documents.
- Provider tool streams and MCP byte tunnels retain their protocol-specific
  output and do not receive a journey envelope mid-stream.
- `--verbose` adds only allowlisted diagnostics; it never reveals raw causes,
  response bodies, headers, tokens, cookies, secret paths, or query strings.

### Terminal capabilities

Terminal behavior is derived once from output stream and environment:

```ts
export interface TerminalCapabilities {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly animation: boolean;
  readonly columns: number;
}
```

Animation requires a TTY and is disabled by `CI`, `TERM=dumb`, non-interactive
streams, or JSON mode. `NO_COLOR` disables color only. ASCII output remains
fully informative. Labels are stripped of C0/C1 and ANSI control sequences,
bounded, and wrapped for terminals as narrow as 80 columns.

## Command catalog and help

The parser gains a typed command catalog containing command path, synopsis,
purpose, operands, options, interaction requirements, and one safe example.
Parsing checks `--help` and `-h` for the resolved command path before validating
required positional values. Therefore `inframux onboard authorize --help`
renders help rather than treating `--help` as a session ID.

Unknown commands and options return `INVALID_REQUEST`, the nearest command
usage, and an exact help action. Root help groups commands by user goal:

- set up a project;
- inspect and repair a project;
- use a provider;
- manage inframux;
- get agent instructions.

The catalog is the future source for shell completion, but completion itself is
not required for this implementation.

## Onboarding state machine

### Persisted inputs

The existing session remains the persisted source of truth: project, exact
checkout evidence, requested providers, safe provider configuration, verified
profiles, timestamps, and completion time. Secrets remain exclusively in the
credential store.

Journey state is projected from the session plus broker checkout-access status:

```text
missing provider config  → configuration-required
configured but unverified → authorization-required
all providers verified    → ready-to-finish
broker cannot traverse     → checkout-access-required
session completed          → complete
```

Transient UI states such as prompting and verifying are never persisted.

### Start

`onboard start` creates or validates `.inframux.toml`, captures exact checkout
evidence, creates the session, and asks the broker for a traversal preflight.

The response includes:

- provider plan and official setup/documentation URLs;
- current journey projection;
- one configure action for each missing safe configuration;
- an authorization action only after every provider is configured;
- a checkout repair action when hardened traversal is unavailable.

Checkout repair is presented before credential authorization so the user does
not finish credential work only to discover a local permission blocker.

### Configure and reconfigure

`onboard configure` behavior is deterministic:

- first valid configuration stores the sanitized non-secret object;
- an exact repeated object is an idempotent no-op;
- a different object replaces the previous object while `profile` is absent;
- replacement regenerates the provider catalog from the new safe identity
  pins;
- once `profile` exists, a different object fails with
  `PROVIDER_ALREADY_VERIFIED` and actions to inspect status or start a new
  onboarding transition;
- session completion remains immutable.

No explicit `--replace` flag is required for the common failed-verification
recovery. The session state itself makes replacement safe.

### Authorize

`onboard authorize` remains user-owned and requires an interactive Terminal.
It iterates in registry order and skips providers already carrying a verified
profile.

For each static-token provider:

1. print provider name and official credential URL;
2. read the credential with hidden raw-mode input;
3. start a TTY-safe verifying animation immediately after Enter;
4. ask the broker to verify identity and persist atomically;
5. zero the input buffer in every exit path;
6. mark the provider verified only after credential metadata exists;
7. stop and clear the animation before the next prompt or output.

On a provider failure the command stops, preserves previously verified
providers, says that the failed credential was not saved, and returns the exact
configure or authorize recovery action. Retrying skips completed providers.

OAuth providers use the existing PKCE and browser contract. The action marks
the need for an interactive Terminal and, when applicable, the required
non-secret OAuth client-file option.

### Resume and finish

`resume` remains a public idempotent recovery command, but it is not required
on the happy path.

`finish` performs these steps:

1. load the session for the calling user;
2. reconcile configured but unmarked providers against credential metadata;
3. return `SESSION_AUTHORIZATION_REQUIRED` and exact actions if any provider is
   still incomplete;
4. run the hardened broker traversal preflight;
5. return `BROKER_CHECKOUT_INACCESSIBLE` and an exact preview/apply action when
   required;
6. enroll the current safe catalog;
7. approve the exact checkout and workspace already captured by the session;
8. mark the session complete;
9. return canonical agent instructions and post-completion verification
   actions.

If `completedAt` already exists, `finish` skips mutations and regenerates the
same semantic completion result. `resume` on a completed session returns that
same completion projection. Timestamps already persisted in the session do not
change.

Completion proves verified credential bindings and exact-checkout trust. It
does not claim that later `doctor` network checks or `audit verify` have run.
Those commands are returned as explicit agent actions.

### Agent instructions

The canonical instructions are generated by one pure renderer and returned by:

- every successful `onboard finish`, including replays;
- `inframux agent-instructions` from a trusted repository;
- `inframux agent-instructions --json` as a structured result containing the
  rendered text and current provider list.

The instructions explain repository-bound selection, supported CLI/MCP/API
entry points, health commands, and the documentation path. They never include
credential values, aliases that reveal secret storage, or private state paths.

## Hardened checkout access

### Diagnosis

The broker checks traversal from filesystem root to repository root and Git
common directory using its own effective identity. It reports only:

- whether access is ready;
- the first inaccessible ancestor path;
- whether the issue is an ACL/BSD traversal denial or an unsupported external
  restriction;
- the installed broker principal identifier.

The error code is `BROKER_CHECKOUT_INACCESSIBLE`, not `INVALID_REQUEST`.
Unsupported restrictions receive explanatory recovery without claiming an ACL
will fix them.

### Preview and apply

```text
inframux trust prepare-checkout <session-id>
inframux trust prepare-checkout <session-id> --apply
```

Preview asks the broker for the exact inaccessible ancestors and prints the
minimal planned ACL additions. Apply creates a sealed management request bound
to session ID, caller UID, captured checkout evidence, installed broker
principal, and exact ancestor list. The privileged helper independently loads
and validates the session-derived request; it does not accept arbitrary paths
or principals from command-line arguments.

For each required directory it grants only directory traversal/search. It does
not grant file read, directory listing, write, delete, ownership, or ACL
administration. Existing ACLs and BSD modes are preserved. Owned additions are
recorded with inode/device evidence so retries are idempotent and cleanup never
removes unrelated ACL entries.

The animation begins after the user submits the macOS password and ends before
the helper result is printed. A non-TTY caller receives the exact user-owned
Terminal command instead of hanging for authorization.

## Provider identity presentation

Human summaries display only safe provider-defined identity fields. Keys and
values are allowlisted by the provider definition, sanitized, bounded, and
ordered.

UptimeRobot does not expose a reliable immutable account identifier in the
reviewed monitor-list response, and both account and read-only keys may list
monitors. inframux therefore does not claim that a non-destructive enrollment
proved administrative mutation scope. Its safe operator summary contains:

- a truncated value from the credential store's keyed HMAC fingerprint;
- total monitor count discovered at verification;
- a truncated digest of sorted monitor IDs labelled as a mutable resource
  fingerprint, not an account ID.

The raw key, full HMAC, and full monitor list are not rendered. An empty account
is shown as `0 monitors` with the credential fingerprint rather than
`monitors:`. Configured monitor IDs remain optional resource pins. Setup copy
instructs the user to create an account-specific key; actual mutating calls
still rely on the provider's authorization response. This accurately reflects
UptimeRobot's documented distinction between account, read-only, and
monitor-specific keys without using a destructive permission probe.

## Human presentation

Each human result uses this order:

1. concise outcome heading;
2. safe project/provider summary;
3. preserved or incomplete state when relevant;
4. one `Next step` section grouped by actor;
5. optional safe diagnostics under `--verbose`.

Example after authorization:

```text
✓ 5 of 5 services connected

Authorization is complete. Repository trust is still pending.

Next step — tell your coding agent:
  inframux onboard finish <session-id> --json

You can safely close this terminal.
```

Example after completion:

```text
✓ inframux onboarding complete

Project: example-project
Services: 5 connected
Checkout trust: approved

Next — your coding agent should run:
  inframux status --json
  inframux doctor --json
  inframux audit verify --json
```

The presenter does not dump raw sessions. Copy is centralized so docs and
snapshots use the same terminology: project, repository checkout, service,
credential, connected, verified, trusted, healthy, and complete.

## Operational and maintenance journeys

The same renderer boundary covers finite commands outside onboarding:

- `status`: project, security mode, checkout trust, and one provider row;
- `doctor`: checks grouped as local, identity, provider reachability, and
  repair, followed by exact actions;
- `audit verify`: validity, event count, and safe recovery;
- `capabilities`: provider surfaces and destructive/source-bound labels;
- `auth status/revoke`, `replace-token`, and `reauthorize`: affected binding,
  preservation guarantees, and follow-up verification;
- `bootstrap`, `update`, `rollback`, and `uninstall`: preview, authorization
  boundary, affected version, preserved state, and next check;
- trust operations: exact checkout scope and whether mutation occurred;
- browser modes: clean versus project/provider-persistent scope without
  exposing profile storage paths.

Streaming `run`, `call`, MCP, and browser protocol launchers retain provider
stream behavior. Their preflight errors use the common error and recovery
contract, but successful streams are not wrapped or buffered.

## Error model

Errors are normalized into user-actionable categories:

- syntax and validation;
- onboarding state;
- repository binding and trust;
- broker availability and checkout access;
- missing, expired, scoped, or wrong-identity credentials;
- provider HTTP authorization, rate limit, or response contract;
- network timeout, DNS, TLS, and connection failure;
- local executable or source-policy denial;
- audit and maintenance failure.

Normal human output never prints stack traces or raw nested causes. JSON errors
contain stable error code, bounded message, optional safe detail fields,
journey projection, and exact actions. Provider verification errors state
whether the candidate credential was saved. Network errors may be retried once
only for reviewed idempotent identity reads, with cancellation-aware bounded
jitter.

New stable codes required by this design are:

- `BROKER_CHECKOUT_INACCESSIBLE`;
- `SESSION_AUTHORIZATION_REQUIRED`;
- `PROVIDER_ALREADY_VERIFIED`.

Existing codes and numeric exit statuses remain unchanged. New codes receive
documented non-zero statuses that do not collide with current categories.

## Security analysis

- Journey actions are constructed from validated identifiers, never raw shell
  fragments or provider text.
- Secret prompts remain hidden and buffers are zeroed on success, error, and
  cancellation.
- Candidate credentials are not persisted before identity verification.
- Agent instructions contain no secret material or secret-store location.
- Human renderers sanitize terminal controls and cap untrusted lengths.
- JSON mode receives no ANSI or progress bytes.
- The ACL repair is session-bound, preview-first, minimal, audited, and cannot
  target arbitrary paths or principals.
- Completion revalidates caller ownership and exact captured checkout evidence.
- Reconfiguration cannot silently replace an already verified binding.
- Logs and tests use synthetic IDs and credential canaries only.

## Component boundaries

The implementation should introduce focused modules rather than expand the
existing CLI entry point indefinitely:

- `src/cli/command-catalog.ts`: typed command/help metadata;
- `src/cli/terminal.ts`: capability detection and text sanitization;
- `src/cli/progress.ts`: one TTY-safe progress lifecycle;
- `src/cli/journey.ts`: public projection and action types;
- `src/cli/onboarding-ui.ts`: pure onboarding human presenter;
- `src/cli/operations-ui.ts`: operational/maintenance presenters;
- `src/onboarding/projection.ts`: pure session-to-journey projection;
- `src/trust/access.ts`: broker-side traversal diagnosis;
- existing parser, broker, session store, privileged helper, and render modules
  consume those boundaries.

No module should both mutate domain state and format terminal text. No renderer
should make broker or provider calls.

## Testing strategy

### Unit tests

- journey projection for every onboarding state;
- reconfiguration before and after verification;
- help resolution before positional validation;
- output sanitization, wrapping, ASCII, `NO_COLOR`, and hostile labels;
- fake-TTY progress lifecycle, signal cleanup, and no-animation conditions;
- deterministic action ordering and legacy recovery fallback;
- UptimeRobot identity for empty and populated accounts;
- checkout access diagnosis and minimal ACL planning.

### Integration tests

- broker start/configure/reconfigure/resume/finish/repeated-finish state
  transitions;
- finish reconciliation with credentials committed before disconnect;
- inaccessible checkout typed error and successful post-repair completion;
- agent instructions returned identically from finish replay and command;
- provider failure preserving previously connected services;
- human and JSON rendering from the same broker result;
- privileged request validation rejecting changed paths, principals, caller,
  session evidence, symlinks, and stale filesystem identity.

### Synthetic E2E

Run the installed product in isolated temporary roots through:

1. bootstrap preview and apply;
2. root and nested help;
3. start, configure, reconfigure, authorize, and finish;
4. forced provider failure and retry;
5. interrupted authorization and finish reconciliation;
6. checkout-access failure, repair preview/apply, and retry;
7. repeated finish;
8. status, doctor, audit verify, and agent instructions;
9. update/check/rollback and uninstall dry-run;
10. machine mode with every stdout value parsed as one JSON document.

Human E2E snapshots assert outcomes and next commands without depending on
animation frame timing. JSON contract tests assert additive fields and preserve
existing fields. Package smoke executes the packed npm artifact, not source
imports.

### Verification gate

The release is ready for a real project only when exact Node.js 24.18.1 passes:

- type checking and build;
- unit and integration suites;
- coverage thresholds;
- synthetic multi-process E2E;
- hardened bootstrap and ACL repair smoke;
- installed-package consumer smoke;
- publication and secret scans;
- dependency audit;
- Playwright runtime tests;
- clean Git diff inspection for private identifiers and generated artifacts.

## Customer-journey acceptance matrix

| Journey | Human success criterion | Machine success criterion |
| --- | --- | --- |
| First help | One obvious starting action | Stable usage/error object where applicable |
| Bootstrap | Password boundary, progress, installed version, next step | One parseable result, no ANSI |
| Start | Project, requested services, current step | State and exact next actions |
| Configure | What changed and what remains | Idempotent additive projection |
| Reconfigure | Safe correction in same unverified session | Replacement reflected without new session |
| Authorize | Per-provider progress and preserved partial success | Final state only on stdout |
| Finish | Trust result and post-check commands | Idempotent result with agent instructions |
| Checkout repair | Minimal preview and explicit authorization | Typed issue and exact apply action |
| Status/doctor/audit | Plain health and recovery | Stable structured evidence |
| Reauthorization | Affected service and verification step | No secret exposure or account ambiguity |
| Browser | Clean/persistent scope is explicit | Project/provider binding remains deterministic |
| Maintenance | Effects and preserved state are named | One stable result and exit status |
| Failure | Cause category, preservation, next command | Stable code, state, and next actions |

## Documentation and release

README presents the human path first. `docs/onboarding.md` contains the reusable
agent prompt and machine contract. `docs/operations.md` documents error codes,
checkout preparation, and replay. `docs/testing.md` maps every CJM to its test.
Command help and documentation use examples without personal accounts,
repositories, paths, or provider identifiers.

The package remains publishable from the repository source. CI runs the full
verification gate and release smoke against the packed artifact.

## References

- Node.js TTY API: <https://nodejs.org/api/tty.html>
- Apple file permissions and ACL overview:
  <https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileSystemOverview/FileSystemOverview.html>
- UptimeRobot API v3 and key classes: <https://uptimerobot.com/api/v3/>

## Decision record

The selected approach is an additive unified journey contract with separate
human and machine presenters. A renderer-only patch was rejected because it
would preserve the broken state transitions. A framework migration was
rejected because it adds dependencies and churn without solving broker,
credential, or trust semantics.
