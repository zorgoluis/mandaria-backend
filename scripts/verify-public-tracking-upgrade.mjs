import { PrismaClient } from '@prisma/client';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  !url.pathname.endsWith('_upgrade_test')
)
  throw Error('Local isolated upgrade database required');
const db = new PrismaClient({ datasourceUrl: url.toString() });
const tables = [
  'DeliveryRequest',
  'Dispatch',
  'DeliveryAssignment',
  'DeliveryExecutionEvent',
  'DeliveryCustodyIncident',
  'DeliveryCustodyResolution',
  'DeliveryExecutionCommand',
  'CreditLedgerEntry',
  'B2bOutboxEvent',
];
async function fingerprint() {
  const out = {};
  for (const table of tables) {
    // Table names are the fixed allowlist above, never user input.
    const [row] = await db.$queryRawUnsafe(
      `SELECT count(*)::int AS count,md5(COALESCE(string_agg(to_jsonb(t)::text, '' ORDER BY id),'')) AS hash FROM "${table}" t`,
    );
    out[table] = row;
  }
  return out;
}
try {
  const before = await fingerprint();
  assert(
    before.DeliveryRequest.count > 0,
    'An empty database is not an upgrade fixture',
  );
  const beforeMigrations =
    await db.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  await db.$disconnect();
  const deploy = spawnSync(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (deploy.status !== 0)
    throw Error('Migration failed; exit ' + deploy.status);
  assert.deepEqual(await fingerprint(), before);
  const [coverage] =
    await db.$queryRaw`SELECT (SELECT count(*)::int FROM "DeliveryRequest") AS requests,(SELECT count(*)::int FROM "PublicDeliveryTracking") AS tracking`;
  assert.equal(coverage.requests, coverage.tracking);
  const afterMigrations =
    await db.$queryRaw`SELECT count(*)::int AS count FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  console.log(
    JSON.stringify(
      {
        beforeMigrations,
        afterMigrations,
        history: before,
        coverage,
        preserved: true,
      },
      null,
      2,
    ),
  );
} finally {
  await db.$disconnect();
}
