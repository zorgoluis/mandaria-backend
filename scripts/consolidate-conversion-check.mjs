import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// Read-only audit of immutable per-attempt records; reporters alone never establish PASS.
const root = resolve(process.argv[2] ?? '.tmp/b4r');
const expected = JSON.parse(
  readFileSync(resolve(root, 'inventory.json'), 'utf8'),
);
const current = readdirSync('test')
  .filter((f) => f.endsWith('.e2e-spec.ts'))
  .sort();
assert.deepEqual(current, expected.e2e, 'E2E inventory changed during CHECK');
const unitFiles = ['src', 'test']
  .flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .filter((f) => f.endsWith('.spec.ts') && !f.endsWith('.e2e-spec.ts'))
      .map((f) => f.replaceAll('\\', '/').split('/').at(-1)),
  )
  .sort();
assert.deepEqual(
  unitFiles,
  expected.unit,
  'Unit inventory changed during CHECK',
);
const attempts = readdirSync(resolve(root, 'attempts'))
  .filter((id) => existsSync(resolve(root, 'attempts', id, 'result.json')))
  .map((id) =>
    JSON.parse(
      readFileSync(resolve(root, 'attempts', id, 'result.json'), 'utf8'),
    ),
  )
  .sort((a, b) => a.endedAt.localeCompare(b.endedAt));
const winners = new Map();
for (const attempt of attempts) {
  if (
    attempt.exit !== 0 ||
    attempt.signal ||
    attempt.error ||
    attempt.failed !== 0 ||
    attempt.passed !== attempt.total ||
    !(attempt.total > 0)
  )
    continue;
  const path = resolve(attempt.report),
    inside = relative(resolve(root, 'attempts'), path);
  assert(
    !inside.startsWith('..') && !isAbsolute(inside),
    'Report outside attempts',
  );
  const raw = readFileSync(path);
  assert.equal(
    createHash('sha256').update(raw).digest('hex'),
    attempt.reportSha256,
    'Report changed',
  );
  const report = JSON.parse(raw);
  if (
    report.success !== true ||
    report.numFailedTests !== 0 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numPassedTests !== attempt.passed
  )
    continue;
  const assertions = report.testResults.flatMap((r) => r.assertionResults);
  if (
    assertions.length !== attempt.total ||
    assertions.some((t) => t.status !== 'passed')
  )
    continue;
  const reportedFiles = report.testResults
    .map((r) => r.name.replaceAll('\\', '/').split('/').at(-1))
    .sort();
  const wanted = attempt.file === 'unit' ? expected.unit : [attempt.file];
  assert.deepEqual(reportedFiles, wanted, 'Whole-file inventory mismatch');
  winners.set(attempt.file, attempt);
}
const missing = [...expected.e2e, 'unit'].filter((f) => !winners.has(f));
const e2e = expected.e2e
  .filter((f) => winners.has(f))
  .map((f) => winners.get(f));
const result = {
  complete: missing.length === 0,
  missing,
  inventory: expected,
  unit: winners.get('unit') ?? null,
  e2e,
  e2eCases: e2e.reduce((n, r) => n + r.total, 0),
  attempts,
};
writeFileSync(
  resolve(root, 'consolidated.json'),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    complete: result.complete,
    files: e2e.length,
    cases: result.e2eCases,
    unit: result.unit?.total ?? null,
    missing,
  }),
);
if (missing.length) process.exitCode = 1;
