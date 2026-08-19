import { spawn } from 'node:child_process';

type Operation = 'bootstrap' | 'rollback' | 'uninstall';
type TerminalStream = NodeJS.WritableStream & { readonly isTTY?: boolean };

export interface PrivilegedHelperOptions {
  readonly sudoExecutable?: string;
  readonly stdin?: 'inherit' | 'ignore';
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: TerminalStream;
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  readonly spinnerIntervalMs?: number;
}

const FRAMES = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
const CLEAR_LINE = '\r\u001b[2K';
const SAFE_ENV = Object.freeze({ PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' });

export async function runPrivilegedHelper(
  node: string,
  helper: string,
  operation: Operation,
  requestFile: string,
  options: PrivilegedHelperOptions = {},
): Promise<void> {
  const sudo = options.sudoExecutable ?? '/usr/bin/sudo';
  const stdin = options.stdin ?? 'inherit';
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;

  const authorization = spawn(sudo, ['-v'], {
    cwd: '/', env: { ...SAFE_ENV }, shell: false, stdio: [stdin, 'inherit', 'inherit'],
  });
  await waitForChild(authorization, 'Privilege authorization');

  const stopSpinner = startSpinner(stderr, messageFor(operation), {
    enabled: stderr.isTTY === true && (stdout as TerminalStream).isTTY === true
      && environment.CI !== 'true' && environment.CI !== '1' && environment.TERM !== 'dumb',
    intervalMs: options.spinnerIntervalMs ?? 100,
  });
  try {
    const child = spawn(sudo, ['-n', node, helper, operation, requestFile], {
      cwd: '/', env: { ...SAFE_ENV }, shell: false, stdio: [stdin, 'pipe', 'pipe'],
    });
    if (child.stdout === null || child.stderr === null) throw new Error('Privileged helper output pipes are unavailable');
    child.stdout.once('data', stopSpinner);
    child.stderr.once('data', stopSpinner);
    child.stdout.pipe(stdout, { end: false });
    child.stderr.pipe(stderr, { end: false });
    await waitForChild(child, 'Privileged management helper');
  } finally {
    stopSpinner();
  }
}

function startSpinner(
  stream: TerminalStream,
  message: string,
  options: { readonly enabled: boolean; readonly intervalMs: number },
): () => void {
  if (!options.enabled) return () => undefined;
  if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 5 || options.intervalMs > 1_000) {
    throw new Error('Spinner interval must be 5 to 1000 milliseconds');
  }
  let frame = 0;
  let active = true;
  const render = () => {
    stream.write(`${CLEAR_LINE}${FRAMES[frame % FRAMES.length]} ${message}`);
    frame += 1;
  };
  const stop = () => {
    if (!active) return;
    active = false;
    clearInterval(timer);
    process.off('exit', stop);
    stream.write(CLEAR_LINE);
  };
  render();
  const timer = setInterval(render, options.intervalMs);
  timer.unref();
  process.once('exit', stop);
  return stop;
}

function messageFor(operation: Operation): string {
  if (operation === 'bootstrap') return 'Installing inframux and starting services…';
  if (operation === 'rollback') return 'Rolling back inframux and restarting services…';
  return 'Removing inframux services…';
}

async function waitForChild(
  child: ReturnType<typeof spawn>,
  label: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (error === undefined) resolve();
      else reject(error);
    };
    child.once('error', (error) => finish(error));
    child.once('close', (code, signal) => {
      if (code === 0) finish();
      else finish(new Error(`${label} failed (${signal ?? code ?? 'unknown'})`));
    });
  });
}
