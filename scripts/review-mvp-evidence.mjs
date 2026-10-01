// Read-only review of local Git/code and retained reports; no database or .env access.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 15e6 }).trim();
const paths = ['src', 'test', 'prisma', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json', 'vitest.config.ts', 'vitest.config.e2e.ts'];
const changedAfterD = git('diff', '--name-only', 'f722f50', 'HEAD', '--', ...paths);
assert.equal(changedAfterD, '', 'Product/tests/config changed after D; reassess evidence');
const fileName = s => s.replaceAll('\\', '/').split('/').pop();
const chosen = new Map();
function add(report, attempt, source, kind, onlyFile) {
  assert.equal(attempt.exit, 0, 'Nonzero exit cannot be reused');
  const r = json(report);
  assert.equal(r.success, true);
  for (const f of r.testResults) {
    const name = fileName(f.name);
    if (onlyFile && name !== onlyFile) continue;
    assert.ok(f.assertionResults.length > 0);
    assert.ok(f.assertionResults.every(c => c.status === 'passed'), 'Incomplete assertions');
    chosen.set(name, { file: name, kind, source, cases: f.assertionResults.length, report, exit: attempt.exit,
      reportSha256: createHash('sha256').update(readFileSync(report)).digest('hex') });
  }
}
const c4 = json('docs/checks/v1.13-c4-consolidated.json');
add(c4.unit.attempt.report, c4.unit.attempt, 'C4 historical', 'unit');
for (const f of c4.e2e.filter(f => f.complete)) {
  add(f.attempt.report, f.attempt, 'C4 historical', 'e2e', fileName(f.file));
}
const d = json('docs/checks/v1.13-d-evidence.json');
for (const f of d.finalReview.verifiedFiles) {
  const a = d.attempts.find(a => a.exit === 0 && a.command.includes(`--outputFile=${f.report}`));
  assert.ok(a);
  add(f.report, a, 'D historical (supersedes same file C4)', f.file.includes('.e2e-') ? 'e2e' : 'unit', f.file);
}
const historical = [...chosen.values()];
const localPath = 'docs/checks/mvp-closure-local.json';
if (existsSync(localPath)) {
  for (const a of json(localPath).attempts.filter(a => a.mode !== 'build' && a.complete)) {
    add(a.report, a, 'MVP new', 'e2e');
  }
}
const baseline = json('docs/checks/v1.13-c4-baseline.json');
const hashChanges = Object.entries(baseline.files).filter(([f,h]) => !existsSync(f) || createHash('sha256').update(readFileSync(f)).digest('hex') !== h).map(([f]) => f);
const lineEndingOnly = [], contentChanges = [], baselineByteUnresolved = [], generatedCache = [];
for (const f of hashChanges) {
  if (f.endsWith('.tsbuildinfo')) { generatedCache.push(f); continue; }
  const old = execFileSync('git', ['show', `${baseline.head}:${f}`], { encoding: 'utf8', maxBuffer: 15e6 });
  const current = readFileSync(f, 'utf8');
  const oldHashes = [old, old.replace(/\r?\n/g, '\r\n')].map(s => createHash('sha256').update(s).digest('hex'));
  if (!oldHashes.includes(baseline.files[f])) baselineByteUnresolved.push(f);
  else (old.replaceAll('\r\n', '\n') === current.replaceAll('\r\n', '\n') ? lineEndingOnly : contentChanges).push(f);
}
const final = [...chosen.values()];
const reconciledHistoricalEndings = [];
const reconciliationPath = 'docs/checks/mvp-closure-fingerprint-reconciliation.json';
if (existsSync(reconciliationPath)) {
  const reconciliation = json(reconciliationPath);
  assert.equal(reconciliation.baselineHead, baseline.head);
  for (const item of reconciliation.results) {
    assert.ok(baselineByteUnresolved.includes(item.file));
    const current = readFileSync(item.file);
    assert.equal(createHash('sha256').update(current).digest('hex'), item.currentRawSha256);
    const lines = current.toString('utf8').replaceAll('\r\n', '\n').split('\n');
    assert.equal(lines.at(-1), '');
    const reconstructed = lines.map((line, i) => line + (i < lines.length - 1
      ? (item.reconstruction.crlfLines.includes(i + 1) ? '\r\n' : '\n') : '')).join('');
    assert.equal(createHash('sha256').update(reconstructed).digest('hex'), baseline.files[item.file]);
    reconciledHistoricalEndings.push(item.file);
  }
}
const remainingBaselineByteUnresolved = baselineByteUnresolved.filter(f => !reconciledHistoricalEndings.includes(f));
const output = { at: new Date().toISOString(), head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'), version: json('package.json').version,
  c4BaselineHead: baseline.head, changedFromC4Baseline: git('diff', '--name-only', baseline.head, 'HEAD', '--', ...paths).split('\n').filter(Boolean),
  rawHashChangesFromC4: hashChanges, lineEndingOnly, contentChanges, baselineByteUnresolved,
  reconciledHistoricalEndings, remainingBaselineByteUnresolved, generatedCache, changedAfterD: [],
  historical: { unitCases: historical.filter(f=>f.kind==='unit').reduce((s,f)=>s+f.cases,0), e2eCases: historical.filter(f=>f.kind==='e2e').reduce((s,f)=>s+f.cases,0) },
  files: final, newCases: final.filter(f=>f.source==='MVP new').reduce((s,f)=>s+f.cases,0),
  caveat: 'Combined file-level evidence, not a new complete-suite execution. C4 core preserved; D additive projection changes covered by D full affected files. Remote revision/config and Coita not verified.' };
writeFileSync('docs/checks/mvp-closure-provenance.json', JSON.stringify(output,null,2)+'\n');
console.log(JSON.stringify({ head: output.head, historical: output.historical, newCases: output.newCases, files: final.length, rawHashChanges: hashChanges.length }));
