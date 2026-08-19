export type FileVaultStatus = 'ready' | 'encrypting' | 'disabled' | 'unknown';

export function parseFileVaultStatus(output: string): FileVaultStatus {
  if (/FileVault is On\./i.test(output)) return 'ready';
  if (/Encryption in progress|Encrypting/i.test(output)) return 'encrypting';
  if (/FileVault is Off\./i.test(output)) return 'disabled';
  return 'unknown';
}

export function assertFileVaultReady(status: FileVaultStatus): void {
  if (status !== 'ready' && status !== 'encrypting') {
    throw new Error('Hardened inframux installation requires FileVault to be enabled or actively encrypting');
  }
}
