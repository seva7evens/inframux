export const RUNTIME_NODE_VERSION = '24.18.1' as const;

export function assertRuntimeVersion(actual = process.version): void {
  const normalized = actual.startsWith('v') ? actual.slice(1) : actual;
  if (normalized !== RUNTIME_NODE_VERSION) {
    throw new Error(
      `inframux requires Node.js ${RUNTIME_NODE_VERSION}; received ${actual}`,
    );
  }
}
