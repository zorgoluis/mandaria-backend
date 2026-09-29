import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const source = new URL(process.env.TEST_DATABASE_URL);
if (!['localhost', '127.0.0.1'].includes(source.hostname))
  throw Error('Local source required');
const baseline = JSON.parse(
  readFileSync('docs/checks/v1.13-c4-regression.json'),
);
const selected = baseline.attempts.filter((a) => {
  if (a.phase !== 'test' || a.exit === 0) return false;
  if (a.exit === 3221226505) return true;
  // A partial JSON report with zero assertion failures is not a green run.
  // Limit the diagnostic to incomplete runner termination, not assertion retries.
  if (!existsSync(a.report)) return false;
  const r = JSON.parse(readFileSync(a.report));
  return (
    a.exit === 1 && r.numFailedTests === 0 && r.numPassedTests < r.numTotalTests
  );
});
const attempts = [];
for (const a of selected) {
  if (!/^mandaria_c4_reg_[a-f0-9]+_test$/.test(a.database))
    throw Error('C4 isolated database required');
  const u = new URL(source);
  u.pathname = '/' + a.database;
  const report = `docs/checks/v1.13-c4-diag-${a.file}.json`,
    log = `docs/checks/v1.13-c4-diag-${a.file}.txt`,
    observer = `docs/checks/v1.13-c4-diag-${a.file}-events.jsonl`;
  if (existsSync(log))
    throw Error('One diagnostic attempt per aborted file only');
  const args = [
    '--report-on-fatalerror',
    '--report-exclude-env',
    '--report-exclude-network',
    '--report-directory=.tmp/c4/native',
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.config.e2e.ts',
    `test/${a.file}.e2e-spec.ts`,
    a.command.includes('--pool=forks') ? '--pool=threads' : '--pool=forks',
    '--maxWorkers=1',
    '--hookTimeout=30000',
    '--reporter=json',
    '--reporter=./scripts/c4-runner-observer.mjs',
    `--outputFile=${report}`,
  ];
  const startedAt = new Date().toISOString();
  const r = spawnSync(process.execPath, args, {
    env: {
      ...process.env,
      TEST_DATABASE_URL: u.toString(),
      C4_OBSERVER_PATH: observer,
    },
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 40e6,
  });
  let output =
    (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '');
  for (const [k, v] of Object.entries(process.env))
    if (/SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(k) && v && v.length >= 8)
      output = output.split(v).join('[REDACTED]');
  output = output
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]');
  writeFileSync(log, output);
  attempts.push({
    file: a.file,
    database: a.database,
    command: ['node', ...args].join(' '),
    startedAt,
    endedAt: new Date().toISOString(),
    exit: r.status,
    signal: r.signal,
    report,
    log,
    observer,
  });
  writeFileSync(
    'docs/checks/v1.13-c4-diagnostics.json',
    JSON.stringify({ attempts }, null, 2) + '\n',
  );
  console.log(
    JSON.stringify({ file: a.file, exit: r.status, signal: r.signal }),
  );
}
process.exitCode = attempts.some((a) => a.exit !== 0) ? 1 : 0;
