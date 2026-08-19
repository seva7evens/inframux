import { readFile } from 'node:fs/promises';

import { parse as parseToml } from 'smol-toml';
import { parse as parseYaml } from 'yaml';

import {
  catalogSchema,
  repositoryManifestSchema,
  type ProjectCatalog,
  type RepositoryManifest,
} from './schemas.js';

export async function loadRepositoryManifest(filename: string): Promise<RepositoryManifest> {
  const source = await readFile(filename, 'utf8');
  return repositoryManifestSchema.parse(parseToml(source));
}

export async function loadCatalog(filename: string): Promise<ProjectCatalog> {
  const source = await readFile(filename, 'utf8');
  return catalogSchema.parse(parseYaml(source));
}
