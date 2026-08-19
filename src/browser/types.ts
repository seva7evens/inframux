import type { ResolvedProjectContext } from '../trust/types.js';

export type BrowserMode = 'clean' | 'persistent';

export interface BrowserLaunchPlan {
  readonly mode: BrowserMode;
  readonly project: string;
  readonly provider: string | null;
  readonly context: ResolvedProjectContext;
  readonly executable: string;
  readonly args: readonly string[];
  readonly profileDir: string;
  readonly artifactDir: string;
  readonly taskRoot: string | null;
  readonly lockPath: string | null;
  readonly cleanup: boolean;
}

export interface BrowserProfileLease {
  readonly plan: BrowserLaunchPlan;
  release(): Promise<void>;
}
