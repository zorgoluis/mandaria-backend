import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const source = new URL(process.env.TEST_DATABASE_URL);
if (
  !['localhost', '127.0.0.1'].includes(source.hostname) ||
  !source.pathname.startsWith('/mandaria_c3_clean_')
)
  throw Error('C3 test source required');
const files = [
  'check-a6-prequotes',
  'prequote-conversion',
  'check-b3-conversion',
  'check-b4-conversion',
  'delivery-quotes',
  'dispatch',
  'dispatch-credit-snapshots',
  'delivery-assignments',
  'credit-consumption',
  'credit-refunds',
  'delivery-completion',
  'independent-drivers',
  'b2b-outbox',
  'b2b-delivery-status',
];
const sanitize = (text) => {
  let s = String(text);
  for (const [k, v] of Object.entries(process.env))
    if (/SECRET|PASSWORD|TOKEN|DATABASE_URL/.test(k) && v && v.length >= 8)
      s = s.split(v).join('[REDACTED]');
  return s
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/g, '[DATABASE_URL]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[JWT]');
};
const evidence = { node: process.version, attempts: [] };
const save = () =>
  writeFileSync(
    'docs/checks/v1.13-c3-regression.json',
    JSON.stringify(evidence, null, 2) + '\n',
  );
mkdirSync('.tmp/c3', { recursive: true });
mkdirSync('.tmp/b4', { recursive: true });
const adminUrl = new URL(source);
adminUrl.pathname = '/postgres';
const admin = new PrismaClient({ datasourceUrl: adminUrl.toString() });
try {
  for (const file of files) {
    const name = `mandaria_c3_reg_${randomBytes(6).toString('hex')}_test`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const u = new URL(source);
    u.pathname = '/' + name;
    const env = {
      ...process.env,
      TEST_DATABASE_URL: u.toString(),
      B4_EVIDENCE_PATH: '.tmp/c3/b4-observations.json',
    };
    const deploy = spawnSync(
      process.execPath,
      [
        'node_modules/prisma/build/index.js',
        'migrate',
        'deploy',
        '--config',
        'prisma.test.config.ts',
      ],
      { env, encoding: 'utf8', maxBuffer: 20e6 },
    );
    const deployLog = `docs/checks/v1.13-c3-reg-${file}-migrate.txt`;
    writeFileSync(
      deployLog,
      sanitize((deploy.stdout || '') + (deploy.stderr || '')),
    );
    evidence.attempts.push({
      file,
      phase: 'migrate',
      database: name,
      exit: deploy.status,
      signal: deploy.signal,
      command:
        'node node_modules/prisma/build/index.js migrate deploy --config prisma.test.config.ts',
      log: deployLog,
    });
    save();
    if (deploy.status !== 0) throw Error('Isolated deployment failed');
    const pool = ['credit-refunds', 'delivery-completion'].includes(file)
      ? 'forks'
      : 'threads';
    const report = `docs/checks/v1.13-c3-reg-${file}.json`,
      log = `docs/checks/v1.13-c3-reg-${file}.txt`;
    const args = [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.config.e2e.ts',
      `test/${file}.e2e-spec.ts`,
      `--pool=${pool}`,
      '--maxWorkers=1',
      '--hookTimeout=30000',
      '--reporter=json',
      `--outputFile=${report}`,
    ];
    const startedAt = new Date().toISOString();
    const r = spawnSync(process.execPath, args, {
      env,
      encoding: 'utf8',
      maxBuffer: 40e6,
      timeout: 300000,
    });
    writeFileSync(
      log,
      sanitize(
        (r.stdout || '') + (r.stderr || '') + (r.error ? String(r.error) : ''),
      ),
    );
    evidence.attempts.push({
      file,
      phase: 'test',
      database: name,
      command: ['node', ...args].join(' '),
      startedAt,
      endedAt: new Date().toISOString(),
      exit: r.status,
      signal: r.signal,
      report,
      log,
    });
    save();
    console.log(JSON.stringify({ file, exit: r.status, signal: r.signal }));
  }
} finally {
  await admin.$disconnect();
  save();
}
process.exitCode = evidence.attempts.some((r) => r.exit !== 0) ? 1 : 0;
