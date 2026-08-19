import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { catalogSchema, type ProjectCatalog } from '../config/schemas.js';
import { assertSafeRegularFile, atomicWritePrivateFile } from '../core/safe-files.js';

export class EnrolledCatalogStore {
  readonly #stateRoot: string;

  constructor(stateRoot: string) {
    this.#stateRoot = path.resolve(stateRoot);
  }

  async enroll(input: ProjectCatalog): Promise<ProjectCatalog> {
    const catalog = catalogSchema.parse(input);
    await atomicWritePrivateFile(
      this.#stateRoot,
      relativeCatalog(catalog.id),
      Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`),
    );
    return deepFreezeCatalog(catalog);
  }

  async get(project: string): Promise<ProjectCatalog> {
    const filename = path.join(this.#stateRoot, relativeCatalog(project));
    await assertSafeRegularFile(filename);
    return deepFreezeCatalog(catalogSchema.parse(JSON.parse(await readFile(filename, 'utf8'))));
  }
}

function relativeCatalog(project: string): string {
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(project)) throw new Error(`Invalid project ID: ${project}`);
  return path.join('registry', 'projects', `${project}.json`);
}

function deepFreezeCatalog(catalog: ProjectCatalog): ProjectCatalog {
  for (const repository of catalog.repositories) Object.freeze(repository);
  Object.freeze(catalog.repositories);
  for (const service of Object.values(catalog.services)) Object.freeze(service);
  Object.freeze(catalog.services);
  return Object.freeze(catalog);
}
