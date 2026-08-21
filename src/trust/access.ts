import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

export type CheckoutAccessReport =
  | Readonly<{ ready: true }>
  | Readonly<{ ready: false; inaccessibleAncestor: string }>;

export interface CheckoutAccessPlan {
  readonly ready: boolean;
  readonly principal: '_inframux';
  readonly ancestors: readonly string[];
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
}

export async function probeCheckoutAccess(
  repositoryRoot: string,
  gitCommonDir: string,
  check: (candidate: string) => Promise<void> = (candidate) => access(candidate, constants.X_OK),
): Promise<CheckoutAccessReport> {
  const candidates = uniqueAncestors([repositoryRoot, gitCommonDir]);
  for (const candidate of candidates) {
    try {
      await check(candidate);
    } catch (error) {
      if (isPermissionError(error)) return Object.freeze({ ready: false, inaccessibleAncestor: candidate });
      throw error;
    }
  }
  return Object.freeze({ ready: true });
}

export function planCheckoutAccess(input: {
  readonly repositoryRoot: string;
  readonly gitCommonDir: string;
  readonly report: CheckoutAccessReport;
}): CheckoutAccessPlan {
  const repositoryRoot = safeAbsolute(input.repositoryRoot);
  const gitCommonDir = safeAbsolute(input.gitCommonDir);
  const ancestors = input.report.ready ? [] : [safeAbsolute(input.report.inaccessibleAncestor)];
  for (const ancestor of ancestors) {
    if (!isStrictAncestor(ancestor, repositoryRoot) && !isStrictAncestor(ancestor, gitCommonDir)) {
      throw new Error('Checkout access target is not an ancestor of captured evidence');
    }
  }
  return Object.freeze({
    ready: input.report.ready,
    principal: '_inframux',
    ancestors: Object.freeze(ancestors),
    repositoryRoot,
    gitCommonDir,
  });
}

function uniqueAncestors(targets: readonly string[]): string[] {
  const result = new Set<string>();
  for (const targetInput of targets) {
    const target = safeAbsolute(targetInput);
    const root = path.parse(target).root;
    const relative = path.relative(root, target).split(path.sep).filter(Boolean);
    let current = root;
    for (const part of relative) {
      current = path.join(current, part);
      result.add(current);
    }
  }
  return [...result].sort((left, right) => left.split(path.sep).length - right.split(path.sep).length || left.localeCompare(right));
}

function safeAbsolute(value: string): string {
  if (!path.isAbsolute(value) || /[\0\r\n]/u.test(value)) throw new Error('Checkout access path must be safe and absolute');
  return path.resolve(value);
}

function isStrictAncestor(ancestor: string, target: string): boolean {
  const relative = path.relative(ancestor, target);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error.code === 'EACCES' || error.code === 'EPERM');
}
