import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const MANIFEST_LIMIT = 1024 * 1024;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
}

export interface DependencyCopyEntry {
  readonly name: string;
  readonly version: string;
  readonly source: string;
  readonly relativePath: string;
}

export async function buildProductionDependencyCopyPlan(sourceRoot: string): Promise<readonly DependencyCopyEntry[]> {
  const root = await realpath(sourceRoot);
  const rootManifest = await readManifest(path.join(root, 'package.json'));
  const plan = new Map<string, DependencyCopyEntry>();

  const collect = async (name: string, fromDirectory: string, optional: boolean): Promise<void> => {
    assertPackageName(name);
    const source = await resolveDependency(root, fromDirectory, name);
    if (source === undefined) {
      if (optional) return;
      throw new Error(`Missing required dependency ${name} from ${fromDirectory}`);
    }
    if (plan.has(source)) return;
    const manifest = await readManifest(path.join(source, 'package.json'));
    if (manifest.name !== name) throw new Error(`Dependency package identity mismatch: expected ${name}, received ${manifest.name}`);
    await assertSafePackagePayload(source);
    const relativePath = path.relative(root, source);
    if (!isProductionModulePath(relativePath)) throw new Error(`Dependency escaped package node_modules: ${name}`);
    plan.set(source, Object.freeze({ name, version: manifest.version, source, relativePath }));

    for (const dependency of Object.keys(manifest.dependencies).sort()) {
      await collect(dependency, source, false);
    }
    for (const dependency of Object.keys(manifest.optionalDependencies).sort()) {
      if (!(dependency in manifest.dependencies)) await collect(dependency, source, true);
    }
  };

  for (const dependency of Object.keys(rootManifest.dependencies).sort()) {
    await collect(dependency, root, false);
  }
  for (const dependency of Object.keys(rootManifest.optionalDependencies).sort()) {
    if (!(dependency in rootManifest.dependencies)) await collect(dependency, root, true);
  }

  return Object.freeze([...plan.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath)));
}

async function resolveDependency(root: string, fromDirectory: string, name: string): Promise<string | undefined> {
  const parts = name.split('/');
  let directory = fromDirectory;
  for (;;) {
    if (!isWithinOrSame(root, directory)) throw new Error(`Dependency resolution escaped package root: ${name}`);
    const candidate = path.join(directory, 'node_modules', ...parts);
    try {
      const stat = await lstat(candidate);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe dependency directory: ${candidate}`);
      const canonical = await realpath(candidate);
      if (canonical !== candidate || !isProductionModulePath(path.relative(root, canonical))) {
        throw new Error(`Unsafe dependency directory path: ${candidate}`);
      }
      return canonical;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    if (directory === root) return undefined;
    directory = path.dirname(directory);
  }
}

async function readManifest(filename: string): Promise<PackageManifest> {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MANIFEST_LIMIT) {
    throw new Error(`Unsafe dependency manifest: ${filename}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    throw new Error(`Invalid dependency manifest JSON: ${filename}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid dependency manifest: ${filename}`);
  const record = value as Record<string, unknown>;
  if (typeof record.name !== 'string' || !PACKAGE_NAME.test(record.name)) throw new Error(`Invalid dependency package name: ${filename}`);
  if (typeof record.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(record.version)) {
    throw new Error(`Invalid dependency package version: ${filename}`);
  }
  return Object.freeze({
    name: record.name,
    version: record.version,
    dependencies: dependencyMap(record.dependencies, filename),
    optionalDependencies: dependencyMap(record.optionalDependencies, filename),
  });
}

function dependencyMap(value: unknown, filename: string): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid dependency map: ${filename}`);
  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(value)) {
    assertPackageName(name);
    if (typeof range !== 'string' || range.length === 0 || range.length > 512) throw new Error(`Invalid dependency range for ${name}`);
    result[name] = range;
  }
  return Object.freeze(result);
}

async function assertSafePackagePayload(packageRoot: string): Promise<void> {
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.DS_Store') continue;
      if (entry.name === 'node_modules') continue;
      const filename = path.join(directory, entry.name);
      const stat = await lstat(filename);
      if (stat.isSymbolicLink()) throw new Error(`Dependency payload contains a symlink: ${filename}`);
      if (stat.isDirectory()) {
        await visit(filename);
      } else if (!stat.isFile() || stat.nlink !== 1) {
        throw new Error(`Dependency payload contains an unsafe file: ${filename}`);
      }
    }
  };
  await visit(packageRoot);
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME.test(name)) throw new Error(`Invalid dependency name: ${name}`);
}

function isProductionModulePath(relative: string): boolean {
  return relative === 'node_modules' || relative.startsWith(`node_modules${path.sep}`) && !relative.startsWith(`node_modules${path.sep}..`);
}

function isWithinOrSame(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
