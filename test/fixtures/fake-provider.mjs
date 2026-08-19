#!/usr/bin/env node

const [command, ...args] = process.argv.slice(2);
const token = process.env.INFRAMUX_SYNTHETIC_TOKEN || '';

switch (command) {
  case 'identity':
    process.stdout.write(`${JSON.stringify({ accountId: token.match(/^account:([^:]+):/)?.[1] || process.env.SYNTHETIC_ACCOUNT_ID || 'missing' })}\n`);
    break;
  case 'resources':
    process.stdout.write(`${JSON.stringify({ resources: ['alpha', 'beta'] })}\n`);
    break;
  case 'echo':
    process.stdout.write(JSON.stringify({
      args: args.filter((arg) => arg !== 'print-secret'),
      cwd: process.cwd(),
      environment: Object.keys(process.env).sort(),
      secret: args.includes('print-secret') ? token : undefined,
    }));
    break;
  case 'sleep':
    await new Promise((resolve) => setTimeout(resolve, Number(args[0] || '1000')));
    break;
  case 'overflow':
    process.stdout.write('x'.repeat(Number(args[0] || '1048576')));
    break;
  case 'crash':
    process.exitCode = 23;
    break;
  default:
    process.stderr.write('unknown synthetic command\n');
    process.exitCode = 2;
}
