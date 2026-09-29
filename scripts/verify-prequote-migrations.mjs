import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, cpSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

// Creates only new randomly named *_test databases; retains them and never resets/drops anything.
const source = new URL(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
  throw Error('Local PostgreSQL required');
const suffix = randomBytes(5).toString('hex');
const names = [
  `mandaria_a3_clean_${suffix}_test`,
  `mandaria_a3_upgrade_${suffix}_test`,
];
const scratch = resolve('.tmp', 'a3-migrations', suffix);
mkdirSync(scratch, { recursive: true });
const config = resolve(scratch, 'prisma.config.ts');
const migrations = resolve(scratch, 'migrations');
mkdirSync(migrations);
const dirs = readdirSync('prisma/migrations', { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const a3 = dirs.filter((d) => ['20260928000100_prequote_persistence', '20260928000200_prequote_execution_hardening'].includes(d));
assert.equal(a3.length, 2);
writeFileSync(
  config,
  `import {defineConfig} from 'prisma/config';\nexport default defineConfig({schema:${JSON.stringify(resolve('prisma/schema.prisma'))},migrations:{path:${JSON.stringify(migrations)}},engine:'classic',datasource:{url:process.env.TEST_DATABASE_URL!}});\n`,
);
const connection = (name) => {
  const u = new URL(source);
  u.pathname = '/' + name;
  return u.toString();
};
const admin = new PrismaClient({ datasourceUrl: connection('postgres') });
const opened = [];
function deploy(name) {
  if (!names.includes(name) || !name.endsWith('_test'))
    throw Error('Unsafe migration target');
  const result = spawnSync(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      config,
    ],
    {
      env: { ...process.env, TEST_DATABASE_URL: connection(name) },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw Error(`Migration failed in ${name}; connection data withheld`);
}
async function digest(p) {
  const result = {};
  for (const table of [
    'IntegrationClient',
    'ApiIdempotencyRecord',
    'DeliveryRequest',
    'DeliveryStop',
    'DeliveryPackage',
    'DeliveryFinancialContext',
    'ServiceZone',
    'RatePlan',
    'RateBand',
    'DeliveryQuote',
    'CreditAccount',
    'CreditLedgerEntry',
  ]) {
    const rows = await p.$queryRawUnsafe(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]'::jsonb) AS rows FROM "${table}" t`,
    );
    result[table] = createHash('sha256')
      .update(JSON.stringify(rows[0].rows))
      .digest('hex');
  }
  return result;
}
try {
  for (const name of names)
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
  for (const d of dirs.filter((d) => !a3.includes(d)))
    cpSync(resolve('prisma/migrations', d), resolve(migrations, d), {
      recursive: true,
    });
  cpSync(
    'prisma/migrations/migration_lock.toml',
    resolve(migrations, 'migration_lock.toml'),
  );
  deploy(names[1]);
  const old = new PrismaClient({ datasourceUrl: connection(names[1]) });
  opened.push(old);
  const client = await old.integrationClient.create({
    data: { name: 'A3 upgrade fixture', code: 'A3_UPGRADE' },
  });
  const req = await old.deliveryRequest.create({
    data: {
      publicId: 'MDR-000001',
      integrationClientId: client.id,
      stops: {
        create: [
          {
            type: 'PICKUP',
            sequence: 1,
            address: 'Synthetic fixture',
            latitude: 10,
            longitude: 10,
            contactName: 'Fixture',
            contactPhone: '0000000000',
          },
          {
            type: 'DROPOFF',
            sequence: 2,
            address: 'Synthetic fixture',
            latitude: 10.01,
            longitude: 10.01,
            contactName: 'Fixture',
            contactPhone: '0000000000',
          },
        ],
      },
      packages: {
        create: { category: 'FOOD', description: 'Fixture', quantity: 1 },
      },
      financialContext: {
        create: {
          goodsValue: '450.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      },
    },
  });
  const original = await old.apiIdempotencyRecord.create({
    data: {
      integrationClientId: client.id,
      key: 'a3-legacy-key',
      operation: 'delivery_requests.create',
      resourceType: 'DeliveryRequest',
      resourceId: req.id,
      requestHash: createHash('sha256')
        .update('legacy hash preserved')
        .digest('hex'),
    },
  });
  const z = await old.serviceZone.create({
    data: {
      code: 'A3_UPGRADE_ZONE',
      name: 'Fixture',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [10, 10],
            [11, 10],
            [11, 11],
            [10, 11],
            [10, 10],
          ],
        ],
      },
      minLatitude: 10,
      maxLatitude: 11,
      minLongitude: 10,
      maxLongitude: 11,
    },
  });
  const plan = await old.ratePlan.create({
    data: {
      serviceZoneId: z.id,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      quoteValidityMinutes: 15,
      currency: 'MXN',
      bands: {
        create: {
          minDistanceMeters: 0,
          maxDistanceMeters: 5000,
          amount: '25.10',
          currency: 'MXN',
        },
      },
    },
    include: { bands: true },
  });
  await old.ratePlan.update({
    where: { id: plan.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  const now = new Date();
  await old.deliveryQuote.create({
    data: {
      publicId: 'MQ-000001',
      deliveryRequestId: req.id,
      serviceType: 'LOCAL_DELIVERY',
      serviceZoneId: z.id,
      ratePlanId: plan.id,
      rateBandId: plan.bands[0].id,
      distanceMeters: 1200,
      durationSeconds: 60,
      amount: '25.10',
      currency: 'MXN',
      routingProvider: 'migration-fixture',
      routeCalculatedAt: now,
      expiresAt: new Date(now.getTime() + 900000),
    },
  });
  const before = await digest(old);
  for (const d of a3)
    cpSync(resolve('prisma/migrations', d), resolve(migrations, d), {
      recursive: true,
    });
  deploy(names[1]);
  deploy(names[0]);
  assert.deepEqual(await digest(old), before);
  assert.deepEqual(
    await old.apiIdempotencyRecord.findUnique({ where: { id: original.id } }),
    original,
  );
  for (const name of names) {
    const p =
      name === names[1]
        ? old
        : new PrismaClient({ datasourceUrl: connection(name) });
    if (p !== old) opened.push(p);
    assert.equal(await p.deliveryPrequote.count(), 0);
    assert.equal(await p.apiIdempotencyExecution.count(), 0);
    const [count] = await p.$queryRawUnsafe(
      'SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
    );
    assert.equal(count.n, dirs.length);
  }
  console.log(
    JSON.stringify({
      status: 'PASS',
      databases: names,
      migrations: dirs.length,
      legacyTablesCompared: Object.keys(before).length,
      legacyIdempotencyPreserved: true,
      retained: true,
    }),
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? 'Migration preservation assertion failed (values withheld)'
      : error.message,
  );
  process.exitCode = 1;
} finally {
  await Promise.all(opened.map((p) => p.$disconnect()));
  await admin.$disconnect();
}
