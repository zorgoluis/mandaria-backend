// Bounded local-only MVP review. No migrations, service startup or remote access.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
const mode = process.argv[2];
if (!['build', 'threads', 'forks'].includes(mode)) throw Error('Use build, threads or forks');
const local = existsSync('.env') ? parse(readFileSync('.env', 'utf8')) : {};
const source = process.env.TEST_DATABASE_URL || local.TEST_DATABASE_URL || process.env.DATABASE_URL || local.DATABASE_URL;
const url = source ? new URL(source) : null;
if (mode !== 'build' && (!url || !['localhost', '127.0.0.1'].includes(url.hostname))) throw Error('Local PostgreSQL connection configuration required');
if (mode !== 'build' && !/^\/mandaria_(?:mvp_[a-z0-9_]+|c4_reg_02b867eb3058)_test$/.test(url.pathname)) throw Error('Explicit isolated review database required');
const index = 'docs/checks/mvp-closure-local.json';
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const evidence = existsSync(index) ? json(index) : {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  versions: Object.fromEntries(['vitest', 'prisma', 'typescript', '@nestjs/core'].map(n => [n, json(`node_modules/${n}/package.json`).version])),
  database: url?.pathname.slice(1) ?? null, attempts: [],
};
const previous = evidence.attempts.filter(a => a.mode === mode);
if (previous.length && !(previous.length === 1 && previous[0].cases === 0 && readFileSync(previous[0].log, 'utf8').includes('Test database must differ from DATABASE_URL'))) throw Error('Mode already attempted; inspect retained evidence');
mkdirSync('.tmp/mvp/native', { recursive: true });
const prefix = `docs/checks/mvp-closure-${mode}${previous.length ? '-environment-corrected' : ''}`;
const report = prefix + '.json', observer = prefix + '-events.jsonl';
const args = mode === 'build' ? ['node_modules/@nestjs/cli/bin/nest.js', 'build'] : [
  '--report-on-fatalerror', '--report-exclude-env', '--report-exclude-network', '--report-directory=.tmp/mvp/native',
  'node_modules/vitest/vitest.mjs', 'run', '--config', 'vitest.config.e2e.ts',
  'test/delivery-requests-b2b.e2e-spec.ts', `--pool=${mode}`, '--maxWorkers=1', '--hookTimeout=30000',
  '--reporter=json', '--reporter=./scripts/c4-runner-observer.mjs', `--outputFile=${report}`,
];
const env = { ...local, ...process.env, ...(url ? { TEST_DATABASE_URL: url.toString() } : {}),
  NODE_ENV: 'test', MAIL_PROVIDER: 'local_outbox', B2B_WEBHOOK_POLL_SECONDS: '0',
  PREQUOTE_ENABLED: 'false', PREQUOTE_CONVERSION_ENABLED: 'false', PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: 'false',
  C4_OBSERVER_PATH: observer,
};
const startedAt = new Date().toISOString();
const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: 300000, maxBuffer: 30e6 });
const sanitize = text => {
  for (const [key, value] of Object.entries({ ...local, ...process.env })) {
    if (/SECRET|PASSWORD|TOKEN|DATABASE_URL|API_KEY/.test(key) && value?.length >= 8) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]').replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]').replace(/\$argon2id\$[^\s"']+/g, '[PASSWORD_HASH]');
};
writeFileSync(prefix + '.txt', sanitize((r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : '')));
for (const file of [report, observer]) if (existsSync(file)) writeFileSync(file, sanitize(readFileSync(file, 'utf8')));
const result = mode !== 'build' && existsSync(report) ? json(report) : null;
const cases = result?.testResults.flatMap(f => f.assertionResults) || [];
const complete = mode === 'build' ? r.status === 0 : r.status === 0 && result?.success === true && cases.length === 15 && cases.every(c => c.status === 'passed');
const attempt = { mode, database: url?.pathname.slice(1) ?? null, command: ['node', ...args].join(' '), startedAt, endedAt: new Date().toISOString(), exit: r.status, signal: r.signal, complete, cases: cases.length, passed: cases.filter(c => c.status === 'passed').length, log: prefix + '.txt', ...(mode === 'build' ? {} : { report, observer }), testOverrides: { flags: 'all false', mail: 'local_outbox', webhookLoop: 'off' } };
evidence.attempts.push(attempt);
writeFileSync(index, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(attempt));
process.exitCode = complete ? 0 : 1;
