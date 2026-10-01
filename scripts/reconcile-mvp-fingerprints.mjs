// Documentary verification only: no database, runtime, environment or product writes.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseline = JSON.parse(readFileSync('docs/checks/v1.13-c4-baseline.json', 'utf8'));
const normalize = value => value.toString('utf8').replaceAll('\r\n', '\n');
const files = ['src/common/public-id.ts',
  ...['20260928000100_prequote_persistence', '20260928000200_prequote_execution_hardening',
    '20260928000300_prequote_consumption', '20260928000400_prequote_conversion',
    '20260929000100_authorized_quote_acceptance'].map(name => `prisma/migrations/${name}/migration.sql`),
  'scripts/check-prequote-a6-load.mjs'];
assert.equal(files.length, 7);
const results = files.map(file => {
  const current = readFileSync(file);
  const committed = execFileSync('git', ['show', `${baseline.head}:${file}`]);
  const lf = normalize(committed);
  assert.equal(normalize(current), lf, `Content changed: ${file}`);
  // Exact historic layouts discovered from retained migration copies and hash matching.
  // public-id line 13 was LF amongst CRLF; the other six ended CRLF after LF lines.
  const lines = lf.split('\n');
  const last = lines.length - 1;
  assert.equal(lines[last], '');
  const crlfLines = file === 'src/common/public-id.ts'
    ? Array.from({ length: last }, (_, i) => i + 1).filter(n => n !== 13)
    : [last];
  const reconstructed = Buffer.from(lines.map((line, i) => line +
    (i < last ? (crlfLines.includes(i + 1) ? '\r\n' : '\n') : '')).join(''));
  assert.equal(hash(reconstructed), baseline.files[file], `Historical hash mismatch: ${file}`);
  return { file, baselineSha256: baseline.files[file], reconstructedSha256: hash(reconstructed),
    currentRawSha256: hash(current), gitBlobSha256: hash(committed), normalizedSha256: hash(lf),
    reconstruction: { source: `${baseline.head}:${file}`, defaultEnding: 'LF', crlfLines },
    contentEqual: true, result: 'RECONCILED_EOL_ONLY' };
});
const output = { at: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  baselineHead: baseline.head, baselineManifestSha256: hash(readFileSync('docs/checks/v1.13-c4-baseline.json')),
  method: 'Reconstruct exact historical bytes from committed content and explicit per-line endings; require SHA-256 equality with preserved baseline and LF-normalized equality with current file.',
  results, reconciled: results.length, unresolved: 0,
  limits: 'No functional tests or remote verification. Does not establish VM artifact identity, applied migration checksums or cause of historic runner aborts.' };
writeFileSync('docs/checks/mvp-closure-fingerprint-reconciliation.json', JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ reconciled: output.reconciled, unresolved: output.unresolved }));
