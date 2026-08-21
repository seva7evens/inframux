#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assertRuntimeVersion } from '../core/version.js';
import { MacOsManagementSystem } from '../install/macos-system.js';
import {
  applyHardenedBootstrap,
  applyHardenedRollback,
  applyHardenedUninstall,
  applyCheckoutAccess,
  readCheckoutAccessRequest,
  readMaintenanceRequest,
  readManagementRequest,
} from '../install/management.js';

export async function managementMain(
  argv: readonly string[] = process.argv.slice(2),
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<void> {
  assertRuntimeVersion();
  if (process.platform !== 'darwin') throw new Error('The hardened management helper supports macOS only');
  if (process.getuid?.() !== 0) throw new Error('The hardened management helper must run as root via sudo');
  if (argv.length !== 2 || !['bootstrap', 'rollback', 'uninstall', 'checkout-access'].includes(argv[0] ?? '') || !argv[1]?.startsWith('/')) {
    throw new Error('Usage: inframux-manage bootstrap|rollback|uninstall|checkout-access /absolute/private-request.json');
  }
  const requestFile = await realpath(argv[1]);
  const request = argv[0] === 'bootstrap'
    ? await readManagementRequest(requestFile)
    : argv[0] === 'checkout-access'
      ? await readCheckoutAccessRequest(requestFile)
      : await readMaintenanceRequest(requestFile);
  if (request.targetRoot !== '/Library/Application Support/inframux') {
    throw new Error('Production management helper refuses a non-standard hardened install root');
  }
  const sudoUid = Number.parseInt(environment.SUDO_UID ?? '', 10);
  const sudoGid = Number.parseInt(environment.SUDO_GID ?? '', 10);
  const sudoUser = environment.SUDO_USER;
  if (sudoUid !== request.caller.uid || sudoGid !== request.caller.gid || sudoUser !== request.caller.username) {
    throw new Error('Management request caller does not match the authenticated sudo identity');
  }
  const system = new MacOsManagementSystem();
  const result = request.operation === 'bootstrap'
    ? await applyHardenedBootstrap(request, system)
    : request.operation === 'checkout-access'
      ? await applyCheckoutAccess(request, system)
    : request.operation === 'rollback'
      ? await applyHardenedRollback(request, system)
      : await applyHardenedUninstall(request, system);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] !== undefined && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])) {
  managementMain().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'inframux management failed'}\n`);
    process.exitCode = 1;
  });
}
