import path from 'node:path';

export interface LaunchdInputs {
  readonly installRoot: string;
  readonly nodeExecutable: string;
  readonly brokerEntry: string;
  readonly workerEntry: string;
  readonly brokerUser: string;
  readonly workerUser: string;
  readonly group: string;
  readonly callerUid: number;
  readonly executableManifest: string;
  readonly clientUsername: string;
}

export function renderLaunchdPlists(input: LaunchdInputs): { readonly broker: string; readonly worker: string } {
  if (!Number.isSafeInteger(input.callerUid) || input.callerUid < 0) throw new Error('launchd callerUid must be a non-negative integer');
  for (const [name, value] of Object.entries(input)) {
    if ((name.endsWith('Root') || name.endsWith('Executable') || name.endsWith('Entry') || name.endsWith('Manifest')) && typeof value === 'string' && !path.isAbsolute(value)) {
      throw new Error(`launchd ${name} must be absolute`);
    }
    if (typeof value === 'string' && /\0|[\r\n]/u.test(value)) throw new Error(`Unsafe launchd value: ${name}`);
  }
  return Object.freeze({
    broker: plist('broker', input.brokerUser, input.group, input.nodeExecutable, input.brokerEntry, input.installRoot, {
      INFRAMUX_STATE_ROOT: path.join(input.installRoot, 'state'),
      INFRAMUX_FINGERPRINT_KEY: path.join(input.installRoot, 'state/keys/fingerprint.key'),
      INFRAMUX_AUDIT_KEY: path.join(input.installRoot, 'state/keys/audit.key'),
      INFRAMUX_SECURITY_MODE: 'hardened',
      INFRAMUX_CLIENT_SOCKET: path.join(input.installRoot, 'run/client.sock'),
      INFRAMUX_WORKER_SOCKET: path.join(input.installRoot, 'run/worker.sock'),
      INFRAMUX_CALLER_UID: String(input.callerUid),
      INFRAMUX_CLIENT_USERNAME: input.clientUsername,
      INFRAMUX_RUNTIME_MANIFEST: path.join(input.installRoot, 'current/package.json'),
      INFRAMUX_DIAGNOSTIC_ROOT: path.join(input.installRoot, 'logs/broker'),
    }),
    worker: plist('worker', input.workerUser, input.group, input.nodeExecutable, input.workerEntry, input.installRoot, {
      INFRAMUX_SECURITY_MODE: 'hardened',
      INFRAMUX_WORKER_SOCKET: path.join(input.installRoot, 'run/worker.sock'),
      INFRAMUX_WORKER_ROOT: path.join(input.installRoot, 'worker'),
      INFRAMUX_TOOL_ROOT: path.join(input.installRoot, 'current/tools'),
      INFRAMUX_EXECUTABLE_MANIFEST: input.executableManifest,
      INFRAMUX_DIAGNOSTIC_ROOT: path.join(input.installRoot, 'logs/worker'),
    }),
  });
}

function plist(
  kind: 'broker' | 'worker',
  user: string,
  group: string,
  node: string,
  entry: string,
  root: string,
  environment: Readonly<Record<string, string>>,
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.inframux.${kind}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array>
  <key>UserName</key><string>${xml(user)}</string>
  <key>GroupName</key><string>${xml(group)}</string>
  <key>WorkingDirectory</key><string>${xml(path.join(root, kind === 'broker' ? 'state' : 'worker'))}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(environment).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>Umask</key><integer>63</integer>
  <key>HardResourceLimits</key><dict><key>NumberOfFiles</key><integer>1024</integer><key>NumberOfProcesses</key><integer>128</integer></dict>
</dict></plist>
`;
}

function xml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
