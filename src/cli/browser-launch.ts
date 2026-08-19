import type { StdioOptions } from 'node:child_process';
import { z } from 'zod';

import { planBrowserLaunch } from '../browser/manager.js';
import { runBrowserPlan } from '../browser/runner.js';
import type { BrowserMode } from '../browser/types.js';
import { loadRepositoryManifest } from '../config/load.js';
import { collectCheckoutEvidence } from '../git/evidence.js';
import { connectClient } from '../ipc/client.js';

const resolvedContextSchema = z.object({
  project: z.string().regex(/^[a-z][a-z0-9-]{1,62}$/),
  repositoryRoot: z.string().startsWith('/'),
  gitCommonDir: z.string().startsWith('/'),
  canonicalRemote: z.string().min(3).max(512),
  manifestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  approvedAt: z.iso.datetime({ offset: true }),
}).strict();

export async function launchBrowserFromRepository(mode: BrowserMode, provider: string | undefined, options: {
  cwd: string;
  socketPath: string;
  browserStateRoot: string;
  browserTasksRoot: string;
  runtimeLauncher: string;
  stdio?: StdioOptions;
  environment?: Readonly<NodeJS.ProcessEnv>;
  signal?: AbortSignal;
}): Promise<void> {
  const evidence = await collectCheckoutEvidence(options.cwd);
  const manifest = await loadRepositoryManifest(evidence.manifestPath);
  const client = await connectClient(options.socketPath);
  let context: z.infer<typeof resolvedContextSchema>;
  try {
    const result = await client.call('project.resolve', { evidence, manifest }, {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    context = resolvedContextSchema.parse(result);
  } finally {
    client.close();
  }
  const plan = planBrowserLaunch({
    mode,
    context,
    ...(provider === undefined ? {} : { provider }),
    browserStateRoot: options.browserStateRoot,
    browserTasksRoot: options.browserTasksRoot,
    runtimeLauncher: options.runtimeLauncher,
  });
  await runBrowserPlan(plan, {
    ...(options.stdio === undefined ? {} : { stdio: options.stdio }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
