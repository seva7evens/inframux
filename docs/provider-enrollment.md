# Provider enrollment and live acceptance

Live-account acceptance is pending. Production identity/API adapters are
implemented and protocol-tested without real credentials; this checklist is run
with the user present to enroll and validate the intended accounts. Static
enrollment accepts a secret through hidden TTY/stdin,
verifies identity/capability first, and atomically replaces the old credential
only after success.

## Capability contract

| Provider | Registered capabilities |
| --- | --- |
| Cloudflare | `identity.verify`, `resources.list`, `api.request`, `source.deploy` |
| Google | `identity.verify`, `resources.list`, `api.request` |
| PostHog | `identity.verify`, `resources.list`, `api.request` |
| Resend | `identity.verify`, `resources.list`, `api.request` |
| Sentry | `identity.verify`, `resources.list`, `api.request` |
| Supabase | `identity.verify`, `resources.list`, `api.request`, `database.migrate` |
| Synthetic | `identity.verify`, `resources.list`, `mcp.launch` |
| UptimeRobot | `identity.verify`, `resources.list`, `api.request` |
| Vercel | `identity.verify`, `resources.list`, `api.request`, `source.deploy` |

`api.request` is a bounded relative request to the adapter's fixed official
origin; callers cannot provide authentication headers, absolute URLs, or
redirect targets. `source.deploy` and
`database.migrate` stay source-bound until they use the snapshot/remote-build
path without executing repository code in the credential context.

### Cloudflare configuration contract

Cloudflare requires `accountId`. Optional `zones` accepts either the concise
form `["example.com", "example.org"]` or objects such as
`[{ "name": "example.com" }]`; both forms are normalized to names and every
returned zone is still pinned to the configured account. Account and zone
discovery follows Cloudflare pagination rather than assuming the first 50
results are complete.

The default credential kind is the durable **Account API Token** created under
Manage Account > Account API Tokens. inframux verifies it through the official
`/accounts/{account_id}/tokens/verify` endpoint and does not require unrelated
user membership or account-list permissions. Explicit legacy User API Tokens
remain available with `credentialKind: "user-api-token"`; they use the separate
user verification endpoint and must prove access to the configured account.

Grant `Zone Read` for enrollment plus the `Edit` permission groups needed by
the intended operations. Cloudflare defines `Edit` as
create/read/update/delete/list; there is no safe single read-only probe that
proves every possible product permission. Enrollment proves that the token is
active and can access the pinned zones. Later calls fail closed with
`SCOPE_MISSING` if a specific operation lacks permission. Do not paste a Global
API Key: it uses a different authentication scheme and is intentionally not
accepted as a Bearer token.

Account-owned tokens are suitable for durable infrastructure automation but
Cloudflare's compatibility matrix still excludes some products, including
Turnstile, Registrar, Page Rules, and selected Zero Trust surfaces. Those
operations require a separately enrolled explicit User API Token; inframux
never silently falls back to an ambient user credential.

References: [create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/),
[account-owned tokens](https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/),
[verify an account token](https://developers.cloudflare.com/api/resources/accounts/subresources/tokens/methods/verify/),
[token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/),
[list accounts](https://developers.cloudflare.com/api/resources/accounts/methods/list/),
and [list zones](https://developers.cloudflare.com/api/resources/zones/methods/list/).

## Live-repository sequence

Every repository uses the same [universal onboarding](onboarding.md) flow. In
the repository chat, replace the prompt's single service placeholder and let the
agent run `onboard start/configure`. The user runs only the returned `onboard
authorize` command in Terminal; the agent resumes and finishes. The numbered
checks below are the live-account acceptance criteria.

1. Run `inframux bootstrap --apply`, then preview/create the tracked manifest
   with `link --project <project-id> <absolute-repository> [--write-manifest]` and
   approve the returned short-lived request.
2. Enroll one static-token service at a time with `inframux enroll <project-id>
   --service <id>`. The required one-time inputs are:
   Cloudflare account-owned API token with the required management permissions;
   Vercel account token; Supabase
   PAT; Sentry organization token; UptimeRobot Main API Key; Resend Full Access
   key; and, when adopted, a PostHog personal API key.
3. For Google, download one **Desktop app** OAuth client JSON and run
   `inframux enroll <project-id> --service google-cloud --oauth-client-json
   /absolute/client.json`. Browser consent uses S256 PKCE, a random
   `127.0.0.1` callback, offline access, forced consent, and the catalog scope
   pack. The OAuth consent screen must be Production; Testing-mode refresh
   tokens with broad scopes expire after seven days.
4. Verify immutable identity and scopes before storage: Cloudflare account/zone,
   Vercel team/project/domain, Supabase organization/project refs, Sentry
   origin/org/projects, UptimeRobot account/monitors, Resend team/domain,
   PostHog region/project, and Google account/projects/scopes.
5. Run `auth status`, repository `status`, `doctor`, `resources.list`, and
   provider-specific read-only `api.request` checks before any write. Then test
   one reversible mutation, wrong-account rejection, rotation, cancellation,
   and restart persistence.
6. Verify `inframux audit verify --json` and confirm no credential appeared in
   argv, output, project files, browser profiles, or diagnostics.
7. Only then mark that provider live-ready. A failure leaves it disabled and
   does not select an ambient account.

Google OAuth uses one logical profile but retains OAuth refresh plus isolated
gcloud access-token contexts internally. It must use a dedicated Desktop
client, S256 PKCE, exact 127.0.0.1 loopback callback, offline access, a
consent screen suitable for long-lived refresh tokens (not the seven-day
Testing configuration), and only the explicitly approved capability packs.
Calls can select only the built-in Google API registry (Cloud Resource Manager,
Service Usage, IAM, Billing, Compute, Run, Storage, SQL, DNS, Pub/Sub, Secret
Manager, Logging, Monitoring, Cloud Build, Artifact Registry, Drive, YouTube,
Sheets, Docs, Calendar, Gmail, Analytics, and Search Console); arbitrary
`googleapis.com` hosts are deliberately rejected.
