import assert from 'node:assert/strict';
import { cp, lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startSyntheticSystem } from '../helpers/system.js';

test('runs the compiled CLI through separate broker and worker processes with two isolated projects', async (t) => {
  const system = await startSyntheticSystem();
  t.after(() => system.stop());

  const bootstrap = await system.run('alpha', ['bootstrap', '--user-mode', '--json']);
  assert.equal(bootstrap.code, 0, bootstrap.stderr);
  assert.equal(JSON.parse(bootstrap.stdout).mode, 'user');
  assert.equal(/launch-daemon/i.test(bootstrap.stdout), false);

  const nestedHelp = await system.run('alpha', ['onboard', 'authorize', '--help']);
  assert.equal(nestedHelp.code, 0, nestedHelp.stderr);
  assert.match(nestedHelp.stdout, /Usage: inframux onboard authorize <session-id>/);

  const sessionIds: Partial<Record<'alpha' | 'beta', string>> = {};

  for (const project of ['alpha', 'beta'] as const) {
    const started = await system.run(project, ['onboard', 'start', '--services', 'synthetic', '--json']);
    assert.equal(started.code, 0, started.stderr);
    const session = JSON.parse(started.stdout) as { id: string; project: string; plan: Array<{ id: string }> };
    sessionIds[project] = session.id;
    assert.equal(session.project, `e2e-${project}`);
    assert.deepEqual(session.plan.map((item) => item.id), ['synthetic']);
    const configured = await system.run(project, [
      'onboard', 'configure', session.id, '--service', 'synthetic', '--input-json',
      JSON.stringify({ accountId: `account-${project}` }), '--json',
    ]);
    assert.equal(configured.code, 0, configured.stderr);
    if (project === 'alpha') {
      const rejected = await system.runInteractive(project, ['onboard', 'authorize', session.id], 'account:wrong:SYNTHETIC-REJECTED-CANARY');
      assert.equal(rejected.code, 31, rejected.stderr);
      assert.equal(`${rejected.stdout}${rejected.stderr}`.includes('SYNTHETIC-REJECTED-CANARY'), false);
      const authorized = await system.runInteractive(project, ['onboard', 'authorize', session.id], system.tokens[project]);
      assert.equal(authorized.code, 0, authorized.stderr);
      assert.match(authorized.stdout, /1 of 1 services connected/);
      assert.match(authorized.stdout, /onboard finish/);
      assert.equal(`${authorized.stdout}${authorized.stderr}`.includes(system.tokens[project]), false);
    } else {
      // Simulate interruption after the credential is durably enrolled but before
      // the onboarding session records provider verification.
      const enrolled = await system.run(project, ['enroll', `e2e-${project}`, '--service', 'synthetic'], `${system.tokens[project]}\n`);
      assert.equal(enrolled.code, 0, enrolled.stderr);
      assert.equal(enrolled.stdout.includes(system.tokens[project]), false);
    }
    const status = await system.run(project, ['status', '--json']);
    assert.equal(status.code, 0, status.stderr);
    const statusResult = JSON.parse(status.stdout);
    assert.equal(statusResult.project, `e2e-${project}`);
    assert.match(JSON.stringify(statusResult), new RegExp(`account-${project}`));
    if (project === 'alpha') {
      const resumed = await system.run(project, ['onboard', 'resume', session.id, '--json']);
      assert.equal(resumed.code, 0, resumed.stderr);
      assert.equal(JSON.parse(resumed.stdout).services.synthetic.profile, `e2e-${project}-synthetic-admin`);
    }
    const finished = await system.run(project, ['onboard', 'finish', session.id, '--json']);
    assert.equal(finished.code, 0, finished.stderr);
    const completion = JSON.parse(finished.stdout);
    assert.equal(completion.complete, true);
    assert.match(completion.agentInstructions, /inframux/);
    const repeated = await system.run(project, ['onboard', 'finish', session.id, '--json']);
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.deepEqual(JSON.parse(repeated.stdout), completion);
  }

  const access = await system.run('alpha', ['trust', 'prepare-checkout', sessionIds.alpha!, '--json']);
  assert.equal(access.code, 0, access.stderr);
  const accessResult = JSON.parse(access.stdout);
  assert.equal(accessResult.schema, 1);
  assert.equal(accessResult.ready, true);
  assert.equal(accessResult.principal, '_inframux');
  assert.deepEqual(accessResult.ancestors, []);
  assert.equal(accessResult.repositoryRoot, system.repositories.alpha);
  assert.equal(accessResult.state, 'healthy');
  assert.equal(accessResult.complete, true);
  assert.deepEqual(accessResult.nextActions, []);

  await system.restart();
  for (const project of ['alpha', 'beta'] as const) {
    const persisted = await system.run(project, ['status', '--json']);
    assert.equal(persisted.code, 0, persisted.stderr);
    assert.match(persisted.stdout, new RegExp(`account-${project}`));
  }

  const [alphaResources, betaResources] = await Promise.all([
    system.run('alpha', ['run', 'synthetic', '--', 'resources', '--json']),
    system.run('beta', ['call', 'synthetic', 'resources.list', '--input-json', '{}', '--json']),
  ]);
  assert.equal(alphaResources.code, 0, alphaResources.stderr);
  assert.equal(betaResources.code, 0, betaResources.stderr);
  assert.match(alphaResources.stdout, /alpha/);
  assert.match(betaResources.stdout, /beta/);

  const environmentProbe = await system.run('alpha', ['run', 'synthetic', '--', 'echo', 'print-secret', '--json']);
  assert.equal(environmentProbe.code, 0, environmentProbe.stderr);
  assert.equal(environmentProbe.stdout.includes('MUST-NOT-REACH-WORKER'), false);
  assert.equal(environmentProbe.stdout.includes('INFRAMUX_AMBIENT_CANARY'), false);
  assert.equal(environmentProbe.stdout.includes(system.tokens.alpha), false);
  assert.match(environmentProbe.stdout, /\[REDACTED\]/);

  const mcp = await system.run('alpha', ['launch', 'mcp', 'synthetic'], '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
  assert.equal(mcp.code, 0, mcp.stderr);
  assert.match(mcp.stdout, /"method":"initialize"/);

  const browser = await system.run('alpha', ['browser', 'mcp', 'persistent', '--provider', 'synthetic']);
  assert.equal(browser.code, 0, browser.stderr);
  const browserEvidence = JSON.parse(await readFile(
    path.join(system.browserStateRoot, '.artifacts/e2e-alpha/synthetic/browser-ran.json'), 'utf8',
  )) as { cwd: string; args: string[] };
  assert.equal(browserEvidence.cwd, system.repositories.alpha);
  assert.ok(browserEvidence.args.includes(path.join(system.browserStateRoot, 'e2e-alpha/synthetic')));
  const cleanBrowser = await system.run('alpha', ['browser', 'mcp', 'clean']);
  assert.equal(cleanBrowser.code, 0, cleanBrowser.stderr);
  assert.deepEqual(await readdir(system.browserTasksRoot), []);

  const wrong = await system.run('alpha', ['enroll', 'e2e-alpha', '--service', 'synthetic'], 'account:wrong:SYNTHETIC-WRONG-CANARY\n');
  assert.equal(wrong.code, 31);
  const stillAlpha = await system.run('alpha', ['run', 'synthetic', '--', 'identity', '--json']);
  assert.match(stillAlpha.stdout, /account-alpha/);

  const rotatedToken = 'account:account-alpha:SYNTHETIC-E2E-ALPHA-ROTATED-CANARY';
  const rotated = await system.run('alpha', ['replace-token', 'synthetic', '--json'], `${rotatedToken}\n`);
  assert.equal(rotated.code, 0, rotated.stderr);
  assert.equal(rotated.stdout.includes(rotatedToken), false);
  const revoked = await system.run('alpha', ['auth', 'revoke', '--project', 'e2e-alpha', '--service', 'synthetic', '--json']);
  assert.equal(revoked.code, 0, revoked.stderr);
  const missingAfterRevoke = await system.run('alpha', ['call', 'synthetic', 'resources.list', '--input-json', '{}', '--json']);
  assert.equal(missingAfterRevoke.code, 30, missingAfterRevoke.stderr);
  assert.equal(missingAfterRevoke.stderr, '');
  assert.equal(JSON.parse(missingAfterRevoke.stdout).error.code, 'CREDENTIAL_MISSING');
  const betaAfterAlphaRevoke = await system.run('beta', ['call', 'synthetic', 'resources.list', '--input-json', '{}', '--json']);
  assert.equal(betaAfterAlphaRevoke.code, 0, betaAfterAlphaRevoke.stderr);

  const copied = path.join(system.root, 'copied-alpha');
  await cp(system.repositories.alpha, copied, { recursive: true });
  const copiedResult = await system.runAt(copied, ['status', '--json']);
  assert.equal(copiedResult.code, 12, copiedResult.stderr);
  assert.equal(copiedResult.stderr, '');
  assert.equal(JSON.parse(copiedResult.stdout).error.code, 'CHECKOUT_NOT_APPROVED');

  const audit = await system.run('alpha', ['audit', 'verify', '--json']);
  assert.equal(audit.code, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).valid, true);

  const forbidden = [system.tokens.alpha, system.tokens.beta, rotatedToken, 'MUST-NOT-REACH-WORKER'];
  const persistedNonVault = [system.serviceOutput(), audit.stdout, await readFile(path.join(system.repositories.alpha, 'README.md'), 'utf8')].join('\n');
  for (const canary of forbidden) assert.equal(persistedNonVault.includes(canary), false);
  const clientSocket = await lstat(system.environment.INFRAMUX_CLIENT_SOCKET!);
  assert.equal(clientSocket.isSocket(), true);

  const cancelled = system.spawn('beta', ['run', 'synthetic', '--', 'sleep', '5000']);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(cancelled.exitCode, null, 'synthetic sleep exited before cancellation');
  assert.equal(cancelled.signalCode, null, 'synthetic sleep was signalled before cancellation');
  const cancelledExit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    cancelled.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(cancelled.kill('SIGTERM'), true);
  const exitResult = await Promise.race([
    cancelledExit,
    new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 2_000)),
  ]);
  if (exitResult === 'timeout') {
    cancelled.kill('SIGKILL');
    await cancelledExit;
    assert.fail('synthetic CLI ignored SIGTERM for 2 seconds');
  }
  assert.equal(exitResult.signal, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const entries = await readdir(path.join(system.root, 'worker/tmp')).catch(() => ['pending']);
    if (entries.length === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.deepEqual(await readdir(path.join(system.root, 'worker/tmp')), []);
});
