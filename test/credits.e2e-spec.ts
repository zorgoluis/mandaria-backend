import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';

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
process.env.LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES = '5';
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_CRED_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credits.test`.toLowerCase();
const logs: string[] = [];
const capture = (...args: unknown[]) => void logs.push(JSON.stringify(args));
const logger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};
const routing = {
  name: 'fake',
  async calculateRoute() {
    return {
      distanceMeters: 4200,
      durationSeconds: 700,
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
const ZONE = { lng: -99.5, lat: 22.5 };
const providers: Record<string, string> = {};
const drivers: Record<string, string> = {};
const userIds: string[] = [];
const clientIds: string[] = [];
const t: Record<string, string> = {};
let zoneId = '';
let carlosVehicle = '';
let app: INestApplication;
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;
const key = () => `e2e-${randomUUID()}`;

async function bootstrap() {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue(routing)
    .setLogger(logger)
    .compile();
  const instance = moduleRef.createNestApplication({
    logger,
    bodyParser: false,
  });
  setup(instance);
  await instance.init();
  return instance;
}
/** A fresh app per block resets the in-memory throttler (100/min, 5 logins/min per IP). */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}

const adminProvider = (providerId: string, suffix = '') =>
  `/api/v1/admin/providers/${providerId}/credits${suffix}`;
const adminDriver = (driverId: string, suffix = '') =>
  `/api/v1/admin/drivers/${driverId}/independent/credits${suffix}`;
const recharge = (
  path: string,
  body: object,
  idempotencyKey: string | null = key(),
  token = t.sa,
) => {
  const req = api().post(`${path}/recharge`).auth(token, bearer);
  if (idempotencyKey !== null) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};
const adjust = (
  path: string,
  body: object,
  idempotencyKey: string | null = key(),
  token = t.sa,
) => {
  const req = api().post(`${path}/adjustment`).auth(token, bearer);
  if (idempotencyKey !== null) req.set('Idempotency-Key', idempotencyKey);
  return req.send(body);
};
const accountOf = (providerId: string) =>
  prisma.creditAccount.findUniqueOrThrow({ where: { providerId } });
const entriesOf = (creditAccountId: string) =>
  prisma.creditLedgerEntry.findMany({
    where: { creditAccountId },
    orderBy: { sequence: 'asc' },
  });
/** Every entry closes arithmetically, links to the next one, and the last matches the account. */
async function chainIsConsistent(creditAccountId: string) {
  const entries = await entriesOf(creditAccountId);
  const account = await prisma.creditAccount.findUniqueOrThrow({
    where: { id: creditAccountId },
  });
  const problems: string[] = [];
  entries.forEach((e, i) => {
    if (e.balanceBefore + e.amount !== e.balanceAfter)
      problems.push(`#${e.sequence} arithmetic`);
    if (i > 0 && entries[i - 1].balanceAfter !== e.balanceBefore)
      problems.push(`#${e.sequence} breaks the chain`);
  });
  const last = entries.at(-1);
  if ((last?.balanceAfter ?? 0) !== account.balance)
    problems.push('last balanceAfter differs from the account balance');
  if (entries.length && entries[0].balanceBefore !== 0)
    problems.push('history does not start at zero');
  return { problems, entries, balance: account.balance };
}

async function openDispatch() {
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9614440000',
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
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
  return (
    await prisma.dispatch.findUniqueOrThrow({
      where: { deliveryQuoteId: row.id },
    })
  ).id;
}

beforeAll(async () => {
  // V1.10-C: accepting a quote opens a Dispatch, which needs ACTIVE credit policies.
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
  await user('sa', 'SUPER_ADMIN');
  for (const k of ['A', 'B'] as const) {
    // Created straight in the database, like any seed: the trigger must still give it an account.
    const p = await prisma.deliveryProvider.create({
      data: {
        name: `Proveedor ${k} ${run}`,
        code: `${PREFIX}${k}_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 10,
        maxVehicles: 10,
      },
    });
    providers[k] = p.id;
    await prisma.providerMembership.create({
      data: {
        providerId: p.id,
        userId: await user(`admin${k}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  for (const name of ['carlos', 'pedro', 'luis']) {
    const d = await prisma.driver.create({
      data: {
        providerId: providers.A,
        userId: await user(name, 'DRIVER'),
        name,
        status: 'ACTIVE',
      },
    });
    drivers[name] = d.id;
  }
  await prisma.serviceZone.updateMany({
    where: { code: { startsWith: PREFIX }, status: 'ACTIVE' },
    data: { status: 'INACTIVE' },
  });
  app = await bootstrap();
  const login = async (email: string) =>
    (
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).body.accessToken as string;
  t.sa = await login(mail('sa'));
  t.A = await login(mail('adminA'));
  t.B = await login(mail('adminB'));
  t.carlos = await login(mail('carlos'));
  t.luis = await login(mail('luis'));
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
  zoneId = zone.body.id;
  await api()
    .post(`/api/v1/admin/service-zones/${zoneId}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  const plan = await api()
    .post('/api/v1/admin/rate-plans')
    .auth(t.sa, bearer)
    .send({
      serviceZoneId: zoneId,
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
  for (const k of ['A', 'B'] as const)
    await api()
      .post(`/api/v1/admin/providers/${providers[k]}/service-coverages`)
      .auth(t.sa, bearer)
      .send({ serviceZoneId: zoneId, serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Credits client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  clientIds.push(client.body.id);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(t.sa, bearer)
    .send({
      scopes: [
        'deliveries:create',
        'deliveries:read',
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
  await app.close();
}, 180000);

afterAll(async () => {
  const providerIds = Object.values(providers);
  const driverIds = Object.values(drivers);
  const accounts = await prisma.creditAccount.findMany({
    where: {
      OR: [
        { providerId: { in: providerIds } },
        { independentDriverProfile: { driverId: { in: driverIds } } },
      ],
    },
    select: { id: true },
  });
  // The ledger refuses DELETE; this test-only switch is the one documented exception.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.creditLedgerEntry.deleteMany({
      where: { creditAccountId: { in: accounts.map((a) => a.id) } },
    }),
  ]);
  await prisma.deliveryAssignment.deleteMany({
    where: { driverId: { in: driverIds } },
  });
  await prisma.deliveryQuote.deleteMany({
    where: {
      OR: [
        ...(zoneId ? [{ serviceZoneId: zoneId }] : []),
        { deliveryRequest: { integrationClientId: { in: clientIds } } },
      ],
    },
  });
  await prisma.deliveryRequest.deleteMany({
    where: { integrationClientId: { in: clientIds } },
  });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: { in: clientIds } },
  });
  await prisma.providerServiceCoverage.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  if (zoneId) {
    await prisma.rateBand.deleteMany({
      where: { ratePlan: { serviceZoneId: zoneId } },
    });
    await prisma.ratePlan.deleteMany({ where: { serviceZoneId: zoneId } });
    await prisma.serviceZone.deleteMany({ where: { id: zoneId } });
  }
  await prisma.vehicle.deleteMany({
    where: { independentDriverProfile: { driverId: { in: driverIds } } },
  });
  await prisma.independentDriverProfile.deleteMany({
    where: { driverId: { in: driverIds } },
  });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.providerMembership.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationCredential.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: clientIds } },
  });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}, 120000);

describe('V1.10-A account ownership', () => {
  withApp();

  it('every provider has exactly one empty account from birth, however it was created', async () => {
    for (const id of [providers.A, providers.B]) {
      expect(
        await prisma.creditAccount.count({ where: { providerId: id } }),
      ).toBe(1);
      const account = await accountOf(id);
      expect(account).toMatchObject({ ownerType: 'PROVIDER', balance: 0 });
      expect(account.independentDriverProfileId).toBeNull();
      // An empty account carries no invented movement.
      expect(
        await prisma.creditLedgerEntry.count({
          where: { creditAccountId: account.id },
        }),
      ).toBe(0);
    }
    const created = await api()
      .post('/api/v1/admin/providers')
      .auth(t.sa, bearer)
      .send({
        name: `Via API ${run}`,
        code: `${PREFIX}API_${run}`,
        type: 'FLEET',
      })
      .expect(201);
    providers.api = created.body.id;
    const res = await api()
      .get(adminProvider(providers.api))
      .auth(t.sa, bearer)
      .expect(200);
    expect(res.body).toMatchObject({
      ownerType: 'PROVIDER',
      providerId: providers.api,
      balance: 0,
    });
    expect(res.body.independentDriverProfileId).toBeNull();
    // Integer credits, never money.
    expect(JSON.stringify(res.body)).not.toMatch(/currency|MXN/);
  });

  it('an independent driver gets one account when approved, keeps it, and never a second', async () => {
    await api().get(adminDriver(drivers.carlos)).auth(t.sa, bearer).expect(404);
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    const account = await api()
      .get(adminDriver(drivers.carlos))
      .auth(t.sa, bearer)
      .expect(200);
    expect(account.body).toMatchObject({
      ownerType: 'INDEPENDENT_DRIVER',
      balance: 0,
      providerId: null,
    });
    // Suspension keeps the account; approving again does not create another.
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Revision' })
      .expect(200);
    await api().get(adminDriver(drivers.carlos)).auth(t.sa, bearer).expect(200);
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
      where: { driverId: drivers.carlos },
    });
    expect(
      await prisma.creditAccount.count({
        where: { independentDriverProfileId: profile.id },
      }),
    ).toBe(1);
    await api()
      .post(`/api/v1/admin/drivers/${drivers.pedro}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
  });

  it('a fleet driver has no personal account and cannot read the provider one as its own', async () => {
    const res = await api()
      .get('/api/v1/driver/credits')
      .auth(t.luis, bearer)
      .expect(404);
    expect(res.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    await api().get(adminDriver(drivers.luis)).auth(t.sa, bearer).expect(404);
    expect(
      await prisma.creditAccount.count({
        where: { independentDriverProfile: { driverId: drivers.luis } },
      }),
    ).toBe(0);
  });
});

describe('V1.10-A recharge and adjustment', () => {
  withApp();

  it('a recharge is one attributable RECHARGE entry and moves the balance', async () => {
    const res = await recharge(adminProvider(providers.A), {
      credits: 500,
      method: 'TRANSFER',
      externalReference: 'SPEI 00012345',
    }).expect(201);
    expect(res.headers['idempotent-replayed']).toBe('false');
    expect(res.body.account.balance).toBe(500);
    expect(res.body.entry).toMatchObject({
      type: 'RECHARGE',
      amount: 500,
      balanceBefore: 0,
      balanceAfter: 500,
      rechargeMethod: 'TRANSFER',
      externalReference: 'SPEI 00012345',
      createdByUserId: userIds[0],
    });
    const account = await accountOf(providers.A);
    expect(account.balance).toBe(500);
    const [entry] = await entriesOf(account.id);
    expect(entry.createdByUserId).toBe(userIds[0]);
  });

  it('the same Idempotency-Key replays; a different body with it is refused', async () => {
    const k = key();
    const body = { credits: 40, method: 'CASH' };
    const first = await recharge(adminProvider(providers.A), body, k).expect(
      201,
    );
    const again = await recharge(adminProvider(providers.A), body, k).expect(
      200,
    );
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body.entry.id).toBe(first.body.entry.id);
    expect(again.body.account.balance).toBe(540);
    const conflict = await recharge(
      adminProvider(providers.A),
      { credits: 41, method: 'CASH' },
      k,
    ).expect(409);
    expect(conflict.body.code).toBe('CREDIT_IDEMPOTENCY_CONFLICT');
    // Reusing a recharge key for an adjustment is also a different request.
    const crossed = await adjust(
      adminProvider(providers.A),
      { amount: 40, reason: 'Mismo key' },
      k,
    ).expect(409);
    expect(crossed.body.code).toBe('CREDIT_IDEMPOTENCY_CONFLICT');
    expect((await accountOf(providers.A)).balance).toBe(540);
    expect(
      await prisma.creditLedgerEntry.count({ where: { idempotencyKey: k } }),
    ).toBe(1);
  });

  it('requires a valid Idempotency-Key and a reason for OTHER', async () => {
    await recharge(
      adminProvider(providers.A),
      { credits: 1, method: 'CASH' },
      null,
    ).expect(400);
    await recharge(
      adminProvider(providers.A),
      { credits: 1, method: 'CASH' },
      'short',
    ).expect(400);
    await recharge(adminProvider(providers.A), {
      credits: 1,
      method: 'OTHER',
    }).expect(400);
    await recharge(adminProvider(providers.A), {
      credits: 1,
      method: 'OTHER',
      reason: 'Canje de cortesia',
    }).expect(201);
  });

  it('adjusts in both directions but never to a negative balance', async () => {
    const path = adminProvider(providers.A);
    const before = (await accountOf(providers.A)).balance;
    const up = await adjust(path, {
      amount: 50,
      reason: 'Bonificacion',
    }).expect(201);
    expect(up.body.entry).toMatchObject({
      type: 'ADMIN_ADJUSTMENT',
      amount: 50,
      reason: 'Bonificacion',
    });
    const down = await adjust(path, {
      amount: -20,
      reason: 'Correccion',
    }).expect(201);
    expect(down.body.account.balance).toBe(before + 30);
    const count = (await entriesOf((await accountOf(providers.A)).id)).length;
    const overdraw = await adjust(path, {
      amount: -(before + 31),
      reason: 'Excesivo',
    }).expect(409);
    expect(overdraw.body.code).toBe('INSUFFICIENT_CREDITS');
    expect((await accountOf(providers.A)).balance).toBe(before + 30);
    expect((await entriesOf((await accountOf(providers.A)).id)).length).toBe(
      count,
    );
  });

  it('rejects zero, decimals, text, absurd amounts and forged ownership fields', async () => {
    const path = adminProvider(providers.A);
    for (const amount of [0, 1.5, '10', 1000001, -1000001, null])
      await adjust(path, { amount, reason: 'Invalido' }).expect(400);
    await adjust(path, { amount: 5 }).expect(400);
    for (const credits of [0, -5, 7.25, 0.01, '500', 2147483648])
      await recharge(path, { credits, method: 'CASH' }).expect(400);
    for (const forged of [
      { ownerType: 'INDEPENDENT_DRIVER' },
      { providerId: providers.B },
      { balance: 999999 },
      { creditAccountId: randomUUID() },
      { createdByUserId: randomUUID() },
    ])
      await recharge(path, { credits: 5, method: 'CASH', ...forged }).expect(
        400,
      );
    const newline = String.fromCharCode(10);
    await recharge(path, {
      credits: 5,
      method: 'CASH',
      externalReference: `SPEI${newline}{"event":"FAKE"}`,
    }).expect(400);
    // Provider B was never touched by any of this.
    expect((await accountOf(providers.B)).balance).toBe(0);
  });

  it('manages the independent account through the /independent route', async () => {
    const res = await recharge(adminDriver(drivers.carlos), {
      credits: 30,
      method: 'CASH',
    }).expect(201);
    expect(res.body.account).toMatchObject({
      ownerType: 'INDEPENDENT_DRIVER',
      balance: 30,
    });
    await adjust(adminDriver(drivers.carlos), {
      amount: -10,
      reason: 'Correccion',
    }).expect(201);
    const account = await api()
      .get(adminDriver(drivers.carlos))
      .auth(t.sa, bearer)
      .expect(200);
    expect(account.body.balance).toBe(20);
    // A fleet driver or an unknown one has no account to recharge.
    await recharge(adminDriver(drivers.luis), {
      credits: 5,
      method: 'CASH',
    }).expect(404);
    await recharge(adminDriver(randomUUID()), {
      credits: 5,
      method: 'CASH',
    }).expect(404);
    await recharge(adminProvider(randomUUID()), {
      credits: 5,
      method: 'CASH',
    }).expect(404);
  });
});

describe('V1.10-A authorization and isolation', () => {
  withApp();

  it('PROVIDER_ADMIN reads only its own account and history, and cannot move credits', async () => {
    const mine = await api()
      .get('/api/v1/provider/credits')
      .auth(t.A, bearer)
      .expect(200);
    expect(mine.body.providerId).toBe(providers.A);
    const ledger = await api()
      .get('/api/v1/provider/credits/ledger')
      .auth(t.A, bearer)
      .expect(200);
    expect(ledger.body.items.length).toBeGreaterThan(0);
    for (const item of ledger.body.items) {
      expect(item).not.toHaveProperty('createdByUserId');
      expect(item).not.toHaveProperty('idempotencyKey');
      expect(item).not.toHaveProperty('requestHash');
    }
    // No mutation route exists for providers, and the admin ones are closed to them.
    await api()
      .post('/api/v1/provider/credits/recharge')
      .auth(t.A, bearer)
      .send({ credits: 5, method: 'CASH' })
      .expect(404);
    await recharge(
      adminProvider(providers.A),
      { credits: 5, method: 'CASH' },
      key(),
      t.A,
    ).expect(403);
    await adjust(
      adminProvider(providers.A),
      { amount: 5, reason: 'Autoajuste' },
      key(),
      t.A,
    ).expect(403);
  });

  it('never shows one provider the account of another', async () => {
    await api()
      .get(`/api/v1/provider/credits?providerId=${providers.A}`)
      .auth(t.B, bearer)
      .expect(403);
    await api()
      .get(`/api/v1/provider/credits/ledger?providerId=${providers.A}`)
      .auth(t.B, bearer)
      .expect(403);
    await api().get(adminProvider(providers.A)).auth(t.B, bearer).expect(403);
    const own = await api()
      .get('/api/v1/provider/credits')
      .auth(t.B, bearer)
      .expect(200);
    expect(own.body).toMatchObject({ providerId: providers.B, balance: 0 });
    // Repeated query parameters are not a way to pick another provider.
    await api()
      .get(
        `/api/v1/provider/credits?providerId=${providers.B}&providerId=${providers.A}`,
      )
      .auth(t.B, bearer)
      .expect(400);
  });

  it('an independent driver reads only its own account and cannot move credits', async () => {
    const mine = await api()
      .get('/api/v1/driver/credits')
      .auth(t.carlos, bearer)
      .expect(200);
    expect(mine.body.ownerType).toBe('INDEPENDENT_DRIVER');
    const ledger = await api()
      .get('/api/v1/driver/credits/ledger')
      .auth(t.carlos, bearer)
      .expect(200);
    for (const item of ledger.body.items)
      expect(item).not.toHaveProperty('createdByUserId');
    await recharge(
      adminDriver(drivers.carlos),
      { credits: 5, method: 'CASH' },
      key(),
      t.carlos,
    ).expect(403);
    await adjust(
      adminDriver(drivers.carlos),
      { amount: 5, reason: 'Autoajuste' },
      key(),
      t.carlos,
    ).expect(403);
    await api()
      .get(adminProvider(providers.A))
      .auth(t.carlos, bearer)
      .expect(403);
  });

  it('keeps B2B clients and the wrong roles out of every credit route', async () => {
    const routes = [
      ['get', adminProvider(providers.A)],
      ['get', adminProvider(providers.A, '/ledger')],
      ['post', adminProvider(providers.A, '/recharge')],
      ['post', adminProvider(providers.A, '/adjustment')],
      ['get', adminDriver(drivers.carlos)],
      ['post', adminDriver(drivers.carlos, '/recharge')],
      ['get', '/api/v1/provider/credits'],
      ['get', '/api/v1/driver/credits'],
    ] as const;
    for (const [method, path] of routes) {
      await api()[method](path).auth(t.b2b, bearer).send({}).expect(401);
      await api()[method](path).send({}).expect(401);
    }
    // SUPER_ADMIN administers, but does not impersonate an owner's self routes.
    await api().get('/api/v1/provider/credits').auth(t.sa, bearer).expect(403);
    await api().get('/api/v1/driver/credits').auth(t.sa, bearer).expect(403);
  });
});

describe('V1.10-A ledger', () => {
  withApp();

  it('paginates newest first by sequence and bounds the page size', async () => {
    const all = await api()
      .get(adminProvider(providers.A, '/ledger?pageSize=100'))
      .auth(t.sa, bearer)
      .expect(200);
    const seqs = all.body.items.map((e: { sequence: number }) => e.sequence);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
    const page2 = await api()
      .get(adminProvider(providers.A, '/ledger?pageSize=2&page=2'))
      .auth(t.sa, bearer)
      .expect(200);
    expect(
      page2.body.items.map((e: { sequence: number }) => e.sequence),
    ).toEqual(seqs.slice(2, 4));
    expect(page2.body).toMatchObject({
      page: 2,
      pageSize: 2,
      total: all.body.total,
    });
    for (const bad of ['pageSize=0', 'pageSize=101', 'page=0', 'page=abc'])
      await api()
        .get(adminProvider(providers.A, `/ledger?${bad}`))
        .auth(t.sa, bearer)
        .expect(400);
  });

  it('is immutable in PostgreSQL itself, not just in the API', async () => {
    const [entry] = await entriesOf((await accountOf(providers.A)).id);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "CreditLedgerEntry" SET amount = 1 WHERE id = $1::uuid`,
        entry.id,
      ),
    ).rejects.toThrow(/CREDIT_LEDGER_IMMUTABLE/);
    await expect(
      prisma.$executeRawUnsafe(
        `DELETE FROM "CreditLedgerEntry" WHERE id = $1::uuid`,
        entry.id,
      ),
    ).rejects.toThrow(/CREDIT_LEDGER_IMMUTABLE/);
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE "CreditLedgerEntry"`),
    ).rejects.toThrow(/CREDIT_LEDGER_IMMUTABLE/);
    // Even with the test purge switch, an entry can never be edited.
    await expect(
      prisma.$transaction([
        prisma.$executeRawUnsafe(
          `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
        ),
        prisma.$executeRawUnsafe(
          `UPDATE "CreditLedgerEntry" SET amount = 1 WHERE id = $1::uuid`,
          entry.id,
        ),
      ]),
    ).rejects.toThrow(/CREDIT_LEDGER_IMMUTABLE/);
    // An owner with history cannot be deleted from under it.
    await expect(
      prisma.deliveryProvider.delete({ where: { id: providers.A } }),
    ).rejects.toThrow();
  });
});

describe('V1.10-A database guarantees', () => {
  withApp();

  it('refuses every invalid state written directly in SQL', async () => {
    const account = await accountOf(providers.B);
    const sa = userIds[0];
    const entry = (over: Record<string, unknown>) =>
      prisma.creditLedgerEntry.create({
        data: {
          creditAccountId: account.id,
          type: 'RECHARGE',
          amount: 5,
          balanceBefore: 0,
          balanceAfter: 5,
          rechargeMethod: 'CASH',
          createdByUserId: sa,
          idempotencyKey: key(),
          requestHash: 'a'.repeat(64),
          ...over,
        } as never,
      });
    const attempts: [string, () => Promise<unknown>, RegExp][] = [
      [
        'direct balance update',
        () =>
          prisma.$executeRawUnsafe(
            `UPDATE "CreditAccount" SET balance = 999 WHERE id = $1::uuid`,
            account.id,
          ),
        /CREDIT_BALANCE_WITHOUT_LEDGER/,
      ],
      [
        'second provider account',
        () =>
          prisma.$executeRawUnsafe(
            `INSERT INTO "CreditAccount"(id,"ownerType","providerId",balance,"updatedAt") VALUES (gen_random_uuid(),'PROVIDER',$1::uuid,0,now())`,
            providers.B,
          ),
        /unique|llave|duplicate/i,
      ],
      [
        'incoherent ownerType',
        () =>
          prisma.$executeRawUnsafe(
            `INSERT INTO "CreditAccount"(id,"ownerType","providerId",balance,"updatedAt") VALUES (gen_random_uuid(),'INDEPENDENT_DRIVER',$1::uuid,0,now())`,
            providers.B,
          ),
        /CreditAccount_owner_check/,
      ],
      [
        'both owners',
        () =>
          prisma.$executeRawUnsafe(
            `INSERT INTO "CreditAccount"(id,"ownerType","providerId","independentDriverProfileId",balance,"updatedAt") SELECT gen_random_uuid(),'PROVIDER',$1::uuid,ip.id,0,now() FROM "IndependentDriverProfile" ip LIMIT 1`,
            providers.api,
          ),
        /CreditAccount_owner_check|unique|llave/i,
      ],
      [
        'account born with credits',
        () =>
          prisma.$executeRawUnsafe(
            `INSERT INTO "CreditAccount"(id,"ownerType","providerId",balance,"updatedAt") VALUES (gen_random_uuid(),'PROVIDER',gen_random_uuid(),50,now())`,
          ),
        /CREDIT_ACCOUNT_INVALID/,
      ],
      [
        'owner change',
        () =>
          prisma.$executeRawUnsafe(
            `UPDATE "CreditAccount" SET "providerId" = $1::uuid WHERE id = $2::uuid`,
            providers.api,
            account.id,
          ),
        /CREDIT_ACCOUNT_IMMUTABLE|unique|llave/i,
      ],
      [
        'negative recharge',
        () => entry({ amount: -5, balanceAfter: -5 }),
        /CreditLedgerEntry_/,
      ],
      [
        'negative balance',
        () =>
          entry({
            type: 'ADMIN_ADJUSTMENT',
            rechargeMethod: null,
            reason: 'Resta',
            amount: -5,
            balanceAfter: -5,
          }),
        /CreditLedgerEntry_amount_check/,
      ],
      [
        'zero movement',
        () =>
          entry({
            type: 'ADMIN_ADJUSTMENT',
            rechargeMethod: null,
            reason: 'Nada',
            amount: 0,
            balanceAfter: 0,
          }),
        /CreditLedgerEntry_amount_check/,
      ],
      [
        'wrong arithmetic',
        () => entry({ balanceAfter: 500 }),
        /CreditLedgerEntry_amount_check/,
      ],
      [
        'stale balanceBefore',
        () => entry({ balanceBefore: 7, balanceAfter: 12 }),
        /CREDIT_LEDGER_STALE/,
      ],
      [
        'absurd amount',
        () => entry({ amount: 5000000, balanceAfter: 5000000 }),
        /CreditLedgerEntry_amount_check/,
      ],
      [
        'award with positive sign',
        () => entry({ type: 'SERVICE_AWARD', rechargeMethod: null, amount: 5 }),
        /CreditLedgerEntry_type_check/,
      ],
      [
        'recharge without actor',
        () => entry({ createdByUserId: null }),
        /CreditLedgerEntry_type_check/,
      ],
      [
        'recharge without idempotency',
        () => entry({ idempotencyKey: null, requestHash: null }),
        /CreditLedgerEntry_type_check/,
      ],
      [
        'adjustment without reason',
        () => entry({ type: 'ADMIN_ADJUSTMENT', rechargeMethod: null }),
        /CreditLedgerEntry_type_check/,
      ],
    ];
    const accepted: string[] = [];
    for (const [label, attempt, expected] of attempts) {
      try {
        await attempt();
        accepted.push(label);
      } catch (error) {
        expect(String((error as Error).message), label).toMatch(expected);
      }
    }
    expect(accepted).toEqual([]);
    expect((await accountOf(providers.B)).balance).toBe(0);
  });
});

describe('V1.10-A concurrency', () => {
  withApp();

  it('concurrent recharges all apply, with no lost update', async () => {
    const path = adminDriver(drivers.pedro);
    const start = (await api().get(path).auth(t.sa, bearer).expect(200)).body
      .balance;
    const results = await Promise.all(
      [100, 200, 300].map((credits) =>
        recharge(path, { credits, method: 'CASH' }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const account = (await api().get(path).auth(t.sa, bearer).expect(200)).body;
    expect(account.balance).toBe(start + 600);
    const { problems, entries } = await chainIsConsistent(account.id);
    expect(problems).toEqual([]);
    expect(
      entries.filter(
        (e) => e.type === 'RECHARGE' && [100, 200, 300].includes(e.amount),
      ),
    ).toHaveLength(3);
  });

  it('two debits that fit only once: one applies, the other is refused, balance 2', async () => {
    const path = adminProvider(providers.B);
    await recharge(path, { credits: 10, method: 'CASH' }).expect(201);
    const results = await Promise.all([
      adjust(path, { amount: -8, reason: 'Debito A' }),
      adjust(path, { amount: -8, reason: 'Debito B' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'INSUFFICIENT_CREDITS',
    );
    const account = await accountOf(providers.B);
    expect(account.balance).toBe(2);
    expect((await chainIsConsistent(account.id)).problems).toEqual([]);
  });

  it('mixed concurrent movements leave a balance equal to the serialized history', async () => {
    const path = adminProvider(providers.B);
    const start = (await accountOf(providers.B)).balance;
    const amounts = [100, -30, 50, -80, 25, -500, 60, -10];
    const results = await Promise.all(
      amounts.map((amount, i) =>
        adjust(path, { amount, reason: `Mixto ${i}` }),
      ),
    );
    for (const r of results) expect([201, 409]).toContain(r.status);
    const applied = results
      .filter((r) => r.status === 201)
      .map((r) => r.body.entry.amount as number);
    const account = await accountOf(providers.B);
    expect(account.balance).toBe(start + applied.reduce((a, b) => a + b, 0));
    expect(account.balance).toBeGreaterThanOrEqual(0);
    const { problems } = await chainIsConsistent(account.id);
    expect(problems).toEqual([]);
  });

  it('the same Idempotency-Key fired five times at once applies exactly once', async () => {
    const path = adminProvider(providers.B);
    const k = key();
    const before = (await accountOf(providers.B)).balance;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recharge(path, { credits: 7, method: 'CASH' }, k),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(4);
    expect(new Set(results.map((r) => r.body.entry.id)).size).toBe(1);
    expect((await accountOf(providers.B)).balance).toBe(before + 7);
    expect(
      await prisma.creditLedgerEntry.count({ where: { idempotencyKey: k } }),
    ).toBe(1);
  });
});

describe('V1.10-A does not charge credits yet', () => {
  withApp();

  it('a provider with zero credits still claims, and a claim writes no ledger entry', async () => {
    await api()
      .post(`/api/v1/admin/providers/${providers.A}/credits/adjustment`)
      .auth(t.sa, bearer)
      .set('Idempotency-Key', key())
      .send({
        amount: -(await accountOf(providers.A)).balance,
        reason: 'Dejar en cero',
      })
      .expect(201);
    expect((await accountOf(providers.A)).balance).toBe(0);
    const entries = await prisma.creditLedgerEntry.count();
    const dispatchId = await openDispatch();
    await api()
      .post(`/api/v1/provider/dispatches/${dispatchId}/claim`)
      .auth(t.A, bearer)
      .expect(200);
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatchId } }))
        .status,
    ).toBe('CLAIMED');
    expect((await accountOf(providers.A)).balance).toBe(0);
    expect(await prisma.creditLedgerEntry.count()).toBe(entries);
  });

  it('an independent driver with zero credits still takes, and a take writes no ledger entry', async () => {
    const vehicle = await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `MOTO-${run}`, type: 'MOTORCYCLE' })
      .expect(201);
    carlosVehicle = vehicle.body.id;
    const account = (
      await api()
        .get(adminDriver(drivers.carlos))
        .auth(t.sa, bearer)
        .expect(200)
    ).body;
    if (account.balance > 0)
      await adjust(adminDriver(drivers.carlos), {
        amount: -account.balance,
        reason: 'Dejar en cero',
      }).expect(201);
    const entries = await prisma.creditLedgerEntry.count();
    const dispatchId = await openDispatch();
    await api()
      .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
      .auth(t.carlos, bearer)
      .send({ vehicleId: carlosVehicle })
      .expect(200);
    const after = (
      await api()
        .get('/api/v1/driver/credits')
        .auth(t.carlos, bearer)
        .expect(200)
    ).body;
    expect(after.balance).toBe(0);
    expect(await prisma.creditLedgerEntry.count()).toBe(entries);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { type: { in: ['SERVICE_AWARD', 'SERVICE_REFUND'] } },
      }),
    ).toBe(0);
  });

  it('suspending an owner keeps its balance and history readable', async () => {
    await recharge(adminProvider(providers.A), {
      credits: 15,
      method: 'CASH',
    }).expect(201);
    await api()
      .post(`/api/v1/admin/providers/${providers.A}/suspend`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    const account = await api()
      .get(adminProvider(providers.A))
      .auth(t.sa, bearer)
      .expect(200);
    expect(account.body.balance).toBe(15);
    await api()
      .get(adminProvider(providers.A, '/ledger'))
      .auth(t.sa, bearer)
      .expect(200);
    await api()
      .post(`/api/v1/admin/providers/${providers.A}/activate`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
  });
});

describe('V1.10-A audit', () => {
  it('logs every economic mutation, attributable, with no secret', () => {
    const text = logs.join('\n');
    for (const event of [
      'CREDIT_RECHARGED',
      'CREDIT_ADJUSTED',
      'CREDIT_MOVEMENT_REPLAYED',
      'CREDIT_IDEMPOTENCY_CONFLICT',
      'CREDIT_MOVEMENT_REJECTED',
    ])
      expect(text).toContain(event);
    const line = logs.find((l) => l.includes('CREDIT_RECHARGED'))!;
    for (const field of [
      'actorUserId',
      'creditAccountId',
      'ownerType',
      'ownerId',
      'entryId',
      'amount',
      'balanceBefore',
      'balanceAfter',
    ])
      expect(line).toContain(field);
    for (const secret of [password, t.sa, t.A, t.carlos, t.b2b])
      expect(text).not.toContain(secret);
  });
});
