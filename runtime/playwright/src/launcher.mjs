#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { lstat, mkdir, readlink, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensurePrivateDirectory, resolveWorkspace } from './paths.mjs';

export const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const RELEASE_ROOT = path.resolve(RUNTIME_ROOT, '../..');
export const RUNTIME_STATE_ROOT = path.resolve(
  process.env.INFRAMUX_PLAYWRIGHT_STATE_ROOT || path.join(os.homedir(), '.config', 'inframux', 'playwright'),
);

const HELP = `agent-playwright <command> [arguments]

Commands:
  doctor                 verify versions, paths, Chrome, and Chromium
  cli [args]             run the official agent-oriented Playwright CLI
  mcp [args]             run the official Playwright MCP server over stdio
  test [args]            run Playwright Test from the current repository
  codegen [args]         run Playwright codegen
  show-trace [args]      open a Playwright trace
  run <script.mjs>       run a workspace script with the central API
  link [repository]      link central packages into local node_modules
  unlink [repository]    remove links created by this launcher
  update                 print the reviewed package-managed upgrade procedure
`;

export function parseCommand(argv) {
  if (argv.length === 0) return { command: 'help', args: [] };
  return { command: argv[0], args: argv.slice(1) };
}

export function buildDispatch(command, args, context, { dependencyRoot = RELEASE_ROOT, stateRoot = RUNTIME_STATE_ROOT } = {}) {
  const bin = (name) => path.join(dependencyRoot, 'node_modules', '.bin', name);
  const shared = {
    cwd: context.root,
    env: centralEnvironment(process.env, { stateRoot }),
    shell: false,
  };

  switch (command) {
    case 'mcp': {
      const prefix = [];
      if (!hasOption(args, '--browser')) prefix.push('--browser', 'chrome');
      if (!hasOption(args, '--user-data-dir') && !args.includes('--isolated')) {
        prefix.push('--user-data-dir', context.profileDir);
      }
      if (!hasOption(args, '--output-dir')) prefix.push('--output-dir', context.artifactDir);
      if (!hasOption(args, '--output-max-size')) prefix.push('--output-max-size', '104857600');
      if (!hasOption(args, '--codegen')) prefix.push('--codegen', 'typescript');
      return { executable: bin('playwright-mcp'), args: [...prefix, ...args], ...shared };
    }
    case 'cli': {
      const cliArgs = [...args];
      const env = { ...shared.env };
      if (!hasOption(args, '--session') && !args.some((arg) => arg.startsWith('-s='))) {
        env.PLAYWRIGHT_CLI_SESSION = `repo-${context.hash}`;
      }
      if (!hasOption(args, '--browser') && args[0] === 'open') {
        cliArgs.push('--browser=chrome');
      }
      return { executable: bin('playwright-cli'), args: cliArgs, ...shared, env };
    }
    case 'test':
      return { executable: bin('playwright'), args: ['test', ...args], ...shared };
    case 'codegen':
      return { executable: bin('playwright'), args: ['codegen', ...args], ...shared };
    case 'show-trace':
      return { executable: bin('playwright'), args: ['show-trace', ...args], ...shared };
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

export function buildManagedMcpArgs(profileDir, artifactDir, extraArgs = []) {
  if (!path.isAbsolute(profileDir) || !path.isAbsolute(artifactDir)) {
    throw new Error('Managed MCP profile and artifact paths must be absolute');
  }
  const blocked = ['--user-data-dir', '--output-dir', '--isolated'];
  for (const argument of extraArgs) {
    if (blocked.some((option) => argument === option || argument.startsWith(`${option}=`))) {
      throw new Error(`Managed MCP argument cannot override ${argument}`);
    }
  }
  return ['--user-data-dir', profileDir, '--output-dir', artifactDir, ...extraArgs];
}

async function main() {
  const { command, args } = parseCommand(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') {
    process.stdout.write(HELP);
    return;
  }

  const requestedWorkspace = command === 'link' || command === 'unlink' ? args[0] : process.cwd();
  const context = await resolveWorkspace(requestedWorkspace || process.cwd(), { stateRoot: RUNTIME_STATE_ROOT });
  await ensurePrivateDirectory(context.profileDir);
  await ensurePrivateDirectory(context.artifactDir);

  if (command === 'doctor') {
    const result = doctor(context);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (command === 'run') {
    if (!args[0]) throw new Error('run requires a workspace script path');
    Object.assign(process.env, centralEnvironment(process.env, { stateRoot: RUNTIME_STATE_ROOT }));
    const { runApiScript } = await import('./api-runner.mjs');
    await runApiScript(args[0], args.slice(1), context);
    return;
  }
  if (command === 'link') {
    await linkPackages(context.root);
    return;
  }
  if (command === 'unlink') {
    await unlinkPackages(context.root);
    return;
  }
  if (command === 'update') {
    process.stdout.write(runtimeUpdateInstructions());
    return;
  }

  const dispatch = buildDispatch(command, args, context);
  const child = spawn(dispatch.executable, dispatch.args, {
    cwd: dispatch.cwd,
    env: dispatch.env,
    stdio: 'inherit',
    shell: dispatch.shell,
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
}

export function centralEnvironment(baseEnvironment, { stateRoot = RUNTIME_STATE_ROOT } = {}) {
  const environment = {
    ...baseEnvironment,
    PLAYWRIGHT_BROWSERS_PATH: path.join(stateRoot, 'browsers'),
    PWTEST_DAEMON_SESSION_DIR: path.join(stateRoot, 'cli-daemon'),
  };
  delete environment.FORCE_COLOR;
  delete environment.NO_COLOR;
  return environment;
}

export function doctor(context, { dependencyRoot = RELEASE_ROOT, stateRoot = RUNTIME_STATE_ROOT } = {}) {
  const commands = {
    test: path.join(dependencyRoot, 'node_modules/.bin/playwright'),
    cli: path.join(dependencyRoot, 'node_modules/.bin/playwright-cli'),
    mcp: path.join(dependencyRoot, 'node_modules/.bin/playwright-mcp'),
  };
  const browserRoot = path.join(stateRoot, 'browsers');
  const checks = Object.fromEntries(Object.entries(commands).map(([name, executable]) => {
    const result = spawnSync(executable, name === 'mcp' ? ['--help'] : ['--version'], {
      cwd: context.root,
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
      encoding: 'utf8',
      timeout: 15000,
    });
    return [name, {
      executable,
      ok: result.status === 0,
      version: (result.stdout || result.stderr || '').trim().split('\n')[0],
      error: result.error?.message,
    }];
  }));
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  let chromeAvailable = false;
  try {
    accessSync(chrome, fsConstants.X_OK);
    chromeAvailable = true;
  } catch {
    chromeAvailable = false;
  }
  const browserList = spawnSync(commands.test, ['install', '--list'], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browserRoot },
    encoding: 'utf8',
  });

  return {
    ok: Object.values(checks).every((check) => check.ok) && chromeAvailable,
    node: process.version,
    runtimeRoot: RUNTIME_ROOT,
    dependencyRoot,
    stateRoot,
    workspace: context,
    chrome: { path: chrome, ok: chromeAvailable },
    browsers: (browserList.stdout || browserList.stderr || '').trim(),
    commands: checks,
  };
}

async function linkPackages(repository) {
  const links = [
    ['playwright', path.join(RELEASE_ROOT, 'node_modules/playwright')],
    ['playwright-core', path.join(RELEASE_ROOT, 'node_modules/playwright/node_modules/playwright-core')],
    ['@playwright/test', path.join(RELEASE_ROOT, 'node_modules/@playwright/test')],
  ];

  for (const [name, target] of links) {
    const destination = path.join(repository, 'node_modules', ...name.split('/'));
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      const stat = await lstat(destination);
      if (!stat.isSymbolicLink()) throw new Error(`Refusing to replace non-symlink: ${destination}`);
      const current = path.resolve(path.dirname(destination), await readlink(destination));
      if (current !== target) throw new Error(`Refusing to replace foreign symlink: ${destination}`);
      continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await symlink(target, destination);
  }
}

async function unlinkPackages(repository) {
  for (const name of ['playwright', 'playwright-core', '@playwright/test']) {
    const destination = path.join(repository, 'node_modules', ...name.split('/'));
    try {
      const stat = await lstat(destination);
      if (!stat.isSymbolicLink()) continue;
      const target = path.resolve(path.dirname(destination), await readlink(destination));
      if (target.startsWith(`${RELEASE_ROOT}${path.sep}`)) await rm(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export function runtimeUpdateInstructions() {
  return 'Upgrade with: npm install --global inframux@<reviewed-version>\nThen apply the reviewed release with: inframux bootstrap --apply\n';
}

function hasOption(args, option) {
  return args.includes(option) || args.some((arg) => arg.startsWith(`${option}=`));
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
