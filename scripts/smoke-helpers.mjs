import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';

const OUTPUT_LIMIT = 8 * 1024 * 1024;

export function parseJson(source) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Expected JSON subprocess output: ${error instanceof Error ? error.message : 'parse failed'}`);
  }
}

export async function run(executable, args, cwd, env, timeout = 120_000) {
  const child = spawn(executable, args, {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= OUTPUT_LIMIT) stdout.push(Buffer.from(chunk));
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= OUTPUT_LIMIT) stderr.push(Buffer.from(chunk));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timer));
  const stderrText = Buffer.concat(stderr).toString('utf8');
  if (result.code !== 0 || stdoutBytes > OUTPUT_LIMIT || stderrBytes > OUTPUT_LIMIT) {
    throw new Error(`Subprocess failed (${result.signal ?? result.code ?? 'unknown'}): ${stderrText.slice(0, 4_096)}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}

export function spawnService(node, entry, cwd, env) {
  const child = spawn(node, [entry], {
    cwd,
    env,
    shell: false,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderr = [];
  let bytes = 0;
  child.stderr.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes <= 64 * 1024) stderr.push(Buffer.from(chunk));
  });
  return { child, stderrText: () => Buffer.concat(stderr).toString('utf8') };
}

export async function waitForSocket(filename, service, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null || service.child.signalCode !== null) {
      throw new Error(`Installed service exited before socket creation: ${service.stderrText()}`);
    }
    try {
      if ((await lstat(filename)).isSocket()) return;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    await delay(25);
  }
  throw new Error(`Installed service did not create ${filename}`);
}

export async function terminateService(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const graceful = await Promise.race([exited.then(() => true), delay(1_000).then(() => false)]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}

export function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
