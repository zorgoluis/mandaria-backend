import 'dotenv/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const url = new URL(process.env.DATABASE_URL);
const suffix = randomBytes(5).toString('hex');
const cleanDb = `mandaria_clean_${suffix}_test`;
const upgradeDb = `mandaria_upgrade_${suffix}_test`;
const windowsPsql = 'C:/Program Files/PostgreSQL/18/bin/psql.exe';
const psql =
  process.env.PSQL_PATH || (existsSync(windowsPsql) ? windowsPsql : 'psql');
const pgEnv = {
  ...process.env,
  PGHOST: url.hostname,
  PGPORT: url.port || '5432',
  PGUSER: decodeURIComponent(url.username),
  PGPASSWORD: decodeURIComponent(url.password),
  PGCONNECT_TIMEOUT: '5',
};
function sql(db, args) {
  const result = spawnSync(
    psql,
    ['-X', '-w', '-v', 'ON_ERROR_STOP=1', '-tA', ...args],
    { env: { ...pgEnv, PGDATABASE: db }, encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      `SQL verification failed in ${db}; check psql access and CREATEDB permission`,
    );
  return result.stdout.trim();
}
function prisma(db, args) {
  const target = new URL(url);
  target.pathname = '/' + db;
  const result = spawnSync(
    process.execPath,
    ['node_modules/prisma/build/index.js', ...args],
    {
      env: { ...process.env, DATABASE_URL: target.toString() },
      encoding: 'utf8',
    },
  );
  if (result.status !== 0)
    throw new Error(`Prisma migration verification failed in ${db}`);
}
try {
  for (const db of [cleanDb, upgradeDb])
    sql('postgres', ['-c', `CREATE DATABASE "${db}"`]);
  prisma(cleanDb, ['migrate', 'deploy']);
  assert.equal(
    sql(cleanDb, [
      '-c',
      'SELECT count(*) FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    ]),
    String(
      readdirSync('prisma/migrations', { withFileTypes: true }).filter(
        (entry) => entry.isDirectory(),
      ).length,
    ),
  );
  sql(upgradeDb, ['-f', 'prisma/migrations/20260915000100_core/migration.sql']);
  const integrationId = randomUUID();
  const userId = randomUUID();
  const activeId = randomUUID();
  const revokedId = randomUUID();
  const refreshId = randomUUID();
  const hash = createHash('sha256').update(randomBytes(32)).digest('hex');
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${userId}','migration@example.test','${hash}','SUPER_ADMIN',now());
    INSERT INTO "RefreshToken" (id,"userId","tokenHash","expiresAt","updatedAt") VALUES ('${refreshId}','${userId}','${hash}',now()+interval '1 day',now());
    INSERT INTO "IntegrationClient" (id,name,code,status,"updatedAt") VALUES ('${integrationId}','Migration fixture','MIGRATION_FIXTURE','INACTIVE',now());
    INSERT INTO "IntegrationCredential" (id,"clientId","secretHash","revokedAt","updatedAt") VALUES
      ('${activeId}','${integrationId}','${hash}',NULL,now()),
      ('${revokedId}','${integrationId}','${hash}revoked',now(),now());
  `,
  ]);
  const before = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT row_to_json(c) FROM "IntegrationClient" c WHERE id='${integrationId}'`,
    ]),
  );
  prisma(upgradeDb, ['migrate', 'resolve', '--applied', '20260915000100_core']);
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000200_b2b_credentials/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000200_b2b_credentials',
  ]);
  const snapshot = () =>
    Object.fromEntries(
      [
        'User',
        'RefreshToken',
        'IntegrationClient',
        'IntegrationCredential',
      ].map((table) => [
        table,
        sql(upgradeDb, [
          '-c',
          `SELECT json_agg(t ORDER BY id) FROM "${table}" t`,
        ]),
      ]),
    );
  const v11Snapshot = snapshot();
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000300_delivery_providers/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000300_delivery_providers',
  ]);
  assert.deepEqual(snapshot(), v11Snapshot);
  // V1.2 fixtures: provider with limits and a PROVIDER_ADMIN membership.
  const providerId = randomUUID();
  const providerAdminId = randomUUID();
  const membershipId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${providerAdminId}','provider-admin@example.test','${hash}','PROVIDER_ADMIN',now());
    INSERT INTO "DeliveryProvider" (id,name,code,type,status,"maxDrivers","maxVehicles","updatedAt") VALUES ('${providerId}','Migration provider','MIGRATION_PROVIDER','FLEET','ACTIVE',7,9,now());
    INSERT INTO "ProviderMembership" (id,"providerId","userId",role,"updatedAt") VALUES ('${membershipId}','${providerId}','${providerAdminId}','OWNER',now());
  `,
  ]);
  const v12Tables = [
    'User',
    'RefreshToken',
    'IntegrationClient',
    'IntegrationCredential',
    'DeliveryProvider',
    'ProviderMembership',
  ];
  const fullSnapshot = () =>
    Object.fromEntries(
      v12Tables.map((table) => [
        table,
        sql(upgradeDb, [
          '-c',
          `SELECT json_agg(t ORDER BY id) FROM "${table}" t`,
        ]),
      ]),
    );
  const v12Snapshot = fullSnapshot();
  sql(upgradeDb, [
    '-f',
    'prisma/migrations/20260915000400_drivers_vehicles/migration.sql',
  ]);
  prisma(upgradeDb, [
    'migrate',
    'resolve',
    '--applied',
    '20260915000400_drivers_vehicles',
  ]);
  assert.deepEqual(fullSnapshot(), v12Snapshot);
  // V1.4 fixtures: driver with an active assignment and a closed history row.
  const driverUserId = randomUUID();
  const driverId = randomUUID();
  const vehicleId = randomUUID();
  sql(upgradeDb, [
    '-c',
    `
    INSERT INTO "User" (id,email,"passwordHash",role,"updatedAt") VALUES ('${driverUserId}','driver@example.test','${hash}','DRIVER',now());
    INSERT INTO "Driver" (id,"providerId","userId",name,status,availability,"updatedAt") VALUES ('${driverId}','${providerId}','${driverUserId}','Carlos','ACTIVE','AVAILABLE',now());
    INSERT INTO "Vehicle" (id,"providerId",identifier,type,status,"updatedAt") VALUES ('${vehicleId}','${providerId}','MOTO-01','MOTORCYCLE','ACTIVE',now());
    INSERT INTO "DriverVehicleAssignment" (id,"providerId","driverId","vehicleId","assignedAt","unassignedAt") VALUES
      ('${randomUUID()}','${providerId}','${driverId}','${vehicleId}',now() - interval '2 days',now() - interval '1 day'),
      ('${randomUUID()}','${providerId}','${driverId}','${vehicleId}',now(),NULL);
  `,
  ]);
  v12Tables.push('Driver', 'Vehicle', 'DriverVehicleAssignment');
  const v14Snapshot = fullSnapshot();
  prisma(upgradeDb, ['migrate', 'deploy']);
  assert.deepEqual(fullSnapshot(), v14Snapshot);
  for (const table of [
    'DeliveryRequest',
    'DeliveryStop',
    'DeliveryPackage',
    'DeliveryFinancialContext',
    'ApiIdempotencyRecord',
  ])
    assert.equal(
      sql(upgradeDb, ['-c', `SELECT count(*) FROM "${table}"`]),
      '0',
    );
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('DeliveryRequest_publicId_check','DeliveryRequest_cancellation_check','DeliveryStop_values_check','DeliveryPackage_values_check','DeliveryFinancialContext_goods_check','ApiIdempotencyRecord_hash_check')",
      ]),
      '6',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_sequences WHERE sequencename = 'DeliveryRequest_publicId_seq'",
      ]),
      '1',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('ApiIdempotencyRecord_integrationClientId_key_key','DeliveryRequest_publicId_key')",
      ]),
      '2',
    );
  }
  for (const db of [cleanDb, upgradeDb]) {
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_indexes WHERE indexname IN ('DriverVehicleAssignment_active_driver_key','DriverVehicleAssignment_active_vehicle_key') AND indexdef LIKE '%WHERE%unassignedAt%IS NULL%'",
      ]),
      '2',
    );
    assert.equal(
      sql(db, [
        '-c',
        "SELECT count(*) FROM pg_constraint WHERE conname IN ('Driver_name_check','Vehicle_identifier_check','Vehicle_year_check','DriverVehicleAssignment_period_check','DriverVehicleAssignment_driverId_providerId_fkey','DriverVehicleAssignment_vehicleId_providerId_fkey')",
      ]),
      '6',
    );
  }
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "DeliveryProvider"']),
    '1',
  );
  assert.equal(
    sql(upgradeDb, ['-c', 'SELECT count(*) FROM "ProviderMembership"']),
    '1',
  );
  const after = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT row_to_json(c) FROM "IntegrationClient" c WHERE id='${integrationId}'`,
    ]),
  );
  assert.deepEqual(after, { ...before, status: 'SUSPENDED' });
  const credentials = JSON.parse(
    sql(upgradeDb, [
      '-c',
      `SELECT json_agg(c ORDER BY id) FROM "IntegrationCredential" c WHERE "clientId"='${integrationId}'`,
    ]),
  );
  assert.equal(credentials.length, 2);
  assert.equal(
    credentials.find((c) => c.id === activeId).secretHash === hash,
    true,
  );
  assert.equal(credentials.find((c) => c.id === activeId).status, 'ACTIVE');
  assert.deepEqual(credentials.find((c) => c.id === activeId).scopes, []);
  assert.equal(credentials.find((c) => c.id === revokedId).status, 'REVOKED');
  assert.ok(credentials.find((c) => c.id === revokedId).revokedAt);
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "User" WHERE id='${userId}' AND "passwordHash"='${hash}'`,
    ]),
    '1',
  );
  assert.equal(
    sql(upgradeDb, [
      '-c',
      `SELECT count(*) FROM "RefreshToken" WHERE id='${refreshId}' AND "tokenHash"='${hash}'`,
    ]),
    '1',
  );
  prisma(upgradeDb, ['migrate', 'deploy']);
  console.log(
    `PASS: clean migrations (${cleanDb}) and V1.0 -> V1.1 -> V1.2 -> V1.4 -> V1.5 upgrade (${upgradeDb}); IDs, hashes, users, sessions, revocations, providers, memberships, drivers, vehicles and assignments preserved; V1.4/V1.5 constraints and publicId sequence present. Verification databases retained.`,
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? 'Migration preservation assertion failed'
      : error.message,
  );
  process.exitCode = 1;
}
