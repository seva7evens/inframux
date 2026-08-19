import assert from 'node:assert/strict';
import test from 'node:test';

import { parseCli } from '../../src/cli/parse.js';
import { renderCommandHelp, resolveCommandHelp } from '../../src/cli/command-catalog.js';
import { renderError, renderResult } from '../../src/cli/render.js';
import { InframuxError } from '../../src/core/errors.js';

test('parses repository-bound commands without a sticky project selector', () => {
  assert.deepEqual(parseCli(['status', '--json']), { command: 'status', json: true, verbose: false });
  assert.deepEqual(parseCli(['project', 'resolve']), { command: 'project.resolve', json: false, verbose: false });
  assert.deepEqual(parseCli(['run', 'vercel', '--', 'projects', 'list', '--meta', 'name=$(touch nope)']), {
    command: 'run', provider: 'vercel', args: ['projects', 'list', '--meta', 'name=$(touch nope)'], json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['call', 'uptimerobot', 'monitors.list', '--input-json', '{"limit":10}', '--json']), {
    command: 'call', provider: 'uptimerobot', operation: 'monitors.list', input: { limit: 10 }, json: true, verbose: false,
  });
  assert.throws(() => parseCli(['status', '--project', 'sample']), /unknown option/i);
  assert.throws(() => parseCli(['use', 'sample']), /unknown command/i);
  assert.throws(() => parseCli(['run', '/tmp/arbitrary', '--', 'anything']), /provider/i);
  assert.throws(() => parseCli(['run', 'vercel', 'projects', 'list']), /separator.*--/i);
});

test('parses explicit onboarding, MCP, browser, audit, lifecycle, and capability commands', () => {
  assert.deepEqual(parseCli(['onboard', 'start', '--services', 'cloudflare,vercel']), {
    command: 'onboard.start', services: 'cloudflare,vercel', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'configure', '018f47d2-8737-7a19-8000-123456789abc', '--service', 'cloudflare', '--input-json', '{"accountId":"one"}']), {
    command: 'onboard.configure', sessionId: '018f47d2-8737-7a19-8000-123456789abc', provider: 'cloudflare', input: { accountId: 'one' }, json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'resume', '018f47d2-8737-7a19-8000-123456789abc', '--json']), {
    command: 'onboard.resume', sessionId: '018f47d2-8737-7a19-8000-123456789abc', json: true, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'authorize', '018f47d2-8737-7a19-8000-123456789abc']), {
    command: 'onboard.authorize', sessionId: '018f47d2-8737-7a19-8000-123456789abc', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'authorize', '018f47d2-8737-7a19-8000-123456789abc', '--oauth-client-json', '/tmp/google.json']), {
    command: 'onboard.authorize', sessionId: '018f47d2-8737-7a19-8000-123456789abc', oauthClientJson: '/tmp/google.json', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'finish', '018f47d2-8737-7a19-8000-123456789abc']), {
    command: 'onboard.finish', sessionId: '018f47d2-8737-7a19-8000-123456789abc', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['onboard', 'reuse', '018f47d2-8737-7a19-8000-123456789abc', '--service', 'vercel', '--from-project', 'shared-infra']), {
    command: 'onboard.reuse', sessionId: '018f47d2-8737-7a19-8000-123456789abc', provider: 'vercel', sourceProject: 'shared-infra', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['prompt', 'onboarding']), { command: 'prompt.onboarding', json: false, verbose: false });
  assert.deepEqual(parseCli(['enroll', 'sample', '--service', 'cloudflare']), {
    command: 'enroll', project: 'sample', provider: 'cloudflare', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['launch', 'mcp', 'sentry']), { command: 'launch.mcp', provider: 'sentry', json: false, verbose: false });
  assert.deepEqual(parseCli(['browser', 'mcp', 'clean']), { command: 'browser.mcp', mode: 'clean', json: false, verbose: false });
  assert.deepEqual(parseCli(['browser', 'mcp', 'persistent', '--provider', 'google-cloud']), {
    command: 'browser.mcp', mode: 'persistent', provider: 'google-cloud', json: false, verbose: false,
  });
  assert.throws(() => parseCli(['browser', 'mcp', 'persistent']), /provider/i);
  assert.deepEqual(parseCli(['capabilities', 'vercel', '--json']), { command: 'capabilities', provider: 'vercel', json: true, verbose: false });
  assert.deepEqual(parseCli(['audit', 'verify', '--json']), { command: 'audit.verify', json: true, verbose: false });
  assert.deepEqual(parseCli(['bootstrap', '--user-mode']), { command: 'bootstrap', mode: 'user', apply: false, json: false, verbose: false });
  assert.deepEqual(parseCli(['update', '--rollback']), { command: 'update', rollback: true, check: false, json: false, verbose: false });
  assert.deepEqual(parseCli(['uninstall', '--dry-run']), { command: 'uninstall', dryRun: true, json: false, verbose: false });
  assert.deepEqual(parseCli(['link', '--project', 'sample', '/tmp/sample', '--write-manifest']), {
    command: 'link', project: 'sample', repository: '/tmp/sample', writeManifest: true, json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['trust', 'approve', '018f47d2-8737-7a19-8000-123456789abc']), {
    command: 'trust.approve', requestId: '018f47d2-8737-7a19-8000-123456789abc', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['trust', 'revoke', '/tmp/sample']), {
    command: 'trust.revoke', repository: '/tmp/sample', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['auth', 'status', '--project', 'sample']), {
    command: 'auth.status', project: 'sample', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['auth', 'revoke', '--project', 'sample', '--service', 'cloudflare']), {
    command: 'auth.revoke', project: 'sample', provider: 'cloudflare', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['replace-token', 'cloudflare']), {
    command: 'replace-token', provider: 'cloudflare', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['reauthorize', 'google-cloud']), {
    command: 'reauthorize', provider: 'google-cloud', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['enroll', 'sample', '--service', 'google-cloud', '--oauth-client-json', '/tmp/google.json']), {
    command: 'enroll', project: 'sample', provider: 'google-cloud', oauthClientJson: '/tmp/google.json', json: false, verbose: false,
  });
  assert.deepEqual(parseCli(['reauthorize', 'google-cloud', '--oauth-client-json', '/tmp/google.json']), {
    command: 'reauthorize', provider: 'google-cloud', oauthClientJson: '/tmp/google.json', json: false, verbose: false,
  });
});

test('renders concise safe status and versioned machine errors with stable exit codes', () => {
  const status = {
    schema: 1, securityMode: 'hardened', project: 'sample',
    repository: 'github.com/example-org/sample_app', checkoutApproved: true,
    providers: [{ id: 'vercel', health: 'healthy', identity: { teamId: 'team_public' } }],
  };
  assert.match(renderResult('status', status, { json: false, verbose: false }), /sample · hardened · checkout approved/);
  assert.match(renderResult('status', status, { json: false, verbose: false }), /vercel · healthy/);
  assert.deepEqual(JSON.parse(renderResult('status', status, { json: true, verbose: false })), status);

  const rendered = renderError(new InframuxError('CHECKOUT_NOT_APPROVED', 'Exact checkout is not approved', {
    recovery: 'inframux trust approve request-123',
  }), true);
  assert.equal(rendered.exitCode, 12);
  assert.deepEqual(JSON.parse(rendered.text), {
    schema: 1,
    error: {
      code: 'CHECKOUT_NOT_APPROVED',
      message: 'Exact checkout is not approved',
      recovery: 'inframux trust approve request-123',
    },
  });
  assert.equal(rendered.text.includes('stack'), false);
});

test('resolves nested help before validating required session identifiers', () => {
  assert.deepEqual(parseCli(['onboard', 'authorize', '--help']), {
    command: 'help', json: false, verbose: false,
  });
  const help = resolveCommandHelp(['onboard', 'authorize', '--help']);
  assert.ok(help);
  const text = renderCommandHelp(help);
  assert.match(text, /^Usage: inframux onboard authorize <session-id>/m);
  assert.match(text, /interactive Terminal/i);
  assert.match(text, /Example:/);
  assert.doesNotMatch(text, /Invalid request ID/);
});

test('renders goal-oriented root and trust preparation help', () => {
  assert.match(renderCommandHelp(resolveCommandHelp([])!), /Set up a project/);
  const trust = renderCommandHelp(resolveCommandHelp(['trust', 'prepare-checkout', '-h'])!);
  assert.match(trust, /Usage: inframux trust prepare-checkout <session-id> \[--apply\]/);
  assert.match(trust, /minimal directory traversal/i);
});
