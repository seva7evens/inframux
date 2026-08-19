#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tracked = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'buffer' })
  .toString('utf8').split('\0').filter(Boolean);
const forbiddenPath = /(^|\/)(?:\.env(?:\.|$)|auth\.json$|credentials\/|oauth\/|browser-state\/)|\.(?:pem|key|secret|token)$/i;
const secretContent = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{64,}-----END [A-Z ]*PRIVATE KEY-----/,
  /\bAKIA[A-Z0-9]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/,
];
const findings = [];
for (const filename of tracked) {
  if (forbiddenPath.test(filename) && !/\.env(?:\..+)?\.example$/i.test(filename)) findings.push(`${filename}: forbidden secret-state path`);
  const contents = readFileSync(filename, 'utf8');
  if (secretContent.some((pattern) => pattern.test(contents))) findings.push(`${filename}: credential-shaped tracked content`);
}
if (findings.length > 0) {
  process.stderr.write(`${findings.join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`secret scan: ${tracked.length} tracked files checked\n`);
