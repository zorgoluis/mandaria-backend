import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  cpSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const state = JSON.parse(readFileSync('.tmp/c3/databases.json', 'utf8'));
const source = new URL(process.env.TEST_DATABASE_URL);
const name = state.upgrade;
if (
  !name?.match(/^mandaria_c3_upgrade_[a-f0-9]+_test$/) ||
  !['localhost', '127.0.0.1'].includes(source.hostname)
)
  throw Error('Isolated C3 upgrade database required');
source.pathname = '/' + name;
const url = source.toString();
const scratch = resolve('.tmp/c3/upgrade');
mkdirSync(scratch, { recursive: true });
mkdirSync(resolve(scratch, 'migrations'), { recursive: true });
const newest = '20260929000100_authorized_quote_acceptance';
for (const d of readdirSync('prisma/migrations'))
  if (d !== newest)
    cpSync(resolve('prisma/migrations', d), resolve(scratch, 'migrations', d), {
      recursive: true,
    });
const config = resolve(scratch, 'prisma.config.ts');
writeFileSync(
  config,
  `import {defineConfig} from 'prisma/config'; export default defineConfig({schema:${JSON.stringify(resolve('prisma/schema.prisma'))}, migrations:{path:${JSON.stringify(resolve(scratch, 'migrations'))}},engine:'classic',datasource:{url:process.env.TEST_DATABASE_URL!}});`,
);
const steps = [];
function run(label, args) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, TEST_DATABASE_URL: url },
    maxBuffer: 30 * 1024 * 1024,
  });
  steps.push({
    label,
    command: ['node', ...args].join(' '),
    exit: r.status,
    signal: r.signal,
  });
  console.log(label, r.status, (r.stdout || '') + (r.stderr || ''));
  assert.equal(r.status, 0, label);
}
const p = new PrismaClient({ datasourceUrl: url });
async function digest() {
  const result = {};
  for (const table of [
    'PrequoteConversion',
    'DeliveryPrequote',
    'DeliveryRequest',
    'DeliveryQuote',
    'DeliveryStop',
    'DeliveryPackage',
    'DeliveryFinancialContext',
    'ApiIdempotencyRecord',
    'ApiIdempotencyExecution',
  ]) {
    const rows = await p.$queryRawUnsafe(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) rows FROM "${table}" t`,
    );
    result[table] = createHash('sha256')
      .update(JSON.stringify(rows[0].rows))
      .digest('hex');
  }
  return result;
}
try {
  run('deploy B', [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    config,
  ]);
  run('seed B graph via real HTTP conversion (not a full-suite validation)', [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.config.e2e.ts',
    'test/authorized-acceptance.e2e-spec.ts',
    '-t',
    'upgrade B history',
    '--reporter=json',
    '--outputFile=docs/checks/v1.13-c3-upgrade-seed.json',
  ]);
  assert.ok((await p.prequoteConversion.count()) > 0);
  const before = await digest();
  cpSync(
    resolve('prisma/migrations', newest),
    resolve(scratch, 'migrations', newest),
    { recursive: true },
  );
  run('upgrade B to C', [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--config',
    config,
  ]);
  const after = await digest();
  assert.deepEqual(after, before);
  assert.equal(await p.authorizedQuoteAcceptance.count(), 0);
  run('status', [
    'node_modules/prisma/build/index.js',
    'migrate',
    'status',
    '--config',
    config,
  ]);
  writeFileSync(
    'docs/checks/v1.13-c3-upgrade.json',
    JSON.stringify(
      { steps, before, after, historyPreserved: true, noBackfill: true },
      null,
      2,
    ) + '\n',
  );
} finally {
  await p.$disconnect();
}
