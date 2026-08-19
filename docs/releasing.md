# npm release policy

`inframux` is technically package-ready but is not published by the
current workflow. CI creates a validated tarball artifact only. This prevents an
ordinary push, pull request, compromised long-lived npm token, or mistaken local
command from becoming a public release.

## Current artifact gate

On exact Node.js `24.18.1`, CI:

1. installs the committed lockfile with lifecycle scripts disabled;
2. runs the complete source/security/synthetic/installed-package verification;
3. creates the npm tarball and independently validates its file list, identity,
   executable mode, packed/unpacked bounds, and required runtime entries;
4. uploads that already-compressed `.tgz` with a pinned official action and
   read-only repository permissions.

There is no npm token, `id-token: write`, `npm publish`, GitHub Release trigger,
or mutable action tag in this workflow.

## Preconditions for the first public release

- Reserve the exact unscoped package name before announcing a release, without
  publishing from an unreviewed machine.
- Decide and record the source/package license. `UNLICENSED` is intentional
  until that decision; do not silently substitute a permissive license.
- Make the source repository public only after history, provider identifiers,
  examples, docs, test fixtures, Git objects, and release artifact pass a fresh
  secret/privacy review.
- Protect the release environment and tag path with required review and CI.
- Configure npm trusted publishing for the exact GitHub organization,
  repository, and release workflow. Do not create a long-lived automation token.
- Enable `id-token: write` only in the isolated publish job; keep `contents:
  read` and no other write permissions.
- Publish by exact version/tag and public access, then verify npm provenance,
  package contents, integrity, ownership, and a clean-machine installation.

npm provenance from a private source repository is not supported. Do not claim
provenance or enable an automated publish job while this repository is private.
See the official [trusted publisher](https://docs.npmjs.com/trusted-publishers/)
and [provenance](https://docs.npmjs.com/generating-provenance-statements/)
documentation before changing that boundary.

## Maintainer release candidate

From a clean reviewed commit:

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24.18.1
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --ignore-scripts
npm run verify
npm run package:dry-run
npm pack
```

Inspect `npm pack --json` rather than the tar listing by eye alone. The committed
package contract must remain stricter than npm's default inclusion behavior.
Never publish a tarball that was not produced from the same reviewed commit and
verification environment.

After a real release, verify the consumer path with an empty npm prefix before
using the package on the actual Mac:

```bash
npm install --global inframux@<exact-version>
inframux bootstrap --json
inframux bootstrap --apply
```

The registry install may use the network and runs the package's built-in exact
Node guard as the interactive user. Bootstrap itself must remain offline and
must never call npm/npx/corepack/tsc or download a Playwright browser.
