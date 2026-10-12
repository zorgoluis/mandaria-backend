import 'reflect-metadata';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import {
  readFileSync,
  writeFileSync,
  openSync,
  closeSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
// Requires synthetic fixtures from direct-demand E2E; never loads .env or a default database.
const url = process.env.BUSINESS_TEST_DATABASE_URL;
if (!url || process.env.BUSINESS_TEST_CONFIRM_ISOLATED !== 'yes')
  throw Error('Explicit isolated database and confirmation required');
const base = new URL(url);
assert.equal(base.hostname, '127.0.0.1');
assert.ok(base.pathname.endsWith('_test'));
assert.equal(base.username, 'postgres');
assert.equal(base.password, '');
if (url === process.env.DATABASE_URL)
  throw Error('Source must not be the configured main database');
const runId = randomUUID().slice(0, 8),
  root = path.resolve('.tmp/business-migration-' + runId);
mkdirSync(root, { recursive: true });
const e = { root, url };
const pg =
  process.env.BUSINESS_TEST_PG_BIN ?? 'C:/Program Files/PostgreSQL/18/bin';
const log = openSync(e.root + '/migration-verification.log', 'w');
function run(exe, args, env = process.env) {
  const r = spawnSync(exe, args, {
    env,
    stdio: ['ignore', log, log],
    windowsHide: true,
    timeout: 120000,
  });
  if (r.status !== 0) throw Error('Failed ' + exe + ' ' + args[0]);
}
Object.assign(process.env, {
  DATABASE_URL: e.url,
  NODE_ENV: 'test',
  DOTENV_CONFIG_PATH: e.root + '/absent.env',
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  INTEGRATION_JWT_SECRET: randomBytes(48).toString('hex'),
  MAIL_PROVIDER: 'local_outbox',
  MANDARIA_WEB_URL: 'https://web.mandaria.test',
  CUSTOMER_ADMISSION_ENABLED: 'true',
  PREQUOTE_ENABLED: 'true',
  PREQUOTE_CONVERSION_ENABLED: 'true',
  PREQUOTE_AUTHORIZED_ACCEPT_ENABLED: 'true',
  PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS: '100000',
  B2B_WEBHOOK_POLL_SECONDS: '0',
  DISPATCH_SEARCH_POLL_SECONDS: '0',
  PREQUOTE_VALIDITY_MS: '900000',
});
let db = new PrismaClient({ datasourceUrl: e.url });
let app;
async function boot() {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const { PREQUOTE_CONSUMPTION } =
    await import('../dist/delivery-prequotes/prequote-consumption.js');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PREQUOTE_CONSUMPTION)
    .useValue({
      admit: async () => ({
        admitted: true,
        permit: {
          start: async () => {},
          assertReady: async () => {},
          finish: async () => {},
        },
      }),
    })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue({
      name: 'fake',
      calculateRoute: async () => ({
        distanceMeters: 3900,
        durationSeconds: 640,
        routingProvider: 'fake',
        calculatedAt: new Date(),
      }),
    })
    .compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  setup(app);
  await app.init();
}
const api = () => request(app.getHttpServer());
async function token(id) {
  const u = await db.user.findUniqueOrThrow({ where: { id } });
  return app
    .get(JwtService)
    .signAsync(
      { sub: id, type: 'access', sv: u.sessionVersion },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        issuer: 'mandaria',
        audience: 'mandaria-users',
        expiresIn: 3600,
        algorithm: 'HS256',
      },
    );
}
const tables = [
  'DeliveryRequest',
  'DeliveryQuote',
  'DeliveryShippingTerms',
  'PrequoteConversion',
  'DirectRequestLifecycle',
  'AuthorizedQuoteAcceptance',
  'CreditAccount',
  'CreditLedgerEntry',
  'DispatchCreditSnapshot',
  'B2bOutboxEvent',
  'ApiIdempotencyRecord',
];
async function hashes() {
  const result = {};
  for (const table of tables) {
    const [r] = await db.$queryRawUnsafe(
      `SELECT count(*)::int n, md5(COALESCE(string_agg(to_jsonb(t)::text,',' ORDER BY to_jsonb(t)::text),'')) hash FROM "${table}" t`,
    );
    result[table] = r;
  }
  return result;
}
try {
  await boot();
  const old = await db.deliveryPrequote.findFirst({
    where: {
      customerAccountId: { not: null },
      customerAccount: { type: 'BUSINESS', businessAccessState: 'ACTIVE' },
    },
    orderBy: { issuedAt: 'desc' },
  });
  assert.ok(old, 'Business delivery fixture from direct-demand suite required');
  await db.serviceZone.updateMany({
    where: { id: { not: old.serviceZoneId } },
    data: { status: 'INACTIVE' },
  });
  await db.serviceZone.update({
    where: { id: old.serviceZoneId },
    data: { status: 'ACTIVE' },
  });
  const c = await db.customerAccount.findUniqueOrThrow({
    where: { id: old.customerAccountId },
  });
  let t = await token(c.userId);
  const q = await api()
    .post('/api/v1/customer/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ conditions: old.conditions, shippingPayer: 'RECIPIENT' });
  if (q.status !== 201)
    throw Error('Fixture prequote: ' + q.status + ' ' + q.body.code);
  const convertBody = {
    conditionsVersion: 1,
    deliveryRequest: {
      serviceType: 'LOCAL_DELIVERY',
      externalReference: 'Migration synthetic',
      stops: old.conditions.stops.map((s) => ({
        ...s,
        address: 'Synthetic street',
        contactName: 'Synthetic contact',
        contactPhone: '0000000000',
      })),
      packages: [
        { category: 'PARCEL', quantity: 1, description: 'Synthetic parcel' },
      ],
      financialContext: { goodsPaymentMode: 'PREPAID', currency: 'MXN' },
    },
    payerContact: {
      name: 'Synthetic payer',
      phone: '0000000000',
      capacity: 'AUTHORIZED_REPRESENTATIVE',
    },
  };
  const result = (
    await api()
      .post(
        '/api/v1/customer/delivery-prequotes/' +
          q.body.prequote.publicId +
          '/convert',
      )
      .auth(t, { type: 'bearer' })
      .set('Idempotency-Key', randomUUID())
      .send(convertBody)
      .expect(201)
  ).body.result;
  await app.close();
  app = null;
  await db.$disconnect();
  const clone = 'mandaria_business_' + runId + '_upgrade_test',
    clean = 'mandaria_business_' + runId + '_clean_test';
  run(pg + '/createdb.exe', [
    '-h',
    '127.0.0.1',
    '-p',
    base.port,
    '-U',
    'postgres',
    '-T',
    base.pathname.slice(1),
    clone,
  ]);
  process.env.DATABASE_URL = e.url.replace(base.pathname, '/' + clone);
  db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  // Reconstruct the 45-migration schema in a disposable clone only. Production/history is untouched.
  const functions =
    await db.$queryRaw`SELECT proname FROM pg_proc JOIN pg_namespace n ON n.oid=pronamespace WHERE n.nspname='public' AND proname LIKE 'business_%'`;
  for (const f of functions)
    await db.$executeRawUnsafe(`DROP FUNCTION "${f.proname}"() CASCADE`);
  for (const table of [
    'BusinessAdmissionEvidence',
    'BusinessAccessEvent',
    'BusinessCommandReceipt',
    'BusinessAccessGrant',
    'BusinessApplication',
    'BusinessPolicyCutover',
  ])
    await db.$executeRawUnsafe(`DROP TABLE "${table}" CASCADE`);
  await db.$executeRawUnsafe(
    'ALTER TABLE "CustomerAccount" DROP COLUMN "businessAccessState", DROP COLUMN "businessReapplicationBlockedByGrantId"',
  );
  await db.$executeRawUnsafe(
    `DELETE FROM "_prisma_migrations" WHERE migration_name='20261012000100_business_approval'`,
  );
  const before = await hashes();
  const accountsBefore =
    await db.$queryRaw`SELECT id,revision,type FROM "CustomerAccount"`;
  await db.$disconnect();
  const env = {
    ...process.env,
    DATABASE_URL: 'postgresql://unused@127.0.0.1:1/unused',
    TEST_DATABASE_URL: e.url.replace(base.pathname, '/' + clone),
  };
  run(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
    env,
  );
  db = new PrismaClient({ datasourceUrl: env.TEST_DATABASE_URL });
  assert.deepEqual(await hashes(), before);
  for (const account of accountsBefore) {
    const next = await db.customerAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    assert.equal(
      next.businessAccessState,
      account.type === 'BUSINESS' ? 'REVIEW_REQUIRED' : 'NONE',
    );
    assert.equal(
      next.revision,
      account.revision + (account.type === 'BUSINESS' ? 1 : 0),
    );
  }
  assert.equal(await db.businessApplication.count(), 0);
  assert.equal(await db.businessAccessGrant.count(), 0);
  const mdr = await db.deliveryRequest.findUniqueOrThrow({
    where: { publicId: result.deliveryRequestPublicId },
  });
  assert.equal(
    (
      await db.businessAdmissionEvidence.findUniqueOrThrow({
        where: { deliveryRequestId: mdr.id },
      })
    ).basis,
    'PRE_REVIEW_COMMITMENT',
  );
  await boot();
  t = await token(c.userId);
  const cap = (
    await api()
      .get('/api/v1/customer/capabilities')
      .auth(t, { type: 'bearer' })
      .expect(200)
  ).body;
  assert.equal(cap.canPrequote, false);
  assert.equal(cap.canCreateRequest, false);
  const blocked = await api()
    .post('/api/v1/customer/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({ conditions: old.conditions, shippingPayer: 'RECIPIENT' })
    .expect(409);
  assert.equal(blocked.body.code, 'BUSINESS_REVIEW_REQUIRED');
  const accepted = await api()
    .post(
      '/api/v1/customer/delivery-quotes/' + result.quote.publicId + '/accept',
    )
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', randomUUID())
    .send({
      customerAuthorization: {
        version: 1,
        status: 'AUTHORIZED_BY_CUSTOMER',
        reference: 'Synthetic migration consent',
        authorizedAt: new Date().toISOString(),
        quotePublicId: result.quote.publicId,
        amount: result.quote.amount,
        currency: result.quote.currency,
        expiresAt: result.quote.expiresAt,
        shippingTermsVersion: 1,
        shippingTermsHash: result.shippingTerms.termsHash,
      },
    })
    .expect(200);
  assert.ok(accepted.body);
  await app.close();
  app = null;
  await db.$disconnect();
  run(pg + '/createdb.exe', [
    '-h',
    '127.0.0.1',
    '-p',
    base.port,
    '-U',
    'postgres',
    clean,
  ]);
  run(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
      '--config',
      'prisma.test.config.ts',
    ],
    { ...env, TEST_DATABASE_URL: e.url.replace(base.pathname, '/' + clean) },
  );
  const report = {
    cleanMigrations: 46,
    upgradeBaseline: 'Disposable clone reconstructed to schema45',
    upgradeAccounts: accountsBefore.length,
    preservedTables: before,
    legacyApplicationCount: 0,
    legacyGrantCount: 0,
    committedAcceptance: 200,
    newDemandBlocked: 'BUSINESS_REVIEW_REQUIRED',
    migrationSha256: createHash('sha256')
      .update(
        readFileSync(
          'prisma/migrations/20261012000100_business_approval/migration.sql',
        ),
      )
      .digest('hex'),
  };
  writeFileSync(
    e.root + '/migration-result.json',
    JSON.stringify(report, null, 2),
  );
  console.log(
    'PASS clean46, reconstructed45 upgrade, 11 table fingerprints, committed acceptance and blocked new demand',
  );
} finally {
  await app?.close();
  await db.$disconnect();
  closeSync(log);
}
