import path from 'node:path';
import { pathToFileURL } from 'node:url';

import * as playwright from 'playwright';
import * as playwrightTest from '@playwright/test';

import { assertContained, ensurePrivateDirectory } from './paths.mjs';

export async function runApiScript(script, args, context) {
  const requested = path.resolve(context.root, script);
  const safeScript = await assertContained(context.root, requested);
  await ensurePrivateDirectory(context.artifactDir);

  const module = await import(`${pathToFileURL(safeScript).href}?run=${Date.now()}`);
  if (typeof module.default !== 'function') {
    throw new TypeError(`API script must export a default async function: ${safeScript}`);
  }

  return module.default({
    playwright,
    test: playwrightTest.test,
    expect: playwrightTest.expect,
    workspace: context.root,
    artifactDir: context.artifactDir,
    args,
  });
}
