import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const smokeScript = path.resolve('scripts/cli-journey-smoke.mjs');

test('accepts a CLI with complete human and machine journey output', async (t) => {
  const fixture = await createFixture(false);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [smokeScript, fixture.executable], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CLI journey smoke passed/);
});

test('rejects a CLI that emits malformed JSON in machine mode', async (t) => {
  const fixture = await createFixture(true);
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [smokeScript, fixture.executable], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C' },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /bootstrap --json emitted invalid JSON/);
});

async function createFixture(malformedJson: boolean): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-journey-smoke-test-'));
  const executable = path.join(root, 'fake-inframux');
  const bootstrapOutput = malformedJson
    ? "process.stdout.write('{broken\\n')"
    : "process.stdout.write(JSON.stringify({schema:1,mode:'hardened',state:'planned',complete:false,nextActions:[{type:'bootstrap.apply',actor:'user',command:'inframux bootstrap --apply',description:'Install inframux',interactive:true,privileged:true}]})+'\\n')";
  await writeFile(executable, `#!${process.execPath}
const args = process.argv.slice(2).join(' ');
if (args === '--help') process.stdout.write('inframux — repository-bound infrastructure access\\nStart a project: inframux onboard start\\n');
else if (args === 'onboard authorize --help') process.stdout.write('Usage: inframux onboard authorize <session>\\n');
else if (args === 'prompt onboarding') process.stdout.write('Services: <ENTER COMMA-SEPARATED SERVICES>\\nThen run inframux onboard start.\\n');
else if (args === 'bootstrap --json') ${bootstrapOutput};
else if (args === 'bootstrap') process.stdout.write('Bootstrap needs confirmation.\\nNext: inframux bootstrap --apply\\n');
else { process.stderr.write('unexpected command: '+args+'\\n'); process.exitCode = 64; }
`, { mode: 0o755 });
  await chmod(executable, 0o755);
  return { root, executable };
}
