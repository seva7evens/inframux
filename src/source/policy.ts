export interface SourceSnapshotPolicy {
  readonly includeUntracked: boolean;
  readonly ignorePatterns: readonly string[];
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly secretCanaries: readonly string[];
}

export const DEFAULT_SOURCE_POLICY: SourceSnapshotPolicy = Object.freeze({
  includeUntracked: true,
  ignorePatterns: Object.freeze([]),
  maxFiles: 5_000,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  secretCanaries: Object.freeze([]),
});

const FORBIDDEN_SEGMENTS = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'target', 'coverage',
  '.cache', '.mypy_cache', '.pytest_cache', '__pycache__', '.tox', '.venv',
  'browser-state', 'browser-tasks', '.inframux-state',
]);

export function isMandatorySourceExclusion(relativePath: string): boolean {
  const segments = relativePath.split('/');
  if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) return true;
  const basename = segments.at(-1) ?? '';
  if (basename === '.env' || basename.startsWith('.env.')) return true;
  if (/\.(?:pem|key|p12|pfx)$/i.test(basename)) return true;
  return false;
}

export function validateSnapshotPolicy(policy: SourceSnapshotPolicy): void {
  for (const [name, value] of Object.entries({
    maxFiles: policy.maxFiles,
    maxFileBytes: policy.maxFileBytes,
    maxTotalBytes: policy.maxTotalBytes,
  })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid source snapshot ${name}`);
  }
  for (const pattern of policy.ignorePatterns) validateIgnorePattern(pattern);
  for (const canary of policy.secretCanaries) {
    if (canary.length < 8 || Buffer.byteLength(canary) > 16 * 1024) throw new Error('Invalid source snapshot secret canary');
  }
}

export function validateIgnorePattern(pattern: string): void {
  if (pattern.length === 0 || pattern.length > 512 || pattern.includes('\0') || pattern.startsWith('/') || pattern.startsWith('!')) {
    throw new Error(`Unsafe .inframuxignore pattern: ${pattern}`);
  }
  if (pattern.split('/').includes('..')) throw new Error(`Unsafe .inframuxignore pattern: ${pattern}`);
}
