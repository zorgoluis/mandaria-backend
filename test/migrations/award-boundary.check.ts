import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';

import type { INestApplication } from '@nestjs/common';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from '../support/credit-policies.js';
import { setProviderBalance } from '../support/credits.js';
import { preBoundaryPrismaClient } from './pre-boundary-client.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.JWT_ACCESS_EXPIRES_IN = '3600';
process.env.INTEGRATION_ACCESS_TOKEN_EXPIRES_IN = '3600';
process.env.DISPATCH_TTL_MINUTES = '60';
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = await preBoundaryPrismaClient(databaseUrl);
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_CCON_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credit-consumption.test`.toLowerCase();
let backendEntry = '.tmp/check-v110d/previous-b/dist/main.js';
const logs: string[] = [];
/** Routing spy: fixed canonical distance, and a counter to prove awards never route. */
const routing = {
  distanceMeters: 6240,
  get calls() {
    return logs.filter((l) => l.includes('CHECK_ROUTING_CALL')).length;
  },
};
const ZONE = { lng: -93.25, lat: 16.25 };
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const userIds: string[] = [];
let app: INestApplication;
let baseUrl = '';
const api = () => request(baseUrl);
const bearer = { type: 'bearer' } as const;
const POLICIES = '/api/v1/admin/credit-policies';

async function bootstrap() {
  const child = spawn(process.execPath, [backendEntry], {
    env: {
      ...process.env,
      PORT: '3028',
      ROUTING_PROVIDER: 'local_fake',
      MANDARIA_WEB_URL: 'http://localhost:5173',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let pending = '';
  child.stdout.on('data', (c) => {
    pending += c.toString();
    const rows = pending.split('\n');
    pending = rows.pop()!;
    logs.push(...rows.filter(Boolean));
  });
  child.stderr.on('data', (c) => logs.push(c.toString()));
  baseUrl = 'http://127.0.0.1:3028';
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(baseUrl + '/health');
      if (r.ok)
        return {
          close: async () => {
            if (child.exitCode !== null || child.signalCode !== null) return;
            child.kill();
            await new Promise((resolve) => child.once('exit', resolve));
          },
        } as unknown as INestApplication;
    } catch {
      /* Backend is still starting. */
    }
    if (child.exitCode !== null) throw new Error('Backend startup failed');
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('Backend startup timed out');
}
const perKm = (creditsPerKm: number, minimumCredits = 3) => ({
  calculationType: 'PER_KM',
  creditsPerKm,
  minimumCredits,
});
async function setPolicy(
  actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER',
  body: object,
) {
  const active = await prisma.creditPolicy.findFirst({
    where: { serviceType: 'LOCAL_DELIVERY', actorType, status: 'ACTIVE' },
  });
  const res = active
    ? await api()
        .post(`${POLICIES}/${active.id}/versions`)
        .auth(t.sa, bearer)
        .send(body)
    : await api()
        .post(POLICIES)
        .auth(t.sa, bearer)
        .send({ serviceType: 'LOCAL_DELIVERY', actorType, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number };
}
async function openDispatch(distanceMeters = 6240) {
  routing.distanceMeters = distanceMeters;
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9615557788',
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `CCON-${run}`,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [{ category: 'FOOD', description: 'Pedido', quantity: 1 }],
      financialContext: {
        goodsValue: '800.00',
        goodsPaymentMode: 'COURIER_ADVANCE',
        currency: 'MXN',
      },
    })
    .expect(201);
  const quote = await api()
    .post(`/api/v1/delivery-requests/${req.body.publicId}/quotes`)
    .auth(t.b2b, bearer)
    .expect(201);
  await api()
    .post(`/api/v1/delivery-quotes/${quote.body.publicId}/accept`)
    .auth(t.b2b, bearer)
    .expect(200);
  const row = await prisma.deliveryQuote.findUniqueOrThrow({
    where: { publicId: quote.body.publicId },
  });
  const dispatch = await prisma.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: row.id },
  });
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
}
const claim = (token: string, dispatchId: string) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/claim`)
    .auth(token, bearer);
const take = (token: string, dispatchId: string, vehicleId = ids.vehicle) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
const awardsOf = (dispatchId: string) =>
  prisma.creditLedgerEntry.findMany({
    where: { type: 'SERVICE_AWARD', referenceId: dispatchId },
    orderBy: { sequence: 'asc' },
  });
const economy = async () => ({
  accounts: await prisma.creditAccount.findMany({
    select: { id: true, balance: true },
    orderBy: { id: 'asc' },
  }),
  entries: await prisma.creditLedgerEntry.count(),
});

beforeAll(async () => {
  await ensureTestCreditPolicies(prisma);
  const passwordHash = await argon2.hash(password);
  const user = async (
    name: string,
    role: 'SUPER_ADMIN' | 'PROVIDER_ADMIN' | 'DRIVER',
  ) => {
    const u = await prisma.user.create({
      data: { email: mail(name), passwordHash, role },
    });
    userIds.push(u.id);
    return u.id;
  };
  ids.sa = await user('sa', 'SUPER_ADMIN');
  for (const key of ['A', 'B'] as const) {
    const provider = await prisma.deliveryProvider.create({
      data: {
        name: `CCON ${key} ${run}`,
        code: `${PREFIX}${key}_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 50,
        maxVehicles: 50,
      },
    });
    ids[`provider${key}`] = provider.id;
    await prisma.providerMembership.create({
      data: {
        providerId: provider.id,
        userId: await user(`admin${key}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  ids.driver = (
    await prisma.driver.create({
      data: {
        providerId: ids.providerA,
        userId: await user('indep', 'DRIVER'),
        name: 'indep',
        status: 'ACTIVE',
      },
    })
  ).id;
  await prisma.serviceZone.updateMany({
    where: { code: { startsWith: PREFIX }, status: 'ACTIVE' },
    data: { status: 'INACTIVE' },
  });
  app = await bootstrap();
  const login = async (name: string) =>
    (
      await api()
        .post('/api/v1/auth/login')
        .send({ email: mail(name), password })
        .expect(200)
    ).body.accessToken as string;
  t.sa = await login('sa');
  t.A = await login('adminA');
  t.B = await login('adminB');
  await api()
    .post(`/api/v1/admin/drivers/${ids.driver}/independent`)
    .auth(t.sa, bearer)
    .send({})
    .expect(200);
  t.indep = await login('indep');
  ids.vehicle = (
    await api()
      .post(`/api/v1/admin/drivers/${ids.driver}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `CC-${run}`, type: 'MOTORCYCLE' })
      .expect(201)
  ).body.id;
  const zone = await api()
    .post('/api/v1/admin/service-zones')
    .auth(t.sa, bearer)
    .send({
      code: `${PREFIX}ZONE_${run}`,
      name: `Zona ${run}`,
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [ZONE.lng, ZONE.lat],
            [ZONE.lng + 0.1, ZONE.lat],
            [ZONE.lng + 0.1, ZONE.lat + 0.1],
            [ZONE.lng, ZONE.lat + 0.1],
            [ZONE.lng, ZONE.lat],
          ],
        ],
      },
    })
    .expect(201);
  ids.zone = zone.body.id;
  await api()
    .post(`/api/v1/admin/service-zones/${ids.zone}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  const plan = await api()
    .post('/api/v1/admin/rate-plans')
    .auth(t.sa, bearer)
    .send({
      serviceZoneId: ids.zone,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 60,
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '60' },
      ],
    })
    .expect(201);
  await api()
    .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  for (const key of ['A', 'B'] as const)
    await api()
      .post(
        `/api/v1/admin/providers/${ids[`provider${key}`]}/service-coverages`,
      )
      .auth(t.sa, bearer)
      .send({ serviceZoneId: ids.zone, serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Credit consumption client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  ids.client = client.body.id;
  const credential = await api()
    .post(`/api/v1/admin/integrations/${ids.client}/credentials`)
    .auth(t.sa, bearer)
    .send({
      scopes: [
        'deliveries:create',
        'deliveries:read',
        'deliveries:cancel',
        'quotes:create',
        'quotes:read',
        'quotes:accept',
      ],
    })
    .expect(201);
  t.b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  // 6240 m: provider 7 credits (1/km), independent 14 (2/km), minimum 3.
  await setPolicy('PROVIDER', perKm(1));
  await setPolicy('INDEPENDENT_DRIVER', perKm(2));
  await app.close();
}, 180000);

afterAll(async () => {
  await app?.close();
  writeFileSync('.tmp/check-v110d/migration-backend.log', logs.join('\n'));
  await prisma.$disconnect();
}, 120000);

async function applyMigration(name: string) {
  const url = new URL(process.env.DATABASE_URL!);
  const env = {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: url.pathname.slice(1),
  };
  const r = spawnSync(
    process.env.PSQL_PATH ?? 'C:/Program Files/PostgreSQL/18/bin/psql.exe',
    [
      '-X',
      '-w',
      '-v',
      'ON_ERROR_STOP=1',
      '-f',
      'prisma/migrations/' + name + '/migration.sql',
    ],
    { env, encoding: 'utf8' },
  );
  expect(r.status, 'migration SQL failed').toBe(0);
  const resolved = spawnSync(
    process.execPath,
    [
      'node_modules/prisma/build/index.js',
      'migrate',
      'resolve',
      '--applied',
      name,
    ],
    { env, encoding: 'utf8' },
  );
  expect(resolved.status).toBe(0);
}
it('43 authentic B legacy and C priced OPEN/CLAIMED migrate to D preserving history', async () => {
  app = await bootstrap();
  const legacy = await openDispatch();
  await app.close();
  await applyMigration('20260922001400_dispatch_credit_snapshots');
  backendEntry = '.tmp/check-v110d/previous-c/dist/main.js';
  app = await bootstrap();
  const open = await openDispatch();
  const claimed = await openDispatch();
  await claim(t.B, claimed.id).expect(200);
  const taken = await openDispatch();
  await take(t.indep, taken.id).expect(200);
  const snapshots = await prisma.dispatchCreditSnapshot.findMany({
    orderBy: { id: 'asc' },
  });
  const before = await economy();
  const beforeDispatches = await prisma.dispatch.findMany({
    orderBy: { id: 'asc' },
  });
  await app.close();
  await applyMigration('20260923000100_dispatch_credit_consumption');
  await applyMigration('20260923000200_award_integrity_boundary');
  const migrated = await prisma.$queryRawUnsafe(
    'SELECT id,"creditMode",status FROM "Dispatch" ORDER BY id',
  );
  expect(await economy()).toEqual(before);
  expect(
    await prisma.dispatchCreditSnapshot.findMany({ orderBy: { id: 'asc' } }),
  ).toEqual(snapshots);
  const afterDispatches = await prisma.dispatch.findMany({
    orderBy: { id: 'asc' },
  });
  expect(afterDispatches).toEqual(beforeDispatches);
  backendEntry = 'dist/main.js';
  app = await bootstrap();
  await claim(t.A, legacy.id).expect(200);
  expect(await awardsOf(legacy.id)).toHaveLength(0);
  expect(logs.some((l) => l.includes('LEGACY_DISPATCH_CREDIT_SKIPPED'))).toBe(
    true,
  );
  await setProviderBalance(prisma, ids.providerA, 7);
  await claim(t.A, open.id).expect(200);
  expect((await awardsOf(open.id))[0].amount).toBe(-7);
  const retry = await claim(t.B, claimed.id);
  const cAwards = await awardsOf(claimed.id);
  const tAwards = await awardsOf(taken.id);
  const report = {
    migrated,
    legacy: { id: legacy.id, awards: (await awardsOf(legacy.id)).length },
    newAward: { id: open.id, amount: (await awardsOf(open.id))[0].amount },
    preDClaim: {
      id: claimed.id,
      retryStatus: retry.status,
      awards: cAwards.length,
    },
    preDTake: { id: taken.id, awards: tAwards.length },
    historyPreserved: true,
  };
  writeFileSync(
    '.tmp/check-v110d/migration-evidence.json',
    JSON.stringify(report, null, 2),
  );
  expect(retry.status).toBe(200);
  expect(cAwards).toHaveLength(0);
  expect(tAwards).toHaveLength(0);
  expect(retry.body.creditEnforcementMode).toBe('PRE_ENFORCEMENT_AWARD');
  const independentView = await api()
    .get('/api/v1/driver/dispatches/' + taken.id)
    .auth(t.indep, bearer)
    .expect(200);
  expect(independentView.body.creditEnforcementMode).toBe(
    'PRE_ENFORCEMENT_AWARD',
  );
  const assignmentsBefore = await prisma.deliveryAssignment.findMany({
    where: { dispatchId: taken.id },
  });
  const economyBefore = await economy();
  await take(t.indep, taken.id).expect(409);
  expect(await economy()).toEqual(economyBefore);
  expect(
    await prisma.deliveryAssignment.findMany({
      where: { dispatchId: taken.id },
    }),
  ).toEqual(assignmentsBefore);
  expect(logs.some((l) => l.includes('PRE_ENFORCEMENT_AWARD'))).toBe(true);
  const historical = await prisma.$queryRawUnsafe(
    'SELECT * FROM "DispatchPreEnforcementAward" ORDER BY "actorType"',
  );
  expect(historical).toHaveLength(2);
  expect(
    await prisma.$queryRawUnsafe(
      'SELECT "assert_dispatch_award_integrity"(id)::text FROM "Dispatch"',
    ),
  ).toHaveLength(4);
  await api()
    .post('/api/v1/provider/dispatches/' + claimed.id + '/release')
    .auth(t.B, bearer)
    .send({ reason: 'Historical award release' })
    .expect(200);
  const reopened = await api()
    .get('/api/v1/provider/dispatches/' + claimed.id)
    .auth(t.A, bearer)
    .expect(200);
  expect(reopened.body.creditEnforcementMode).toBe('ENFORCED');
  await setProviderBalance(prisma, ids.providerA, 7);
  const later = await claim(t.A, claimed.id).expect(200);
  expect(later.body.creditEnforcementMode).toBe('ENFORCED');
  expect((await awardsOf(claimed.id))[0].amount).toBe(-7);
  await api()
    .post('/api/v1/driver/dispatches/' + taken.id + '/release')
    .auth(t.indep, bearer)
    .send({ reason: 'OPERATIONAL_ISSUE' })
    .expect(200);
  await setProviderBalance(prisma, ids.providerB, 7);
  await claim(t.B, taken.id).expect(200);
  expect((await awardsOf(taken.id))[0].amount).toBe(-7);
  expect(
    await prisma.$queryRawUnsafe(
      'SELECT * FROM "DispatchPreEnforcementAward" ORDER BY "actorType"',
    ),
  ).toEqual(historical);
  expect(
    await prisma.$queryRawUnsafe(
      'SELECT "assert_dispatch_award_integrity"(id)::text FROM "Dispatch"',
    ),
  ).toHaveLength(4);
  writeFileSync(
    '.tmp/check-v110d/migration-evidence.json',
    JSON.stringify(
      {
        ...report,
        historical,
        providerClassification: retry.body.creditEnforcementMode,
        independentClassification: independentView.body.creditEnforcementMode,
        noRetroactiveDebit: true,
        scanViolations: 0,
        releaseThenNewAwardCharged: true,
      },
      null,
      2,
    ),
  );
}, 180000);
