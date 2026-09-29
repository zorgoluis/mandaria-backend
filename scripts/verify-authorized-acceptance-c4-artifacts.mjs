import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const hash = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const baseline = JSON.parse(readFileSync('docs/checks/v1.13-c4-baseline.json'));
const changes = Object.entries(baseline.files)
  .filter(([f, h]) => !existsSync(f) || hash(f) !== h)
  .map(([f]) => f);
const envUnchanged =
  hash('.env') === readFileSync('.tmp/c4/env-private', 'utf8').trim();
const git = (args) => {
  const r = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(r.status, 0);
  return r.stdout.trim();
};
const head = git(['rev-parse', 'HEAD']);
const version = JSON.parse(readFileSync('package.json')).version;
const references = [];
const reportPath = 'docs/CHECK-V1.13-C4-AUTHORIZED-ACCEPTANCE.md';
for (const m of readFileSync(reportPath, 'utf8').matchAll(
  /\[[^\]]+\]\(([^)]+)\)/g,
)) {
  if (/^(https?:|#)/.test(m[1])) continue;
  const target = resolve(dirname(reportPath), m[1].split('#')[0]);
  references.push({ reference: m[1], exists: existsSync(target) });
}
const files = readdirSync('docs/checks')
  .filter((f) => f.startsWith('v1.13-c4-'))
  .map((f) => 'docs/checks/' + f);
let jsonFiles = 0;
const findings = [];
for (const f of [...files, reportPath]) {
  const s = readFileSync(f, 'utf8');
  if (f.endsWith('.json')) {
    JSON.parse(s);
    jsonFiles++;
  }
  if (f.endsWith('.jsonl'))
    for (const line of s.split(/\r?\n/).filter(Boolean)) JSON.parse(line);
  if (/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s))
    findings.push({ file: f, kind: 'JWT' });
  if (/postgres(?:ql)?:\/\/[^\s"']+/.test(s))
    findings.push({ file: f, kind: 'database URL' });
  for (const [k, v] of Object.entries(process.env))
    if (
      /SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(k) &&
      v &&
      v.length >= 8 &&
      s.includes(v)
    )
      findings.push({ file: f, kind: 'known private value' });
}
const old = JSON.parse(readFileSync('docs/checks/v1.13-c3-baseline.json'));
const historicalChanges = Object.entries(old.files)
  .filter(([f, h]) => !existsSync(f) || hash(f) !== h)
  .map(([f]) => f);
const output = {
  at: new Date().toISOString(),
  frozenFiles: Object.keys(baseline.files).length,
  changes,
  envUnchanged,
  headUnchanged: head === baseline.head,
  versionUnchanged: version === baseline.version,
  historicalC3: {
    files: Object.keys(old.files).length,
    changes: historicalChanges,
  },
  references,
  parsedJsonFiles: jsonFiles,
  secretFindings: findings,
  gitDiffCheck: git(['diff', '--check']),
};
writeFileSync(
  'docs/checks/v1.13-c4-artifact-check.json',
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    frozenFiles: output.frozenFiles,
    changes,
    envUnchanged,
    headUnchanged: output.headUnchanged,
    versionUnchanged: output.versionUnchanged,
    historicalC3Changes: historicalChanges,
    references: references.length,
    secretFindings: findings.length,
  }),
);
assert.equal(changes.length, 0);
assert.ok(envUnchanged && output.headUnchanged && output.versionUnchanged);
assert.ok(references.every((r) => r.exists));
assert.equal(findings.length, 0);
