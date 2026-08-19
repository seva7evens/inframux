# Central Playwright Runtime

The hardened install exposes one agent/E2E Playwright runtime at:

```text
/Library/Application Support/inframux/current/runtime/playwright
```

Use the stable launcher from any repository:

```bash
agent-playwright doctor
agent-playwright cli open https://example.com
agent-playwright mcp
agent-playwright test
agent-playwright test --ui
agent-playwright codegen https://example.com
agent-playwright show-trace trace.zip
agent-playwright run scripts/browser-task.mjs
```

Do not use `npx @playwright/mcp@latest`, `npx playwright install`, or project-local browser downloads for agent work.

## Choosing an interface

- Use `cli` for compact, token-efficient interactive browser work. Run `snapshot` before using element references and re-snapshot after navigation.
- Use MCP for persistent exploratory work where structured browser tools are more convenient.
- Use `test` for committed E2E suites and their existing `playwright.config.*` files.
- Use `run` for an API script that should not depend on a project-local Playwright package.

## API script contract

An API script must live inside the current Git workspace and export one default async function:

```js
export default async function ({ playwright, expect, workspace, artifactDir, args }) {
  const browser = await playwright.chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto('https://example.com');
    await page.screenshot({ path: `${artifactDir}/example.png` });
  } finally {
    await browser.close();
  }
}
```

Symlink and path traversal escapes outside the workspace are rejected.

## Isolation

The launcher resolves the nearest Git root and derives a stable repository hash. MCP browser profiles and bounded artifacts are stored separately per repository:

```text
~/.config/inframux/playwright/profiles/<repository-hash>/
~/.config/inframux/playwright/artifacts/<repository-hash>/
~/.config/inframux/playwright/cli-daemon/
```

The CLI also receives a repository-derived default session. Use an explicit CLI session when two concurrent tasks in the same repository need independent browsers.

The JavaScript tooling is installed once with the inframux package. Browser and
CLI daemon state lives outside the sealed release under
`~/.config/inframux/playwright`; normal installation and bootstrap do not
download a browser. The upstream CLI may still create an empty
`~/Library/Caches/ms-playwright/b` browser-server registry directory on macOS;
it contains no downloaded browsers or reusable cache payload.

## Codex MCP

The global Codex configuration points directly to the launcher:

```toml
[mcp_servers.playwright]
command = "/usr/local/bin/agent-playwright"
args = ["mcp"]
startup_timeout_sec = 30
tool_timeout_sec = 180
```

The MCP server is Microsoft's official `@playwright/mcp`. It uses installed Google Chrome and does not download its alpha browser revision.

## Suggested AGENTS.md block

```md
### Browser automation

Use the centralized Playwright runtime only:
`/usr/local/bin/agent-playwright`.

- Prefer `agent-playwright cli` for interactive browser work.
- Use the configured `playwright` MCP for persistent exploratory sessions.
- Run committed E2E suites with `agent-playwright test`.
- Run one-off API scripts with `agent-playwright run <workspace-script.mjs>`.
- Do not run `npx playwright`, `npx @playwright/mcp`, or install Playwright browsers locally.
- Keep screenshots, traces, and test evidence; do not treat them as dependency caches.
```

## Versions

- Node.js: `24.18.1`
- Playwright Test/API: `1.62.1`
- Playwright MCP: `0.0.79`
- Playwright CLI: `0.1.18`
- Browser: installed Google Chrome (no duplicate project browser download)

The root inframux package lock is authoritative. `agent-playwright update` never
mutates the sealed runtime or runs a package manager; it prints the reviewed
package-upgrade and `inframux bootstrap --apply` procedure. Repeat API, CLI,
MCP, and E2E verification after any package upgrade.

## Recovery

Run:

```bash
/usr/local/bin/agent-playwright doctor
```

If a consumer changes its own Playwright configuration, restore that repository
from its reviewed version-control history. inframux never edits project manifests
or lockfiles during bootstrap or browser execution.
