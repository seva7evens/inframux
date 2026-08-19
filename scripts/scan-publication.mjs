#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BLOCKED_TOKEN_FINGERPRINTS = new Set([
  'a5b17926587a1634284af5e414628ae2b027008e91f71ddb8ceb936cceb6a8fe',
  '49e338014ddee527c8c756e04e9ab3c656d7e6341008512f2b6087d951f96b58',
  'b508855a727ec8d90efe164aa57492173d6b19195a87b856970aaf563871bc93',
  '77ca29fa27b5ba840287da319fc089be81d7a00e0ba1e40698649c55a06a2928',
  'a0d905386f7031bdac71563219025badd9a219030e1d33c9f848204550f99ede',
  '0cca900c4e14c74c11d6e7068699c160a5d08670ccab13c02fa0e7915f5d6dc0',
  'dc2a2ea4dffffa34229fc6b504b4cf1325e4c82cd447fd068838bc5789e4958b',
  '15c009677d9d254cd9265c60dff1751ec29931ad692d7d8031dfbd56951dbcd9',
  '5c0edf84b90b623c1b6474763f08c7ee62d6df27f1d82c255008478afd0e0151',
  '83410f8704865874901e82571daa0958147ceda591221740b6bdd0129148108c',
  'f4c2c7c6db53e091fac285063592b63eb37cb73c004e7d270aa489546e4deb1c',
  '8f5e1c769b93f1f9b68cd673a23e11c5a7e60d0eb9679149e220db3b7c77c34d',
  'b6a7be5b3ae9ffe4715bd34e9502c7c024c7c28c070404ef676c5d8cc51b2644',
  '3a21e881f05c18e7a79ddbadd2f79a195bdddb5a96a88db8b20a825ae7bb1d7d',
  'c37aa09f8e02061e08a1667897289ea3be9c9f79099775d893a71201795ab8bd',
  '87eff3b945456ec67136efa9d4c138b93354365be80e87b302441f1d2c15c3e2',
  '7dad4d76db7fa8f927e1a9de08ab050b073ddc17809947528d6e133c696e0ec7',
  '7af74604ca34ead03323cb83a7f9f44eb1a813d1af919d3a1e40423ad43b0df7',
  '9b056fdbff4a51369e73abc1e0fe59881287ca219d85f3a9dbdfc551a60dc056',
  'fa2452b78b72011c14f3e1a5fec4c171fe0b0965340970d162ae9fbad963e00e',
  'bc5158c7d36d089bf930dd2ba297eed72e8704dcc5a25d4b4daad16099c0adf6',
  '17f3e8453c5ccbd4977a93c5ee4c68275e0b830a2a3c6c15ad4813f64045485c',
  'e9abaffdafecba64f5bd9084895b89e16a05d47bd5d0256280dee9949c400a18',
]);
const PRIVATE_PATH = /^(?:PROJECTS\.md|projects\/|examples\/|docs\/(?:migration-inventory\.md|reports\/|superpowers\/)|bin\/agent-playwright$)/u;
const LOCAL_HOME = /(?:^|[^A-Za-z0-9])\/Users\/[A-Za-z0-9._-]+\//u;
const PERSONAL_EMAIL = /\b[A-Z0-9._%+-]+@(?:gmail|outlook|hotmail|icloud|yahoo|protonmail)\.[A-Z]{2,}\b/iu;
const TOKEN = /[A-Za-z0-9][A-Za-z0-9._@-]{2,}/gu;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = process.argv.slice(2).includes('--json');

const tracked = execFileSync('git', ['ls-files', '-z'], {
  cwd: root,
  encoding: 'utf8',
  env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' },
}).split('\0').filter(Boolean);
const findings = [];
let textFiles = 0;

for (const relative of tracked) {
  if (PRIVATE_PATH.test(relative)) findings.push({ path: relative, kind: 'private-path' });
  if (containsBlockedToken(relative)) findings.push({ path: relative, kind: 'private-identifier' });
  const filename = path.join(root, relative);
  const stat = lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    findings.push({ path: relative, kind: 'unsafe-entry' });
    continue;
  }
  const bytes = readFileSync(filename);
  if (bytes.includes(0)) continue;
  textFiles += 1;
  const contents = bytes.toString('utf8');
  if (LOCAL_HOME.test(contents)) findings.push({ path: relative, kind: 'local-home-path' });
  if (PERSONAL_EMAIL.test(contents)) findings.push({ path: relative, kind: 'personal-email' });
  if (containsBlockedToken(contents)) findings.push({ path: relative, kind: 'private-identifier' });
}

const unique = [...new Map(findings.map((finding) => [`${finding.path}\0${finding.kind}`, finding])).values()]
  .sort((left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind));
const report = { schema: 1, ok: unique.length === 0, trackedFiles: tracked.length, textFiles, findings: unique };

if (json) process.stdout.write(`${JSON.stringify(report)}\n`);
else if (report.ok) process.stdout.write(`publication scan: ${tracked.length} tracked files are public-safe\n`);
else process.stderr.write(`publication scan failed: ${unique.length} private-context finding(s)\n`);
if (!report.ok) process.exitCode = 1;

function containsBlockedToken(value) {
  for (const token of value.match(TOKEN) ?? []) {
    const fingerprint = createHash('sha256').update(token.toLowerCase()).digest('hex');
    if (BLOCKED_TOKEN_FINGERPRINTS.has(fingerprint)) return true;
  }
  return false;
}
