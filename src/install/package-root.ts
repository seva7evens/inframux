import { lstatSync, readFileSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGE_NAME = 'inframux';
const PACKAGE_MANIFEST_LIMIT = 1024 * 1024;

export interface InstalledPackage {
  readonly root: string;
  readonly name: typeof PACKAGE_NAME;
  readonly version: string;
}

export function resolvePackageRoot(moduleUrl: URL | string): InstalledPackage {
  const moduleFile = fileURLToPath(moduleUrl);
  const moduleStat = safeStat(moduleFile, 'Executing module');
  if (!moduleStat.isFile() || moduleStat.isSymbolicLink() || moduleStat.nlink !== 1) {
    throw new Error(`Unsafe module file: ${moduleFile}`);
  }
  const canonicalModule = realpathSync(moduleFile);
  let directory = path.dirname(canonicalModule);

  for (;;) {
    const manifestFile = path.join(directory, 'package.json');
    try {
      const stat = lstatSync(manifestFile);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > PACKAGE_MANIFEST_LIMIT) {
        throw new Error(`Unsafe package manifest: ${manifestFile}`);
      }
      if (realpathSync(manifestFile) !== manifestFile) throw new Error(`Unsafe package manifest path: ${manifestFile}`);
      const manifest = parseManifest(readFileSync(manifestFile, 'utf8'));
      if (manifest.name !== PACKAGE_NAME) throw new Error(`Invalid package identity: ${String(manifest.name)}`);
      if (manifest.type !== 'module') throw new Error('Invalid package module type');
      if (manifest.bin?.inframux !== 'bin/inframux') throw new Error('Invalid package executable contract');
      if (typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)) {
        throw new Error('Invalid package version');
      }
      return Object.freeze({ root: directory, name: PACKAGE_NAME, version: manifest.version });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Package root not found for module: ${canonicalModule}`);
    directory = parent;
  }
}

function safeStat(filename: string, label: string): Stats {
  try {
    return lstatSync(filename);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`${label} does not exist: ${filename}`);
    }
    throw error;
  }
}

function parseManifest(source: string): {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly type?: unknown;
  readonly bin?: { readonly inframux?: unknown };
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new Error('Invalid package manifest JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid package manifest');
  }
  return parsed as ReturnType<typeof parseManifest>;
}
