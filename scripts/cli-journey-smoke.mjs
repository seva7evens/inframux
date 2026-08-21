#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const executable = process.argv[2];
assert.ok(executable, 'Usage: node scripts/cli-journey-smoke.mjs <inframux-executable>');

const cwd = process.cwd();
const environment = Object.freeze({
  ...process.env,
  INFRAMUX_FILEVAULT_STATUS: 'ready',
  LANG: 'C',
  LC_ALL: 'C',
  NO_COLOR: '1',
});

const rootHelp = run(['--help']);
assert.match(rootHelp, /inframux/i, 'root help must identify inframux');
assert.match(rootHelp, /onboard/i, 'root help must make onboarding discoverable');

const nestedHelp = run(['onboard', 'authorize', '--help']);
assert.match(nestedHelp, /onboard authorize/i, 'nested help must identify the selected command');

const onboardingPrompt = run(['prompt', 'onboarding']);
assert.match(onboardingPrompt, /Services: <ENTER COMMA-SEPARATED SERVICES>/, 'onboarding prompt must expose its only placeholder');
assert.match(onboardingPrompt, /onboard start/i, 'onboarding prompt must describe the first command');

const bootstrapHuman = run(['bootstrap']);
assert.match(bootstrapHuman, /bootstrap/i, 'bootstrap preview must explain the current journey');
assert.match(bootstrapHuman, /inframux bootstrap --apply/, 'bootstrap preview must provide the exact next action');

const bootstrapMachine = runJson(['bootstrap', '--json']);
assert.equal(bootstrapMachine.schema, 1, 'bootstrap JSON must use schema 1');
assert.equal(bootstrapMachine.state, 'planned', 'bootstrap preview must remain incomplete until applied');
assert.equal(typeof bootstrapMachine.complete, 'boolean', 'bootstrap JSON must expose completion');
assert.ok(Array.isArray(bootstrapMachine.nextActions), 'bootstrap JSON must expose next actions');

process.stdout.write('CLI journey smoke passed\n');

function run(args) {
  const result = spawnSync(path.resolve(executable), args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    shell: false,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(' ')} failed:\n${result.stderr}`);
  assert.equal(result.stderr.includes('SYNTHETIC-'), false, `${args.join(' ')} leaked a credential canary`);
  assert.equal(result.stdout.includes('SYNTHETIC-'), false, `${args.join(' ')} leaked a credential canary`);
  return result.stdout;
}

function runJson(args) {
  const output = run(args);
  try {
    const parsed = JSON.parse(output);
    assert.equal(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), true, `${args.join(' ')} must emit one JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    throw new Error(`${args.join(' ')} emitted invalid JSON`, { cause: error });
  }
}
