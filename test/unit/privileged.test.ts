import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runPrivilegedHelper } from '../../src/cli/privileged.js';

test('authenticates first, animates during work, and clears before helper output', async (t) => {
  const fixture = await createFakeSudo(t, `
if [ "$1" = "-v" ]; then exit 0; fi
/bin/sleep 0.08
printf '{"schema":1,"mode":"hardened"}\n'
`);
  const terminal = captureStream(true);

  await runPrivilegedHelper('/sealed/node', '/sealed/manage.js', 'bootstrap', '/private/request.json', {
    sudoExecutable: fixture.executable,
    stdin: 'ignore', stdout: terminal.stream, stderr: terminal.stream,
    environment: { TERM: 'xterm-256color' }, spinnerIntervalMs: 10,
  });

  assert.deepEqual((await readFile(fixture.log, 'utf8')).trim().split('\n'), [
    '-v',
    '-n /sealed/node /sealed/manage.js bootstrap /private/request.json',
  ]);
  assert.match(terminal.text(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Installing inframux and starting services…/u);
  const clear = terminal.text().lastIndexOf('\r\u001b[2K');
  const result = terminal.text().indexOf('{"schema":1');
  assert.ok(clear >= 0 && result > clear, 'spinner must clear before helper output');
  assert.equal(terminal.text().slice(result), '{"schema":1,"mode":"hardened"}\n');
});

test('does not animate machine output when stderr is not a TTY', async (t) => {
  const fixture = await createFakeSudo(t, `
if [ "$1" = "-v" ]; then exit 0; fi
printf '{"ok":true}\n'
`);
  const output = captureStream(false);

  await runPrivilegedHelper('/sealed/node', '/sealed/manage.js', 'bootstrap', '/private/request.json', {
    sudoExecutable: fixture.executable,
    stdin: 'ignore', stdout: output.stream, stderr: output.stream,
    environment: { TERM: 'xterm-256color' }, spinnerIntervalMs: 10,
  });

  assert.equal(output.text(), '{"ok":true}\n');
});

test('does not animate when stdout is piped even if stderr is a TTY', async (t) => {
  const fixture = await createFakeSudo(t, `
if [ "$1" = "-v" ]; then exit 0; fi
printf '{"ok":true}\n'
`);
  const stdout = captureStream(false);
  const stderr = captureStream(true);

  await runPrivilegedHelper('/sealed/node', '/sealed/manage.js', 'bootstrap', '/private/request.json', {
    sudoExecutable: fixture.executable,
    stdin: 'ignore', stdout: stdout.stream, stderr: stderr.stream,
    environment: { TERM: 'xterm-256color' }, spinnerIntervalMs: 10,
  });

  assert.equal(stdout.text(), '{"ok":true}\n');
  assert.equal(stderr.text(), '');
});

test('clears an active spinner when the privileged helper fails silently', async (t) => {
  const fixture = await createFakeSudo(t, `
if [ "$1" = "-v" ]; then exit 0; fi
/bin/sleep 0.05
exit 42
`);
  const terminal = captureStream(true);

  await assert.rejects(runPrivilegedHelper('/sealed/node', '/sealed/manage.js', 'uninstall', '/private/request.json', {
    sudoExecutable: fixture.executable,
    stdin: 'ignore', stdout: terminal.stream, stderr: terminal.stream,
    environment: { TERM: 'xterm-256color' }, spinnerIntervalMs: 10,
  }), /failed.*42/i);

  assert.match(terminal.text(), /Removing inframux services…/u);
  assert.equal(terminal.text().endsWith('\r\u001b[2K'), true);
});

async function createFakeSudo(t: test.TestContext, body: string): Promise<{ executable: string; log: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'inframux-fake-sudo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'sudo');
  const log = path.join(root, 'argv.log');
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellQuote(log)}\n${body}`, { mode: 0o700 });
  await chmod(executable, 0o700);
  return { executable, log };
}

function captureStream(isTTY: boolean): { stream: PassThrough & { isTTY: boolean }; text(): string } {
  const stream = new PassThrough() as PassThrough & { isTTY: boolean };
  stream.isTTY = isTTY;
  let contents = '';
  stream.on('data', (chunk: Buffer) => { contents += chunk.toString('utf8'); });
  return { stream, text: () => contents };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
