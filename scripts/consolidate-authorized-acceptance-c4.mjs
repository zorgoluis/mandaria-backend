import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
const read = (path) => JSON.parse(readFileSync(path));
const inventory = read('docs/checks/v1.13-c4-inventory.json');
const root = read('docs/checks/v1.13-c4-evidence.json');
const attempts = [
  ...read('docs/checks/v1.13-c4-regression.json').attempts.filter(
    (a) => a.phase === 'test',
  ),
  ...(existsSync('docs/checks/v1.13-c4-diagnostics.json')
    ? read('docs/checks/v1.13-c4-diagnostics.json').attempts
    : []),
];
const inspect = (attempt) => {
  if (!existsSync(attempt.report))
    return { complete: false, reason: 'missing report', attempt };
  const r = read(attempt.report);
  const cases = r.testResults.flatMap((f) => f.assertionResults);
  const complete =
    attempt.exit === 0 &&
    r.success === true &&
    r.numFailedTests === 0 &&
    r.numPendingTests === 0 &&
    r.numTotalTests > 0 &&
    r.numPassedTests === r.numTotalTests &&
    cases.length === r.numTotalTests &&
    cases.every((c) => c.status === 'passed') &&
    r.testResults.every((f) => f.status === 'passed');
  return {
    complete,
    total: r.numTotalTests,
    passed: r.numPassedTests,
    failed: r.numFailedTests,
    files: r.testResults.map((f) => ({
      file: f.name.replaceAll('\\', '/').split('/mandaria-backend/').at(-1),
      // Parameterized cases can intentionally share a display name. Identity is
      // file + ordinal within this one complete report, not the label alone.
      cases: f.assertionResults.map((c, index) => ({
        ordinal: index + 1,
        name: c.fullName,
      })),
    })),
    attempt,
  };
};
const results = attempts.map(inspect);
const e2e = inventory.e2e.map((file) => {
  const candidates = results.filter(
    (r) => r.complete && r.files.length === 1 && r.files[0].file === file,
  );
  assert.ok(candidates.length <= 1, 'Do not double-count repeated green files');
  const selected = candidates[0];
  return {
    file,
    complete: !!selected,
    cases: selected?.files[0].cases ?? [],
    attempt: selected?.attempt,
  };
});
const unitAttempt = root.attempts.find((a) => a.label === 'unit');
const unit = inspect({
  ...unitAttempt,
  report: 'docs/checks/v1.13-c4-unit.json',
});
assert.deepEqual(
  unit.files.map((f) => f.file).sort(),
  [...inventory.unit].sort(),
);
for (const f of [...e2e, ...unit.files])
  assert.equal(new Set(f.cases.map((c) => c.ordinal)).size, f.cases.length);
const output = {
  at: new Date().toISOString(),
  e2eFiles: e2e.length,
  e2eComplete: e2e.filter((f) => f.complete).length,
  e2eCases: e2e.reduce((n, f) => n + f.cases.length, 0),
  unitFiles: unit.files.length,
  unitCases: unit.passed,
  unitComplete: unit.complete,
  e2e,
  unit,
  excludedAttempts: results
    .filter((r) => !r.complete)
    .map(({ files: _files, ...r }) => r),
};
writeFileSync(
  'docs/checks/v1.13-c4-consolidated.json',
  JSON.stringify(output, null, 2) + '\n',
);
console.log(
  JSON.stringify({
    e2eFiles: output.e2eFiles,
    e2eComplete: output.e2eComplete,
    e2eCases: output.e2eCases,
    unitFiles: output.unitFiles,
    unitCases: output.unitCases,
    unitComplete: output.unitComplete,
  }),
);
process.exitCode =
  output.e2eComplete === output.e2eFiles && unit.complete ? 0 : 1;
