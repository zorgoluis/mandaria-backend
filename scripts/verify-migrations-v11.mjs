import 'dotenv/config';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
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
    '2',
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
  prisma(upgradeDb, ['migrate', 'deploy']);
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
    `PASS: clean migrations (${cleanDb}) and V1.0 upgrade (${upgradeDb}); IDs, hashes, users, sessions and revocations preserved. Verification databases retained.`,
  );
} catch (error) {
  console.error(
    error instanceof assert.AssertionError
      ? 'Migration preservation assertion failed'
      : error.message,
  );
  process.exitCode = 1;
}
