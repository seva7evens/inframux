export interface TerminalCapabilities {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly unicode: boolean;
  readonly animation: boolean;
  readonly columns: number;
}

export function detectTerminalCapabilities(input: {
  readonly isTTY: boolean;
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly columns?: number;
  readonly json: boolean;
}): TerminalCapabilities {
  const interactive = input.isTTY && !input.json;
  const simple = input.environment.TERM === 'dumb';
  const ci = input.environment.CI === 'true' || input.environment.CI === '1';
  const columns = Number.isSafeInteger(input.columns) ? Math.max(40, Math.min(240, input.columns!)) : 80;
  return Object.freeze({
    interactive,
    color: interactive && !simple && input.environment.NO_COLOR === undefined,
    unicode: !simple && input.environment.LANG !== 'C' && input.environment.LC_ALL !== 'C',
    animation: interactive && !simple && !ci,
    columns,
  });
}

export function sanitizeTerminalText(value: string, maxLength = 256): string {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 4_096) throw new Error('Terminal text bound is invalid');
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u001f\u007f-\u009f]/gu, '')
    .slice(0, maxLength);
}
