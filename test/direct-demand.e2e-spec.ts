import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import { fundForAward } from './support/credits.js';

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
process.env.LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES = '30';
process.env.INDEPENDENT_DRIVER_MAX_VEHICLES = '2';
process.env.MAIL_PROVIDER = 'local_outbox';
process.env.DETAILED_EXECUTION_ENABLED = 'true';
process.env.CUSTOMER_ADMISSION_ENABLED = 'true';
process.env.PREQUOTE_ENABLED = 'true';
process.env.PREQUOTE_CONVERSION_ENABLED = 'true';
process.env.PREQUOTE_AUTHORIZED_ACCEPT_ENABLED = 'true';
process.env.PREQUOTE_PER_MINUTE = '1000';
process.env.PREQUOTE_PER_DAY = '100000';
process.env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS = '100000';
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_V117_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@execution.test`.toLowerCase();
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
      distanceMeters: 3900,
      durationSeconds: 640,
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
const ZONE = { lng: -93.4, lat: 17.4 };
const square = () => ({
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
});
const providers: Record<string, string> = {};
const drivers: Record<string, string> = {};
const vehicles: Record<string, string> = {};
const users: Record<string, string> = {};
const t: Record<string, string> = {};
let zoneId = '';
let app: INestApplication;
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;

async function bootstrap(realConsumption = false) {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const { PREQUOTE_CONSUMPTION } =
    await import('../dist/delivery-prequotes/prequote-consumption.js');
  const builder = Test.createTestingModule({ imports: [AppModule] });
  if (!realConsumption)
    builder.overrideProvider(PREQUOTE_CONSUMPTION).useValue({
      admit: async () => ({
        admitted: true,
        permit: {
          start: async () => {},
          assertReady: async () => {},
          finish: async () => {},
        },
      }),
    });
  const moduleRef = await builder
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

/** A fresh app per block resets the in-memory throttler counters. */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}

const claim = (token: string, dispatchId: string) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/claim`)
    .auth(token, bearer)
    .send({});
const assign = (token: string, dispatchId: string, body: object) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/assignment`)
    .auth(token, bearer)
    .send(body);
const take = (token: string, dispatchId: string, vehicleId: string) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
async function assignedToken(id: string) {
  const a = await prisma.deliveryAssignment.findFirstOrThrow({
    where: { dispatchId: id, status: { in: ['ACTIVE', 'COMPLETED'] } },
    orderBy: { assignedAt: 'desc' },
  });
  const name = Object.keys(drivers).find((n) => drivers[n] === a.driverId)!;
  return t[name];
}
const completionCalls = new Map<
  string,
  {
    token: string;
    key: string;
    body: { assignmentId: string; expectedRevision: number };
  }
>();
async function appDeliver(id: string) {
  let c = completionCalls.get(id);
  if (!c) {
    const token = await assignedToken(id);
    const r = await api()
      .get('/api/v1/driver/dispatches/' + id + '/execution')
      .auth(token, bearer)
      .expect(200);
    c = {
      token,
      key: randomUUID(),
      body: {
        assignmentId: r.body.execution.activeAssignmentId,
        expectedRevision: r.body.execution.revision,
      },
    };
    completionCalls.set(id, c);
  }
  return api()
    .post('/api/v1/driver/dispatches/' + id + '/execution-completion')
    .auth(c.token, bearer)
    .set('Idempotency-Key', c.key)
    .send(c.body)
    .expect(200);
}

beforeAll(async () => {
  // Leftovers of a previous killed run would otherwise collide with these fixtures and with the
  // global invariant scans of other suites.
  // Isolated disposable execution database; fixtures retained for invariant inspection.
  await ensureTestCreditPolicies(prisma);
  const passwordHash = await argon2.hash(password);
  const user = async (
    name: string,
    role: 'SUPER_ADMIN' | 'PROVIDER_ADMIN' | 'DRIVER',
  ) => {
    const u = await prisma.user.create({
      data: { email: mail(name), passwordHash, role },
    });
    users[name] = u.id;
    return u.id;
  };
  await user('sa', 'SUPER_ADMIN');
  await user('sa2', 'SUPER_ADMIN');
  // A and B receive dispatches (both candidates); C has no coverage, so it is never a candidate.
  for (const key of ['A', 'B', 'C'] as const) {
    const provider = await prisma.deliveryProvider.create({
      data: {
        name: `Proveedor ${key} ${run}`,
        code: `${PREFIX}${key}_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 10,
        maxVehicles: 10,
      },
    });
    providers[key] = provider.id;
    await prisma.providerMembership.create({
      data: {
        providerId: provider.id,
        userId: await user(`admin${key}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  const driver = async (key: string, providerKey: 'A' | 'B' = 'A') => {
    const row = await prisma.driver.create({
      data: {
        providerId: providers[providerKey],
        userId: await user(key, 'DRIVER'),
        name: key,
        status: 'ACTIVE',
      },
    });
    drivers[key] = row.id;
  };
  await driver('ana');
  await driver('beto');
  await driver('indy');
  await driver('otro');
  for (const key of ['fleet1', 'fleet2']) {
    const row = await prisma.vehicle.create({
      data: {
        providerId: providers.A,
        identifier: `${key.toUpperCase()}-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    vehicles[key] = row.id;
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
  t.C = await login(mail('adminC'));
  t.ana = await login(mail('ana'));
  // Login is limited to 5 per minute per IP; a fresh app resets the in-memory counter.
  await app.close();
  app = await bootstrap();
  t.indy = await login(mail('indy'));
  t.sa2 = await login(mail('sa2'));
  t.otro = await login(mail('otro'));
  t.beto = await login(mail('beto'));
  const zone = await api()
    .post('/api/v1/admin/service-zones')
    .auth(t.sa, bearer)
    .send({
      code: `${PREFIX}ZONE_${run}`,
      name: `Zona ${run}`,
      currency: 'MXN',
      boundary: square(),
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
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '55' },
      ],
    })
    .expect(201);
  await api()
    .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  for (const key of ['A', 'B'] as const)
    await api()
      .post(`/api/v1/admin/providers/${providers[key]}/service-coverages`)
      .auth(t.sa, bearer)
      .send({ serviceZoneId: zoneId, serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  // The independent driver and its own vehicle.
  await api()
    .post(`/api/v1/admin/drivers/${drivers.indy}/independent`)
    .auth(t.sa, bearer)
    .send({ reason: 'Alta para V1.11-A' })
    .expect(200);
  vehicles.indy = (
    await api()
      .post(`/api/v1/admin/drivers/${drivers.indy}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `INDY-${run}`, type: 'MOTORCYCLE' })
      .expect(201)
  ).body.id;
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Completion client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(t.sa, bearer)
    .send({
      scopes: [
        'prequotes:create',
        'prequotes:read',
        'prequotes:convert',
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
  await app.close();
}, 180000);

afterAll(async () => {
  // Retain history, but release this suite's geographic fixture for other files.
  if (zoneId)
    await prisma.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  await prisma.$disconnect();
}, 120000);

describe('V1.17 direct demand, quota, shipping declaration and durable recovery', () => {
  withApp();
  const customerIds: Record<string, string> = {};
  beforeAll(async () => {
    // Existing A identity is exercised separately; these are isolated verified test accounts.
    for (const [name, type] of [
      ['personal', 'PERSONAL'],
      ['business', 'BUSINESS'],
      ['other', 'PERSONAL'],
    ] as const) {
      const u = await prisma.user.create({
        data: {
          email: mail(name),
          role: 'CUSTOMER',
          passwordHash: await argon2.hash(password),
          emailVerifiedAt: new Date(),
        },
      });
      users[name] = u.id;
      customerIds[name] = (
        await prisma.customerAccount.create({
          data: {
            userId: u.id,
            type,
            displayName: name,
            businessName: type === 'BUSINESS' ? 'Synthetic business' : null,
          },
        })
      ).id;
      t[name] = (
        await api()
          .post('/api/v1/auth/login')
          .send({ email: mail(name), password })
          .expect(200)
      ).body.accessToken;
    }
  });
  beforeEach(async () => {
    await app.close();
    app = await bootstrap();
  });
  const conditions = {
    conditionsVersion: 1,
    serviceType: 'LOCAL_DELIVERY',
    stops: [
      {
        type: 'PICKUP',
        sequence: 1,
        latitude: Number((ZONE.lat + 0.02).toFixed(6)),
        longitude: Number((ZONE.lng + 0.02).toFixed(6)),
      },
      {
        type: 'DROPOFF',
        sequence: 2,
        latitude: Number((ZONE.lat + 0.05).toFixed(6)),
        longitude: Number((ZONE.lng + 0.05).toFixed(6)),
      },
    ],
    packages: [{ category: 'PARCEL', quantity: 1 }],
  };
  const conversion = () => ({
    conditionsVersion: 1,
    deliveryRequest: {
      serviceType: 'LOCAL_DELIVERY',
      externalReference: 'Synthetic direct',
      stops: conditions.stops.map((s) => ({
        ...s,
        address: 'Synthetic street',
        contactName: 'Synthetic contact',
        contactPhone: '0000000000',
      })),
      packages: [
        { category: 'PARCEL', description: 'Synthetic parcel', quantity: 1 },
      ],
      financialContext: { goodsPaymentMode: 'PREPAID', currency: 'MXN' },
    },
    payerContact: {
      name: 'Synthetic payer',
      phone: '0000000000',
      capacity: 'AUTHORIZED_REPRESENTATIVE',
    },
  });
  const mpq = (
    name = 'personal',
    shippingPayer = 'REQUESTER',
    key = randomUUID(),
  ) =>
    api()
      .post('/api/v1/customer/delivery-prequotes')
      .auth(t[name], bearer)
      .set('Idempotency-Key', key)
      .send({ conditions, shippingPayer });
  const convert = (id: string, name = 'personal', key = randomUUID()) =>
    api()
      .post('/api/v1/customer/delivery-prequotes/' + id + '/convert')
      .auth(t[name], bearer)
      .set('Idempotency-Key', key)
      .send(conversion());
  const cancel = (id: string, name = 'personal') =>
    api()
      .post('/api/v1/customer/delivery-requests/' + id + '/cancel')
      .auth(t[name], bearer)
      .send({ reason: 'Synthetic cancellation' });
  const status = (id: string, name = 'personal') =>
    api()
      .get('/api/v1/customer/delivery-requests/' + id + '/status')
      .auth(t[name], bearer);
  async function create(name = 'personal', payer = 'REQUESTER') {
    const q = await mpq(name, payer).expect(201);
    return (await convert(q.body.prequote.publicId, name).expect(201)).body
      .result;
  }
  async function accept(
    c: Awaited<ReturnType<typeof create>>,
    name = 'personal',
    key = randomUUID(),
  ) {
    return api()
      .post('/api/v1/customer/delivery-quotes/' + c.quote.publicId + '/accept')
      .auth(t[name], bearer)
      .set('Idempotency-Key', key)
      .send({
        customerAuthorization: {
          version: 1,
          status: 'AUTHORIZED_BY_CUSTOMER',
          reference: 'synthetic-consent',
          authorizedAt: new Date().toISOString(),
          quotePublicId: c.quote.publicId,
          amount: c.quote.amount,
          currency: c.quote.currency,
          expiresAt: c.quote.expiresAt,
          shippingTermsVersion: 1,
          shippingTermsHash: c.shippingTerms.termsHash,
        },
      });
  }
  async function start(name = 'personal', independent = false) {
    const c = await create(name);
    expect((await accept(c, name)).status).toBe(200);
    const d = await prisma.dispatch.findFirstOrThrow({
      where: { deliveryRequest: { publicId: c.deliveryRequestPublicId } },
    });
    await fundForAward(
      prisma,
      d.id,
      independent ? { driverId: drivers.indy } : { providerId: providers.A },
    );
    if (independent) await take(t.indy, d.id, vehicles.indy).expect(200);
    else {
      await claim(t.A, d.id).expect(200);
      await assign(t.A, d.id, {
        driverId: drivers.ana,
        vehicleId: vehicles.fleet1,
      }).expect(201);
    }
    return { c, id: d.id, token: independent ? t.indy : t.ana, name };
  }
  async function head(d: { id: string; token: string }) {
    return (
      await api()
        .get('/api/v1/driver/dispatches/' + d.id + '/execution')
        .auth(d.token, bearer)
        .expect(200)
    ).body.execution;
  }
  async function step(d: { id: string; token: string }, phase: string) {
    const e = await head(d);
    return api()
      .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
      .auth(d.token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        phase,
      });
  }
  async function cashBody(d: Awaited<ReturnType<typeof start>>) {
    const e = await head(d);
    return {
      assignmentId: e.activeAssignmentId,
      expectedRevision: e.revision,
      quotePublicId: d.c.quote.publicId,
      termsHash: d.c.shippingTerms.termsHash,
      amount: d.c.quote.amount,
      currency: d.c.quote.currency,
      receivedFrom: 'AUTHORIZED_REPRESENTATIVE',
      occurredAt: new Date().toISOString(),
    };
  }
  const cash = (
    d: { id: string; token: string },
    body: object,
    key = randomUUID(),
  ) =>
    api()
      .post('/api/v1/driver/dispatches/' + d.id + '/shipping-collection')
      .auth(d.token, bearer)
      .set('Idempotency-Key', key)
      .send(body);
  const attempt = (
    d: { id: string; token: string },
    assignmentId: string,
    key: string,
    close = false,
  ) => {
    const path =
      '/api/v1/driver/dispatches/' +
      d.id +
      '/assignments/' +
      assignmentId +
      '/attempt' +
      (close ? '/close' : '') +
      '?operation=COLLECT_SHIPPING';
    return (close ? api().post(path) : api().get(path))
      .auth(d.token, bearer)
      .set('Idempotency-Key', key);
  };
  it('separates direct ownership and B2B, blocks PERSONAL recipient and duplicate quota transactionally', async () => {
    await mpq('personal', 'RECIPIENT').expect(400);
    const q = await mpq().expect(201);
    await convert(q.body.prequote.publicId, 'other').expect(404);
    await api()
      .get('/api/v1/delivery-prequotes/' + q.body.prequote.publicId)
      .auth(t.b2b, bearer)
      .expect(404);
    const keys = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.all(
      keys.map((k) => convert(q.body.prequote.publicId, 'personal', k)),
    );
    expect(results.filter((x) => x.status === 201)).toHaveLength(1);
    expect(results.filter((x) => x.status === 409)).toHaveLength(7);
    const winner = results.find((x) => x.status === 201)!;
    const retry = await convert(
      q.body.prequote.publicId,
      'personal',
      keys[results.indexOf(winner)],
    ).expect(201);
    expect(retry.body.result.deliveryRequestPublicId).toBe(
      winner.body.result.deliveryRequestPublicId,
    );
    const capacity = await api()
      .get('/api/v1/customer/capabilities')
      .auth(t.personal, bearer)
      .expect(200);
    expect(capacity.body).toMatchObject({
      canCreateRequest: false,
      reason: 'CUSTOMER_ACTIVE_REQUEST_LIMIT',
      capacity: {
        occupied: true,
        activeCount: 1,
        activeRequestPublicId: winner.body.result.deliveryRequestPublicId,
      },
    });
    const ownPage = await api()
      .get('/api/v1/customer/delivery-requests?page=1&pageSize=10')
      .auth(t.personal, bearer)
      .expect(200);
    expect(ownPage.body.items).toHaveLength(1);
    expect(ownPage.body.total).toBe(1);
    await status(winner.body.result.deliveryRequestPublicId, 'other').expect(
      404,
    );
    const row = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: winner.body.result.deliveryRequestPublicId },
    });
    expect(row.integrationClientId).toBeNull();
    expect(row.customerAccountId).toBe(customerIds.personal);
    await cancel(row.publicId).expect(200);
    expect(
      (
        await prisma.directRequestLifecycle.findUniqueOrThrow({
          where: { deliveryRequestId: row.id },
        })
      ).personalSlot,
    ).toBeNull();
  }, 30000);
  it('PERSONAL quota serializes different prequotes and preserves the losing quote for a later legal conversion', async () => {
    const a = await mpq().expect(201);
    const b = await mpq().expect(201);
    const quotes = [a.body.prequote.publicId, b.body.prequote.publicId];
    const keys = [randomUUID(), randomUUID()];
    const responses = await Promise.all(
      quotes.map((q, i) => convert(q, 'personal', keys[i])),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = responses.findIndex((r) => r.status === 409);
    expect(responses[loser].body.code).toBe('CUSTOMER_ACTIVE_REQUEST_LIMIT');
    expect(
      await prisma.directRequestLifecycle.count({
        where: { customerAccountId: customerIds.personal, closedAt: null },
      }),
    ).toBe(1);
    const winner = responses.find((r) => r.status === 201)!;
    await cancel(winner.body.result.deliveryRequestPublicId).expect(200);
    const retried = await convert(
      quotes[loser],
      'personal',
      keys[loser],
    ).expect(201);
    await cancel(retried.body.result.deliveryRequestPublicId).expect(200);
  });
  it('BUSINESS supports concurrent active requests and independent payer choices; same key retains terms', async () => {
    const a = await create('business');
    const b = await create('business', 'RECIPIENT');
    expect(a.shippingTerms.payer).toBe('REQUESTER');
    expect(b.shippingTerms.payer).toBe('RECIPIENT');
    expect(
      await prisma.directRequestLifecycle.count({
        where: { customerAccountId: customerIds.business, closedAt: null },
      }),
    ).toBe(2);
    await cancel(a.deliveryRequestPublicId, 'business').expect(200);
    await cancel(b.deliveryRequestPublicId, 'business').expect(200);
  }, 30000);
  it('requires exact consent hash and keeps quota until explicit cancellation', async () => {
    const c = await create();
    const bad = {
      ...c,
      shippingTerms: { ...c.shippingTerms, termsHash: '0'.repeat(64) },
    };
    expect((await accept(bad)).status).toBe(409);
    const row = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: c.deliveryRequestPublicId },
    });
    expect(
      (
        await prisma.directRequestLifecycle.findUniqueOrThrow({
          where: { deliveryRequestId: row.id },
        })
      ).personalSlot,
    ).toBe(customerIds.personal);
    await cancel(c.deliveryRequestPublicId).expect(200);
  });
  it('fleet cash is exact, durable, separately versioned and required before pickup; delivery creates no B2B outbox', async () => {
    const d = await start();
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    expect((await step(d, 'PICKED_UP')).status).toBe(409);
    const b = await cashBody(d);
    await cash(d, { ...b, amount: '0.01' }).expect(409);
    await cash({ ...d, token: t.A }, b).expect(403);
    await cash({ ...d, token: t.otro }, b).expect(404);
    const before = (await status(d.c.deliveryRequestPublicId).expect(200)).body;
    const key = randomUUID();
    await cash(d, b, key).expect(200);
    // Simulated lost response: discard it and recover from the durable receipt and status.
    expect((await attempt(d, b.assignmentId, key).expect(200)).body.state).toBe(
      'APPLIED',
    );
    await cash(d, b, key).expect(200);
    await cash(d, b).expect(409);
    const after = (await status(d.c.deliveryRequestPublicId).expect(200)).body;
    expect(BigInt(after.publicVersion)).toBeGreaterThan(
      BigInt(before.publicVersion),
    );
    expect(after.shippingPayment).toMatchObject({
      evidenceStatus: 'DECLARED',
      collectShipping: false,
      amount: d.c.quote.amount,
    });
    expect(JSON.stringify(after)).not.toContain('payerContact');
    expect(
      (await status(d.c.deliveryRequestPublicId).expect(200)).body
        .publicVersion,
    ).toBe(after.publicVersion);
    for (const phase of ['PICKED_UP', 'TO_DROPOFF', 'AT_DROPOFF'])
      expect((await step(d, phase)).status).toBe(200);
    await appDeliver(d.id);
    const row = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: d.c.deliveryRequestPublicId },
    });
    expect(
      await prisma.b2bOutboxEvent.count({
        where: { deliveryRequestId: row.id },
      }),
    ).toBe(0);
    expect(
      (
        await prisma.directRequestLifecycle.findUniqueOrThrow({
          where: { deliveryRequestId: row.id },
        })
      ).closureReason,
    ).toBe('DELIVERED');
    const final = (await status(row.publicId).expect(200)).body;
    expect(final.shippingPayment.instructionStatus).toBe('HISTORICAL');
    expect(final.terminalOutcome).toMatchObject({ type: 'DELIVERED' });
  }, 30000);
  it('explicit close wins before a delayed cash command and survives application restart', async () => {
    const d = await start();
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    const b = await cashBody(d);
    const key = randomUUID();
    expect((await attempt(d, b.assignmentId, key).expect(200)).body.state).toBe(
      'PENDING_OR_UNKNOWN',
    );
    expect(
      (await attempt(d, b.assignmentId, key, true).expect(200)).body.state,
    ).toBe('CLOSED_NO_EFFECTS');
    await app.close();
    app = await bootstrap();
    expect((await attempt(d, b.assignmentId, key).expect(200)).body.state).toBe(
      'CLOSED_NO_EFFECTS',
    );
    const late = await cash(d, b, key).expect(409);
    expect(JSON.stringify(late.body)).toContain('EXECUTION_ATTEMPT_CLOSED');
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(0);
    await cancel(d.c.deliveryRequestPublicId).expect(200);
  }, 30000);
  it('cash versus close serializes to APPLIED or CLOSED_NO_EFFECTS and never double declares', async () => {
    const d = await start('personal', true);
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    const b = await cashBody(d);
    const key = randomUUID();
    await Promise.all([cash(d, b, key), attempt(d, b.assignmentId, key, true)]);
    const state = (await attempt(d, b.assignmentId, key).expect(200)).body
      .state;
    expect(['APPLIED', 'CLOSED_NO_EFFECTS']).toContain(state);
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(state === 'APPLIED' ? 1 : 0);
    if (state === 'CLOSED_NO_EFFECTS') await cash(d, b).expect(200);
    expect((await step(d, 'PICKED_UP')).status).toBe(200);
    await cancel(d.c.deliveryRequestPublicId).expect(409);
    const e = await head(d);
    const incident = await api()
      .post('/api/v1/driver/dispatches/' + d.id + '/custody-incidents')
      .auth(d.token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'OTHER',
        reasonDetail: 'Synthetic blocked delivery',
      })
      .expect(201);
    const v = incident.body.execution;
    await api()
      .post(
        '/api/v1/admin/dispatches/' +
          d.id +
          '/custody-incidents/' +
          incident.body.id +
          '/resolve',
      )
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: v.activeAssignmentId,
        expectedRevision: v.revision,
        type: 'RETURN_TO_ORIGIN',
        reason: 'Synthetic confirmed return',
        occurredAt: new Date().toISOString(),
        confirmationMethod: 'PHONE',
        custodianConfirmed: true,
        originConfirmed: true,
        originContactLabel: 'Synthetic origin',
        originContactRole: 'Requester',
      })
      .expect(200);
    const row = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: d.c.deliveryRequestPublicId },
    });
    expect(
      (
        await prisma.directRequestLifecycle.findUniqueOrThrow({
          where: { deliveryRequestId: row.id },
        })
      ).closureReason,
    ).toBe('RETURNED');
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(1);
  }, 30000);
  it('expired MQ does not release PERSONAL quota or change the immutable terms', async () => {
    app.get(ConfigService).set('PREQUOTE_VALIDITY_MS', 1000);
    const c = await create();
    app.get(ConfigService).set('PREQUOTE_VALIDITY_MS', 900000);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await accept(c)).status).toBe(409);
    const q = await mpq().expect(201);
    await convert(q.body.prequote.publicId).expect(409);
    const detail = await api()
      .get('/api/v1/customer/delivery-requests/' + c.deliveryRequestPublicId)
      .auth(t.personal, bearer)
      .expect(200);
    expect(detail.body.shippingTerms.termsHash).toBe(c.shippingTerms.termsHash);
    await cancel(c.deliveryRequestPublicId).expect(200);
  }, 30000);
  it('transfer keeps custody, the shipping declaration and original economic charge; former Driver loses write authority', async () => {
    enableLocation();
    const d = await start();
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    const oldGps = await gps(d);
    await oldGps.send().expect(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    const body = await cashBody(d),
      key = randomUUID();
    await cash(d, body, key).expect(200);
    expect((await step(d, 'PICKED_UP')).status).toBe(200);
    const e = await head(d);
    const incident = await api()
      .post('/api/v1/driver/dispatches/' + d.id + '/custody-incidents')
      .auth(d.token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'VEHICLE_FAILURE',
        reasonDetail: 'Synthetic vehicle unavailable',
      })
      .expect(201);
    const before = (await status(d.c.deliveryRequestPublicId).expect(200)).body;
    expect(
      (await ownLocation(d.c.deliveryRequestPublicId).expect(200)).body.location
        .sample,
    ).toBeNull();
    await oldGps.send({ ...oldGps.sample, sequence: 2 }).expect(409);
    const entries = await prisma.creditLedgerEntry.count({
      where: { referenceId: d.id },
    });
    const v = incident.body.execution;
    await api()
      .post(
        '/api/v1/admin/dispatches/' +
          d.id +
          '/custody-incidents/' +
          incident.body.id +
          '/resolve',
      )
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: v.activeAssignmentId,
        expectedRevision: v.revision,
        type: 'TRANSFER',
        reason: 'Synthetic transfer',
        occurredAt: new Date().toISOString(),
        confirmationMethod: 'PHONE',
        recipient: {
          mode: 'INDEPENDENT',
          driverId: drivers.indy,
          vehicleId: vehicles.indy,
        },
        releasingCustodianConfirmed: true,
        receivingCustodianConfirmed: true,
        atCurrentStageLocation: true,
      })
      .expect(200);
    expect(
      await prisma.creditLedgerEntry.count({ where: { referenceId: d.id } }),
    ).toBe(entries);
    const after = (await status(d.c.deliveryRequestPublicId).expect(200)).body;
    expect(BigInt(after.publicVersion)).toBeGreaterThan(
      BigInt(before.publicVersion),
    );
    expect(after.shippingPayment.evidenceStatus).toBe('DECLARED');
    expect(after.shippingPayment.collectShipping).toBe(false);
    await cash(d, body, key).expect(200); // Historical replay is not another physical collection.
    await cash(d, body).expect(404);
    const recipient = { ...d, token: t.indy };
    const next = await head(recipient);
    expect(next.phase).toBe('PICKED_UP');
    await oldGps.send({ ...oldGps.sample, sequence: 3 }).expect(404);
    expect(
      (await ownLocation(d.c.deliveryRequestPublicId).expect(200)).body.location
        .sample,
    ).toBeNull();
    const newGps = await gps(recipient);
    await newGps.send().expect(200);
    expect(
      (await ownLocation(d.c.deliveryRequestPublicId).expect(200)).body.location
        .sample.latitude,
    ).toBe(17.42);
    await cash(recipient, {
      ...body,
      assignmentId: next.activeAssignmentId,
      expectedRevision: next.revision,
    }).expect(409);
    const q = await mpq().expect(201);
    await convert(q.body.prequote.publicId).expect(409);
    expect((await step(recipient, 'TO_DROPOFF')).status).toBe(200);
    expect((await step(recipient, 'AT_DROPOFF')).status).toBe(200);
    await appDeliver(d.id);
  }, 30000);
  it('cash and pickup serialize: pickup succeeds only after the single persisted declaration', async () => {
    const d = await start();
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    const b = await cashBody(d);
    const [collection, pickup] = await Promise.all([
      cash(d, b),
      api()
        .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
        .auth(d.token, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: b.assignmentId,
          expectedRevision: b.expectedRevision,
          phase: 'PICKED_UP',
        }),
    ]);
    expect(collection.status).toBe(200);
    expect([200, 409]).toContain(pickup.status);
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(1);
    if (pickup.status === 409)
      expect((await step(d, 'PICKED_UP')).status).toBe(200);
    for (const phase of ['TO_DROPOFF', 'AT_DROPOFF'])
      expect((await step(d, phase)).status).toBe(200);
    await appDeliver(d.id);
  }, 30000);
  it('controlled receipt failure rolls back cash evidence and leaves an unknown attempt that can be closed safely', async () => {
    const d = await start();
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    const b = await cashBody(d),
      key = randomUUID();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION v117_test_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.key='${key}'::uuid THEN RAISE EXCEPTION 'V117_TEST_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER v117_test_receipt_fault BEFORE INSERT ON "DeliveryExecutionCommand" FOR EACH ROW EXECUTE FUNCTION v117_test_receipt_fault()',
    );
    try {
      await cash(d, b, key).expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER v117_test_receipt_fault ON "DeliveryExecutionCommand"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION v117_test_receipt_fault()');
    }
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(0);
    expect((await attempt(d, b.assignmentId, key).expect(200)).body.state).toBe(
      'PENDING_OR_UNKNOWN',
    );
    await attempt(d, b.assignmentId, key, true).expect(200);
    await cash(d, b, key).expect(409);
    await cancel(d.c.deliveryRequestPublicId).expect(200);
  }, 30000);
  it('cancellation versus cash keeps at most one declaration and never grants pickup on a cancelled request', async () => {
    const d = await start();
    await step(d, 'TO_PICKUP');
    await step(d, 'AT_PICKUP');
    const b = await cashBody(d);
    const [collection, cancellation] = await Promise.all([
      cash(d, b),
      cancel(d.c.deliveryRequestPublicId),
    ]);
    expect(cancellation.status).toBe(200);
    expect([200, 409, 404]).toContain(collection.status);
    const count = await prisma.shippingCollectionDeclaration.count({
      where: { dispatchId: d.id },
    });
    expect(count).toBe(collection.status === 200 ? 1 : 0);
    const last = (await status(d.c.deliveryRequestPublicId).expect(200)).body;
    expect(last.shippingPayment.collectShipping).toBe(false);
    expect(last.shippingPayment.instructionStatus).toBe('HISTORICAL');
    const late = await api()
      .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
      .auth(d.token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: b.assignmentId,
        expectedRevision: b.expectedRevision,
        phase: 'PICKED_UP',
      })
      .expect(409);
    expect(late.body.code).toBe('EXECUTION_CONFLICT');
  }, 30000);
  it('type change and conversion serialize; database rejects removal, reopening and forged ownership of quota', async () => {
    const q = await mpq().expect(201);
    const p = (
      await api()
        .get('/api/v1/customer/profile')
        .auth(t.personal, bearer)
        .expect(200)
    ).body;
    const change = () =>
      api()
        .post('/api/v1/customer/profile/type')
        .auth(t.personal, bearer)
        .send({ type: 'BUSINESS', expectedRevision: p.revision });
    const [converted, changed] = await Promise.all([
      convert(q.body.prequote.publicId),
      change(),
    ]);
    expect([201, 409]).toContain(converted.status);
    expect([200, 409]).toContain(changed.status);
    expect(converted.status === 201 || changed.status === 200).toBe(true);
    const c = converted.status === 201 ? converted.body.result : await create();
    await api()
      .post('/api/v1/customer/profile/type')
      .auth(t.personal, bearer)
      .send({
        type: 'PERSONAL',
        expectedRevision:
          changed.status === 200 ? changed.body.revision : p.revision,
      })
      .expect(409);
    const row = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: c.deliveryRequestPublicId },
    });
    await expect(
      prisma.directRequestLifecycle.delete({
        where: { deliveryRequestId: row.id },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.directRequestLifecycle.update({
        where: { deliveryRequestId: row.id },
        data: {
          closedAt: new Date(),
          closureReason: 'CANCELLED',
          personalSlot: null,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.deliveryRequest.update({
        where: { id: row.id },
        data: { customerAccountId: customerIds.other },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.deliveryShippingTerms.update({
        where: { deliveryRequestId: row.id },
        data: { payer: 'RECIPIENT' },
      }),
    ).rejects.toThrow();
    await cancel(c.deliveryRequestPublicId).expect(200);
    await expect(
      prisma.directRequestLifecycle.update({
        where: { deliveryRequestId: row.id },
        data: {
          closedAt: null,
          closureReason: null,
          personalSlot: customerIds.personal,
        },
      }),
    ).rejects.toThrow();
    const current = (
      await api()
        .get('/api/v1/customer/profile')
        .auth(t.personal, bearer)
        .expect(200)
    ).body;
    await api()
      .post('/api/v1/customer/profile/type')
      .auth(t.personal, bearer)
      .send({ type: 'PERSONAL', expectedRevision: current.revision })
      .expect(200);
  }, 30000);
  it('B2B payer policy is admin-only, replayable and invalidates old unconverted MPQ', async () => {
    const client = await prisma.integrationClient.findUniqueOrThrow({
      where: { code: `${PREFIX}CLIENT_${run}` },
    });
    const path = '/api/v1/admin/integrations/' + client.id + '/shipping-policy';
    await api()
      .post(path)
      .auth(t.personal, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ payer: 'REQUESTER', expectedRevision: 1 })
      .expect(403);
    const q = await api()
      .post('/api/v1/delivery-prequotes')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ ...conditions, packages: [{ category: 'FOOD', quantity: 1 }] })
      .expect(201);
    const changeKey = randomUUID();
    const change = () =>
      api()
        .post(path)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', changeKey)
        .send({ payer: 'REQUESTER', expectedRevision: 1 });
    expect((await change().expect(200)).body).toEqual({
      payer: 'REQUESTER',
      revision: 2,
    });
    expect((await change().expect(200)).body.revision).toBe(2);
    const direct = conversion();
    const input = {
      conditionsVersion: 1,
      deliveryRequest: {
        ...direct.deliveryRequest,
        packages: [
          { category: 'FOOD', description: 'Synthetic food', quantity: 1 },
        ],
      },
      merchantConfirmation: {
        goodsPaymentStatus: 'CONFIRMED_BY_MERCHANT',
        goodsPaymentReference: 'synthetic-payment',
        goodsPaymentConfirmedAt: '2026-01-01T00:00:00Z',
        orderAcceptanceStatus: 'ACCEPTED_BY_MERCHANT',
        orderAcceptanceReference: 'synthetic-order',
        orderAcceptedAt: '2026-01-01T00:00:00Z',
      },
      deliveryCollectionInstruction: {
        payer: 'RECIPIENT',
        method: 'CASH',
        dueAt: 'DELIVERY',
        components: ['DELIVERY_FEE'],
      },
    };
    const rejected = await api()
      .post('/api/v1/delivery-prequotes/' + q.body.publicId + '/convert')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(input)
      .expect(409);
    expect(rejected.body.code).toBe('SHIPPING_POLICY_CHANGED');
  }, 30000);
  it('new non-converted B2B REQUESTER requires terms consent v2 and preserves configured payer without request override', async () => {
    const input = conversion();
    const created = await api()
      .post('/api/v1/delivery-requests')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ ...input.deliveryRequest, payerContact: input.payerContact })
      .expect(201);
    expect(created.body.shippingTerms.payer).toBe('REQUESTER');
    const q = await api()
      .post('/api/v1/delivery-requests/' + created.body.publicId + '/quotes')
      .auth(t.b2b, bearer)
      .expect(201);
    const path = '/api/v1/delivery-quotes/' + q.body.publicId + '/accept';
    await api().post(path).auth(t.b2b, bearer).send({}).expect(400);
    const body = {
      customerAuthorization: {
        version: 2,
        status: 'AUTHORIZED_BY_CUSTOMER',
        reference: 'synthetic-consent',
        authorizedAt: new Date().toISOString(),
        quotePublicId: q.body.publicId,
        amount: q.body.amount,
        currency: q.body.currency,
        expiresAt: q.body.expiresAt,
        shippingTermsVersion: 1,
        shippingTermsHash: created.body.shippingTerms.termsHash,
      },
    };
    await api()
      .post(path)
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(200);
    await api()
      .post('/api/v1/delivery-requests/' + created.body.publicId + '/cancel')
      .auth(t.b2b, bearer)
      .send({ reason: 'Synthetic cancellation' })
      .expect(200);
  }, 30000);
  const recover = (
    operation: string,
    key: string,
    resourcePublicId?: string,
    close = false,
    name = 'personal',
  ) => {
    const path = '/api/v1/customer/command-attempt' + (close ? '/close' : '');
    return (close ? api().post(path) : api().get(path))
      .auth(t[name], bearer)
      .set('Idempotency-Key', key)
      .query({ operation, ...(resourcePublicId ? { resourcePublicId } : {}) });
  };
  it('recovers original create, conversion and acceptance after response loss and app restart without bodies', async () => {
    const k = randomUUID();
    const q = await mpq('personal', 'REQUESTER', k).expect(201);
    await app.close();
    app = await bootstrap();
    const receipt = await recover('PREQUOTE_CREATE', k).expect(200);
    expect(receipt.body).toMatchObject({
      state: 'APPLIED',
      result: {
        prequotePublicId: q.body.prequote.publicId,
        amount: q.body.prequote.amount,
      },
    });
    expect(receipt.body.result).not.toHaveProperty('conditions');
    const ck = randomUUID();
    const c = (
      await convert(q.body.prequote.publicId, 'personal', ck).expect(201)
    ).body.result;
    const cr = await recover(
      'PREQUOTE_CONVERT',
      ck,
      q.body.prequote.publicId,
      true,
    ).expect(200);
    expect(cr.body).toMatchObject({
      state: 'APPLIED',
      result: {
        deliveryRequestPublicId: c.deliveryRequestPublicId,
        deliveryQuotePublicId: c.quote.publicId,
        shippingTerms: { termsHash: c.shippingTerms.termsHash },
      },
    });
    expect(JSON.stringify(cr.body)).not.toContain('Synthetic payer');
    const ak = randomUUID();
    await accept(c, 'personal', ak).then((r) => expect(r.status).toBe(200));
    await app.close();
    // A separate OS process has neither the original body nor application memory.
    const restarted = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { readFileSync } from 'node:fs';
      import { PrismaService } from './dist/prisma/prisma.service.js';
      import { CommandAttemptsService } from './dist/customers/command-attempts.service.js';
      const a=JSON.parse(readFileSync(0,'utf8')); const db=new PrismaService();
      try { console.log(JSON.stringify(await new CommandAttemptsService(db).customer(a.owner,a.actor,a.key,{operation:'QUOTE_ACCEPT',resourcePublicId:a.resource}))); }
      finally { await db.$disconnect(); }
    `,
      ],
      {
        input: JSON.stringify({
          owner: customerIds.personal,
          actor: users.personal,
          key: ak,
          resource: c.quote.publicId,
        }),
        encoding: 'utf8',
        timeout: 15000,
      },
    );
    expect(restarted.status).toBe(0);
    expect(JSON.parse(restarted.stdout)).toMatchObject({
      state: 'APPLIED',
      result: { deliveryQuotePublicId: c.quote.publicId },
    });
    app = await bootstrap();
    expect(
      (await recover('QUOTE_ACCEPT', ak, c.quote.publicId).expect(200)).body,
    ).toMatchObject({
      state: 'APPLIED',
      result: { deliveryQuotePublicId: c.quote.publicId },
    });
    await recover(
      'PREQUOTE_CONVERT',
      ck,
      q.body.prequote.publicId,
      false,
      'other',
    ).expect(404);
    expect(
      (
        await recover('PREQUOTE_CREATE', k, undefined, false, 'other').expect(
          200,
        )
      ).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    await recover('PREQUOTE_CONVERT', k, q.body.prequote.publicId).expect(409);
    await api()
      .get('/api/v1/customer/command-attempt')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', k)
      .query({ operation: 'PREQUOTE_CREATE' })
      .expect(401);
    await cancel(c.deliveryRequestPublicId).expect(200);
  });
  it('GET is read only; explicit close fences delayed create, conversion and acceptance without freeing quota', async () => {
    const k = randomUUID();
    expect((await recover('PREQUOTE_CREATE', k).expect(200)).body.state).toBe(
      'PENDING_OR_UNKNOWN',
    );
    expect(await prisma.humanCommandAttempt.count({ where: { key: k } })).toBe(
      0,
    );
    expect(
      (await recover('PREQUOTE_CREATE', k, undefined, true).expect(200)).body
        .state,
    ).toBe('CLOSED_NO_EFFECTS');
    expect((await mpq('personal', 'REQUESTER', k).expect(409)).body.code).toBe(
      'COMMAND_ATTEMPT_CLOSED',
    );
    const q = await mpq().expect(201);
    const ck = randomUUID();
    await recover(
      'PREQUOTE_CONVERT',
      ck,
      q.body.prequote.publicId,
      true,
    ).expect(200);
    expect(
      (await convert(q.body.prequote.publicId, 'personal', ck).expect(409)).body
        .code,
    ).toBe('COMMAND_ATTEMPT_CLOSED');
    const c = (await convert(q.body.prequote.publicId).expect(201)).body.result;
    const ak = randomUUID();
    await recover('QUOTE_ACCEPT', ak, c.quote.publicId, true).expect(200);
    expect((await accept(c, 'personal', ak)).body.code).toBe(
      'COMMAND_ATTEMPT_CLOSED',
    );
    expect(
      await prisma.directRequestLifecycle.count({
        where: { customerAccountId: customerIds.personal, closedAt: null },
      }),
    ).toBe(1);
    await cancel(c.deliveryRequestPublicId).expect(200);
  });
  it('serializes conversion/acceptance versus closure; rollback remains unknown until explicitly fenced', async () => {
    const q = await mpq().expect(201);
    const key = randomUUID();
    const [post, close] = await Promise.all([
      convert(q.body.prequote.publicId, 'personal', key),
      recover('PREQUOTE_CONVERT', key, q.body.prequote.publicId, true),
    ]);
    expect(close.status).toBe(200);
    expect([201, 409]).toContain(post.status);
    expect(close.body.state).toBe(
      post.status === 201 ? 'APPLIED' : 'CLOSED_NO_EFFECTS',
    );
    const c =
      post.status === 201
        ? post.body.result
        : (await convert(q.body.prequote.publicId).expect(201)).body.result;
    const badKey = randomUUID();
    const bad = {
      ...c,
      shippingTerms: { ...c.shippingTerms, termsHash: '0'.repeat(64) },
    };
    expect((await accept(bad, 'personal', badKey)).status).toBe(409);
    expect(
      (await recover('QUOTE_ACCEPT', badKey, c.quote.publicId).expect(200)).body
        .state,
    ).toBe('PENDING_OR_UNKNOWN');
    await recover('QUOTE_ACCEPT', badKey, c.quote.publicId, true).expect(200);
    expect((await accept(c, 'personal', badKey)).body.code).toBe(
      'COMMAND_ATTEMPT_CLOSED',
    );
    const ak = randomUUID();
    const [accepted, closed] = await Promise.all([
      accept(c, 'personal', ak),
      recover('QUOTE_ACCEPT', ak, c.quote.publicId, true),
    ]);
    expect(closed.status).toBe(200);
    expect([200, 409]).toContain(accepted.status);
    expect(closed.body.state).toBe(
      accepted.status === 200 ? 'APPLIED' : 'CLOSED_NO_EFFECTS',
    );
    await cancel(c.deliveryRequestPublicId).expect(200);
  });
  it('recovers exact final terms and original MQ from own MDR on another device without renewing TTL', async () => {
    const c = await create();
    await app.close();
    app = await bootstrap();
    const path =
      '/api/v1/customer/delivery-requests/' +
      c.deliveryRequestPublicId +
      '/consent-context';
    const ctx = await api().get(path).auth(t.personal, bearer).expect(200);
    expect(ctx.body).toMatchObject({
      deliveryRequestPublicId: c.deliveryRequestPublicId,
      quote: {
        publicId: c.quote.publicId,
        amount: c.quote.amount,
        currency: c.quote.currency,
        expiresAt: c.quote.expiresAt,
      },
      shippingTerms: { termsHash: c.shippingTerms.termsHash },
      canPrepareConsent: true,
      automaticAcceptance: false,
    });
    await api().get(path).auth(t.other, bearer).expect(404);
    await cancel(c.deliveryRequestPublicId).expect(200);
    expect(
      (await api().get(path).auth(t.personal, bearer).expect(200)).body
        .canPrepareConsent,
    ).toBe(false);
  });
  it('policy recovery proves original audit revision after later change; scope and late POST are fenced', async () => {
    const id = (
      await prisma.integrationClient.findFirstOrThrow({
        where: { code: { startsWith: PREFIX } },
      })
    ).id;
    const path = '/api/v1/admin/integrations/' + id + '/shipping-policy';
    const get = async () =>
      (await api().get(path).auth(t.sa, bearer).expect(200)).body;
    const original = await get();
    const key = randomUUID();
    const r = await api()
      .post(path)
      .auth(t.sa, bearer)
      .set('Idempotency-Key', key)
      .send({ payer: 'REQUESTER', expectedRevision: original.revision })
      .expect(200);
    await api()
      .post(path)
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ payer: 'RECIPIENT', expectedRevision: r.body.revision })
      .expect(200);
    const observed = await api()
      .get(path + '/attempt')
      .auth(t.sa, bearer)
      .set('Idempotency-Key', key)
      .expect(200);
    expect(observed.body).toMatchObject({ state: 'APPLIED', result: r.body });
    expect(
      (
        await api()
          .get(path + '/attempt')
          .auth(t.sa2, bearer)
          .set('Idempotency-Key', key)
          .expect(200)
      ).body,
    ).toMatchObject({ state: 'PENDING_OR_UNKNOWN', result: null });
    expect(
      (
        await api()
          .post(path + '/attempt/close')
          .auth(t.sa2, bearer)
          .set('Idempotency-Key', key)
          .expect(200)
      ).body.state,
    ).toBe('CLOSED_NO_EFFECTS');
    expect(
      (
        await api()
          .get(path + '/attempt')
          .auth(t.sa, bearer)
          .set('Idempotency-Key', key)
          .expect(200)
      ).body.result,
    ).toEqual(r.body);
    await api()
      .get(path + '/attempt')
      .auth(t.A, bearer)
      .set('Idempotency-Key', key)
      .expect(403);
    const late = randomUUID();
    await api()
      .post(path + '/attempt/close')
      .auth(t.sa, bearer)
      .set('Idempotency-Key', late)
      .expect(200);
    const current = await get();
    expect(
      (
        await api()
          .post(path)
          .auth(t.sa, bearer)
          .set('Idempotency-Key', late)
          .send({ payer: 'REQUESTER', expectedRevision: current.revision })
          .expect(409)
      ).body.code,
    ).toBe('COMMAND_ATTEMPT_CLOSED');
    const racing = randomUUID();
    const [write, closed] = await Promise.all([
      api()
        .post(path)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', racing)
        .send({ payer: 'REQUESTER', expectedRevision: current.revision }),
      api()
        .post(path + '/attempt/close')
        .auth(t.sa, bearer)
        .set('Idempotency-Key', racing)
        .expect(200),
    ]);
    if (write.status === 200)
      expect(closed.body).toMatchObject({
        state: 'APPLIED',
        result: write.body,
      });
    else {
      expect(write.status).toBe(409);
      expect(write.body.code).toBe('COMMAND_ATTEMPT_CLOSED');
      expect(closed.body.state).toBe('CLOSED_NO_EFFECTS');
    }
  });
  it('close fences an in-flight routing worker while retaining consumed budget and durable recovery', async () => {
    await app.close();
    app = await bootstrap(true);
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const entered = deferred(),
      release = deferred();
    const original = routing.calculateRoute;
    routing.calculateRoute = async () => {
      entered.resolve();
      await release.promise;
      return original();
    };
    const key = randomUUID();
    const running = mpq('personal', 'REQUESTER', key).then((r) => r);
    try {
      await Promise.race([
        entered.promise,
        new Promise((_, reject) =>
          setTimeout(() => reject(Error('Routing did not start')), 8000),
        ),
      ]);
      const pending = await recover('PREQUOTE_CREATE', key).expect(200);
      expect(pending.body).toMatchObject({
        state: 'PENDING_OR_UNKNOWN',
        routingEffects: 'POSSIBLE_RETAINED',
      });
      const close = await recover(
        'PREQUOTE_CREATE',
        key,
        undefined,
        true,
      ).expect(200);
      expect(close.body).toMatchObject({
        state: 'CLOSED_NO_EFFECTS',
        closureScope: 'RESOURCE_OR_POLICY_ONLY',
        routingEffects: 'POSSIBLE_RETAINED',
      });
    } finally {
      release.resolve();
      routing.calculateRoute = original;
    }
    expect((await running).body.code).toBe('COMMAND_ATTEMPT_CLOSED');
    const fence = await prisma.humanCommandAttempt.findFirstOrThrow({
      where: { key },
    });
    const permits = await prisma.prequoteConsumptionPermit.findMany({
      where: { humanAttemptId: fence.id },
    });
    expect(permits).toHaveLength(1);
    expect(permits[0].startedAt).not.toBeNull();
    expect(permits[0].units).toBeGreaterThan(0);
    expect(
      await prisma.deliveryPrequote.count({
        where: { record: { customerAccountId: customerIds.personal, key } },
      }),
    ).toBe(0);
    await app.close();
    app = await bootstrap(true);
    expect((await recover('PREQUOTE_CREATE', key).expect(200)).body.state).toBe(
      'CLOSED_NO_EFFECTS',
    );
    await mpq('personal', 'REQUESTER', key).expect(409);
    expect(
      await prisma.prequoteConsumptionPermit.count({
        where: { humanAttemptId: fence.id },
      }),
    ).toBe(1);
  }, 20000);
  it('expired/reserved workers cannot acquire routing or publish after closure', async () => {
    await app.close();
    app = await bootstrap(true);
    const { PrequotePersistenceService } =
      await import('../dist/delivery-prequotes/prequote-persistence.service.js');
    const { PREQUOTE_CONSUMPTION } =
      await import('../dist/delivery-prequotes/prequote-consumption.js');
    const store = app.get(PrequotePersistenceService);
    const consumption =
      app.get<
        import('../src/delivery-prequotes/prequote-consumption.js').PrequoteConsumption
      >(PREQUOTE_CONSUMPTION);
    const key = randomUUID();
    const owner = { kind: 'CUSTOMER' as const, id: customerIds.personal };
    const permit = await consumption.admit(owner, key);
    expect(permit.admitted).toBe(true);
    if (!permit.admitted) throw Error('Permit expected');
    const reserved = await store.reserve(
      owner,
      key,
      conditions,
      { leaseMs: 500, maxAttempts: 2 },
      'REQUESTER',
    );
    expect(reserved.kind).toBe('acquired');
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(
      (await recover('PREQUOTE_CREATE', key, undefined, true).expect(200)).body
        .routingEffects,
    ).toBe('NONE_STARTED');
    await expect(permit.permit.start()).rejects.toThrow();
    await expect(
      store.reserve(
        owner,
        key,
        conditions,
        { leaseMs: 90000, maxAttempts: 2 },
        'REQUESTER',
      ),
    ).rejects.toThrow();
    await permit.permit.finish({ routingStarted: false, published: false });
    const rows = await prisma.prequoteConsumptionPermit.findMany({
      where: { humanAttempt: { key } },
    });
    expect(rows[0].startedAt).toBeNull();
    expect(rows[0].state).toBe('CANCELLED');
  });
  const enableLocation = () => {
    app.get(ConfigService).set('LOCATION_TRACKING_ENABLED', true);
    app.get(ConfigService).set('SHARED_TRACKING_ENABLED', true);
    app.get(ConfigService).set('LOCATION_DRIVER_PER_MINUTE', 1000);
    app.get(ConfigService).set('LOCATION_OWNER_PER_MINUTE', 1000);
    app.get(ConfigService).set('LOCATION_RECIPIENT_PER_MINUTE', 1000);
    app.get(ConfigService).set('LOCATION_LINK_MUTATIONS_PER_TEN_MINUTES', 100);
  };
  const ownLocation = (id: string, name = 'personal') =>
    api()
      .get(`/api/v1/customer/delivery-requests/${id}/location`)
      .auth(t[name], bearer);
  const linkPath = (id: string) =>
    `/api/v1/customer/delivery-requests/${id}/tracking-link`;
  const linkWrite = (
    id: string,
    expectedLinkRevision: string,
    key = randomUUID(),
    revoke = false,
  ) =>
    api()
      .post(linkPath(id) + (revoke ? '/revoke' : ''))
      .auth(t.personal, bearer)
      .set('Idempotency-Key', key)
      .send({ expectedLinkRevision });
  async function gps(d: Awaited<ReturnType<typeof start>>) {
    const e = await head(d),
      path = `/api/v1/driver/dispatches/${d.id}/assignments/${e.activeAssignmentId}`;
    const before = await api()
      .get(path + '/location-stream')
      .auth(d.token, bearer)
      .expect(200);
    const opened = await api()
      .post(path + '/location-stream')
      .auth(d.token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedStreamRevision: before.body.streamRevision })
      .expect(200);
    const sample = {
      streamId: opened.body.streamId,
      sequence: 1,
      capturedAt: new Date().toISOString(),
      latitude: 17.42,
      longitude: -93.38,
      accuracyMeters: 12,
    };
    const send = (body = sample, token = d.token) =>
      api()
        .put(path + '/location')
        .auth(token, bearer)
        .send(body);
    return { path, sample, send };
  }
  async function finishGps(d: Awaited<ReturnType<typeof start>>) {
    const e = await head(d);
    const ordered = [
      'TO_PICKUP',
      'AT_PICKUP',
      'PICKED_UP',
      'TO_DROPOFF',
      'AT_DROPOFF',
    ];
    for (const phase of ordered.slice(
      e.phase ? ordered.indexOf(e.phase) + 1 : 0,
    )) {
      if (phase === 'PICKED_UP') await cash(d, await cashBody(d)).expect(200);
      expect((await step(d, phase)).status).toBe(200);
    }
    await appDeliver(d.id);
  }
  it('V1.18: owner/recipient phase gates, sample ordering, privacy, terminal withdrawal and independent authority', async () => {
    enableLocation();
    const d = await start('personal', true),
      id = d.c.deliveryRequestPublicId;
    expect((await ownLocation(id).expect(200)).body.location.sample).toBeNull();
    const initial = await api()
      .get(linkPath(id))
      .auth(t.personal, bearer)
      .expect(200);
    const issued = await linkWrite(id, initial.body.linkRevision).expect(201);
    const token = 'Tracking ' + new URL(issued.body.url).hash.slice(3);
    const shared = () =>
      api().get('/api/v1/shared/delivery-tracking').set('Authorization', token);
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    const g = await gps(d);
    await g.send().expect(200);
    expect((await g.send().expect(200)).body.outcome).toBe('DUPLICATE');
    await g.send({ ...g.sample, latitude: 18 }).expect(409);
    await g.send({ ...g.sample, sequence: 2, accuracyMeters: 101 }).expect(422);
    await g
      .send({
        ...g.sample,
        sequence: 2,
        capturedAt: new Date(Date.now() - 121000).toISOString(),
      })
      .expect(422);
    const newer=await g.send({...g.sample,sequence:3,capturedAt:new Date().toISOString(),accuracyMeters:100}).expect(200);
    const delayed=await g.send({...g.sample,sequence:2}).expect(200);
    expect(delayed.body).toMatchObject({outcome:'SUPERSEDED',acknowledgedSequence:null,currentSequence:3,locationVersion:newer.body.locationVersion});
    const observed = (await ownLocation(id).expect(200)).body;
    expect(observed.location.sample.latitude).toBe(17.42);
    expect((await ownLocation(id).expect(200)).body.location).toEqual(
      observed.location,
    );
    expect((await shared().expect(200)).body.location.sample).toBeNull();
    await ownLocation(id, 'other').expect(404);
    await g.send(g.sample, t.A).expect(403);
    await g.send(g.sample, t.otro).expect(404);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    await cash(d, await cashBody(d)).expect(200);
    expect((await step(d, 'PICKED_UP')).status).toBe(200);
    const visible = await shared().expect(200);
    expect(visible.body.location.sample.latitude).toBe(17.42);
    expect(Object.keys(visible.body).sort()).toEqual([
      'location',
      'observation',
      'progress',
      'publicId',
    ]);
    expect(JSON.stringify(visible.body)).not.toMatch(
      /contact|reasonDetail|driverId|actor|secret|shippingPayment/,
    );
    expect(visible.headers['cache-control']).toContain('no-store');
    await finishGps(d);
    const terminal = (await shared().expect(200)).body;
    expect(terminal.progress.terminalOutcome.type).toBe('DELIVERED');
    expect(terminal.location.sample).toBeNull();
    expect(BigInt(terminal.location.locationVersion)).toBeGreaterThan(
      BigInt(visible.body.location.locationVersion),
    );
    await g.send({ ...g.sample, sequence: 3 }).expect(404);
    expect(
      await prisma.deliveryLocationHead.findFirst({
        where: { deliveryRequest: { publicId: id } },
        select: { sample: true, sampleHash: true },
      }),
    ).toEqual({ sample: null, sampleHash: null });
    expect(logs.join('\n')).not.toContain(token);
    expect(logs.join('\n')).not.toContain(issued.body.url);
  });
  it('V1.18: durable one-time emission, explicit revocation fences late issuance, and concurrent CAS has one winner', async () => {
    enableLocation();
    const d = await start(),
      id = d.c.deliveryRequestPublicId;
    const initial = (
      await api().get(linkPath(id)).auth(t.personal, bearer).expect(200)
    ).body;
    const key = randomUUID();
    const pending = () =>
      api()
        .get(linkPath(id) + '/attempt')
        .auth(t.personal, bearer)
        .set('Idempotency-Key', key)
        .query({
          operation: 'ISSUE',
          expectedLinkRevision: initial.linkRevision,
        });
    expect((await pending().expect(200)).body.state).toBe('PENDING_OR_UNKNOWN');
    // Controlled failure in this dedicated synthetic database proves head/token/receipt atomicity.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION v118_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'CONTROLLED_LINK_RECEIPT_FAILURE'; END $$`,
    );
    await prisma.$executeRawUnsafe(
      `CREATE TRIGGER v118_fail_receipt BEFORE UPDATE OF receipt ON "DeliveryTrackingLinkHead" FOR EACH ROW EXECUTE FUNCTION v118_fail_receipt()`,
    );
    try {
      await linkWrite(id, initial.linkRevision, key).expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER v118_fail_receipt ON "DeliveryTrackingLinkHead"`,
      );
      await prisma.$executeRawUnsafe(`DROP FUNCTION v118_fail_receipt()`);
    }
    expect((await pending().expect(200)).body.state).toBe('PENDING_OR_UNKNOWN');
    expect(
      (await api().get(linkPath(id)).auth(t.personal, bearer).expect(200)).body,
    ).toMatchObject({ linkRevision: initial.linkRevision, status: 'NONE' });
    const issued = await linkWrite(id, initial.linkRevision, key).expect(201);
    expect(issued.body.secretAvailable).toBe(true);
    const replay = await linkWrite(id, initial.linkRevision, key).expect(200);
    expect(replay.body.secretAvailable).toBe(false);
    expect(replay.body.url).toBeUndefined();
    await app.close();
    app = await bootstrap();
    enableLocation();
    const recovery = () =>
      api()
        .get(linkPath(id) + '/attempt')
        .auth(t.personal, bearer)
        .set('Idempotency-Key', key)
        .query({
          operation: 'ISSUE',
          expectedLinkRevision: initial.linkRevision,
        });
    expect((await recovery().expect(200)).body.state).toBe(
      'APPLIED_SECRET_UNAVAILABLE',
    );
    await linkWrite(id, issued.body.linkRevision, randomUUID(), true).expect(
      200,
    );
    await api()
      .get('/api/v1/shared/delivery-tracking')
      .set(
        'Authorization',
        'Tracking ' + new URL(issued.body.url).hash.slice(3),
      )
      .expect(404);
    const meta = (
      await api().get(linkPath(id)).auth(t.personal, bearer).expect(200)
    ).body;
    const late = randomUUID();
    await linkWrite(id, meta.linkRevision, randomUUID(), true).expect(200);
    await linkWrite(id, meta.linkRevision, late).expect(409);
    expect(
      (
        await api()
          .get(linkPath(id) + '/attempt')
          .auth(t.personal, bearer)
          .set('Idempotency-Key', late)
          .query({
            operation: 'ISSUE',
            expectedLinkRevision: meta.linkRevision,
          })
          .expect(200)
      ).body.state,
    ).toBe('SUPERSEDED');
    const last = (
      await api().get(linkPath(id)).auth(t.personal, bearer).expect(200)
    ).body;
    const race = await Promise.all([
      linkWrite(id, last.linkRevision),
      linkWrite(id, last.linkRevision, randomUUID(), true),
    ]);
    expect(race.filter((x) => [200, 201].includes(x.status))).toHaveLength(1);
    expect(race.filter((x) => x.status === 409)).toHaveLength(1);
    await finishGps(d);
  });
  it('V1.18: fleet GPS concurrent with cancellation withdraws coordinates and denies late writes', async () => {
    enableLocation();
    const d = await start(),
      id = d.c.deliveryRequestPublicId;
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    const g = await gps(d);
    await g.send().expect(200);
    const before = (await ownLocation(id).expect(200)).body;
    const race = await Promise.all([
      g.send({
        ...g.sample,
        sequence: 2,
        capturedAt: new Date().toISOString(),
      }),
      cancel(id),
    ]);
    expect(race[1].status).toBe(200);
    expect([200, 404, 409]).toContain(race[0].status);
    const after = (await ownLocation(id).expect(200)).body;
    expect(after.location.sample).toBeNull();
    expect(BigInt(after.location.locationVersion)).toBeGreaterThan(
      BigInt(before.location.locationVersion),
    );
    await g.send({ ...g.sample, sequence: 3 }).expect(404);
  });
  it('V1.18: exact freshness, erasure, link expiry and terminal grace boundaries use validated capture time', async () => {
    enableLocation();
    const d = await start(),
      id = d.c.deliveryRequestPublicId;
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    const g = await gps(d);
    await g.send().expect(200);
    const { LocationClock } =
      await import('../dist/location/location.service.js');
    const clock = app.get(LocationClock),
      mock = vi.spyOn(clock, 'now');
    const sample = (await ownLocation(id).expect(200)).body.location.sample;
    mock.mockResolvedValue(new Date(sample.freshUntil));
    expect((await ownLocation(id).expect(200)).body.observation.freshness).toBe(
      'RECENT',
    );
    mock.mockResolvedValue(new Date(new Date(sample.freshUntil).getTime() + 1));
    expect((await ownLocation(id).expect(200)).body.observation.freshness).toBe(
      'STALE',
    );
    mock.mockResolvedValue(new Date(sample.eraseAfter));
    const erased = (await ownLocation(id).expect(200)).body;
    expect(erased.location.sample).toBeNull();
    expect(erased.observation.freshness).toBe('UNAVAILABLE');
    expect((await g.send().expect(200)).body.outcome).toBe('SUPERSEDED');
    mock.mockRestore();
    const meta = (
      await api().get(linkPath(id)).auth(t.personal, bearer).expect(200)
    ).body;
    const issued = (await linkWrite(id, meta.linkRevision).expect(201)).body;
    const shared = () =>
      api()
        .get('/api/v1/shared/delivery-tracking')
        .set('Authorization', 'Tracking ' + new URL(issued.url).hash.slice(3));
    const expiry = vi
      .spyOn(clock, 'now')
      .mockResolvedValue(new Date(issued.expiresAt));
    await shared().expect(404);
    expiry.mockRestore();
    await finishGps(d);
    const terminal = (await shared().expect(200)).body;
    const end =
      new Date(terminal.progress.terminalOutcome.occurredAt).getTime() +
      3600000;
    const grace = vi.spyOn(clock, 'now').mockResolvedValue(new Date(end - 1));
    await shared().expect(200);
    grace.mockResolvedValue(new Date(end));
    await shared().expect(404);
    grace.mockRestore();
  });
  it('V1.18: B2B explicit scopes and ownership; unassigned and legacy never fabricate GPS', async () => {
    enableLocation();
    const input = conversion();
    const created = await api()
      .post('/api/v1/delivery-requests')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ ...input.deliveryRequest, payerContact: input.payerContact })
      .expect(201);
    const id = created.body.publicId,
      path = '/api/v1/delivery-requests/' + id + '/location';
    await api().get(path).auth(t.b2b, bearer).expect(403);
    const client = await prisma.integrationClient.findUniqueOrThrow({
      where: { code: `${PREFIX}CLIENT_${run}` },
    });
    const credential = await api()
      .post(`/api/v1/admin/integrations/${client.id}/credentials`)
      .auth(t.sa, bearer)
      .send({
        scopes: [
          'deliveries:read',
          'deliveries:location:read',
          'deliveries:tracking-links:manage',
        ],
      })
      .expect(201);
    const auth = await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200);
    const token = auth.body.accessToken;
    const view = await api().get(path).auth(token, bearer).expect(200);
    expect(view.body.progress.trackingMode).toBeNull();
    expect(view.body.location.unavailableReason).toBe('NO_ASSIGNMENT');
    await ownLocation(id).expect(404);
    await api()
      .post(`/api/v1/delivery-requests/${id}/tracking-link`)
      .auth(token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ expectedLinkRevision: '1' })
      .expect(409);
    const direct = await create();
    await api()
      .get(
        '/api/v1/delivery-requests/' +
          direct.deliveryRequestPublicId +
          '/location',
      )
      .auth(token, bearer)
      .expect(404);
    await cancel(direct.deliveryRequestPublicId).expect(200);
    const business = await create('business', 'RECIPIENT');
    expect((await accept(business, 'business')).status).toBe(200);
    app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', false);
    const dispatch = await prisma.dispatch.findFirstOrThrow({
      where: {
        deliveryRequest: { publicId: business.deliveryRequestPublicId },
      },
    });
    await fundForAward(prisma, dispatch.id, { providerId: providers.A });
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const legacy = (
      await ownLocation(business.deliveryRequestPublicId, 'business').expect(
        200,
      )
    ).body;
    expect(legacy.progress.trackingMode).toBe('LEGACY');
    expect(legacy.location.unavailableReason).toBe('LEGACY_UNSUPPORTED');
    await cancel(business.deliveryRequestPublicId, 'business').expect(200);
  });
  it('V1.18: incident versus GPS and confirmed return remove the position without changing credit history', async () => {
    enableLocation();
    const d = await start(),
      id = d.c.deliveryRequestPublicId;
    expect((await step(d, 'TO_PICKUP')).status).toBe(200);
    const g = await gps(d);
    await g.send().expect(200);
    expect((await step(d, 'AT_PICKUP')).status).toBe(200);
    await cash(d, await cashBody(d)).expect(200);
    expect((await step(d, 'PICKED_UP')).status).toBe(200);
    const e = await head(d);
    const race = await Promise.all([
      api()
        .post(`/api/v1/driver/dispatches/${d.id}/custody-incidents`)
        .auth(d.token, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: e.activeAssignmentId,
          expectedRevision: e.revision,
          reasonCode: 'VEHICLE_FAILURE',
          reasonDetail: 'Synthetic incident',
        }),
      g.send({
        ...g.sample,
        sequence: 2,
        capturedAt: new Date().toISOString(),
      }),
    ]);
    expect(race[0].status).toBe(201);
    expect([200, 409]).toContain(race[1].status);
    expect((await ownLocation(id).expect(200)).body).toMatchObject({
      progress: { attentionRequired: true },
      location: { sample: null },
    });
    const count = await prisma.creditLedgerEntry.count({
      where: { referenceId: d.id },
    });
    const incident = race[0].body;
    const result = await api()
      .post(
        `/api/v1/admin/dispatches/${d.id}/custody-incidents/${incident.id}/resolve`,
      )
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: incident.execution.activeAssignmentId,
        expectedRevision: incident.execution.revision,
        type: 'RETURN_TO_ORIGIN',
        reason: 'Synthetic return',
        occurredAt: new Date().toISOString(),
        confirmationMethod: 'PHONE',
        custodianConfirmed: true,
        originConfirmed: true,
        originContactLabel: 'Synthetic restaurant',
        originContactRole: 'Manager',
      });
    expect(result.status).toBe(200);
    const view = (await ownLocation(id).expect(200)).body;
    expect(view.progress.terminalOutcome.type).toBe('RETURNED_TO_ORIGIN');
    expect(view.location.sample).toBeNull();
    expect(
      await prisma.creditLedgerEntry.count({ where: { referenceId: d.id } }),
    ).toBe(count);
  });
  it('admission remains explicitly gated, and logs exclude tokens and private payer data', async () => {
    const { LocationService } =
      await import('../dist/location/location.service.js');
    await app.get(LocationService).cleanup();
    app.get(ConfigService).set('CUSTOMER_ADMISSION_ENABLED', false);
    const caps = await api()
      .get('/api/v1/customer/capabilities')
      .auth(t.personal, bearer)
      .expect(200);
    expect(caps.body).toMatchObject({
      canCreateRequest: false,
      canPrequote: false,
      reason: 'CUSTOMER_ADMISSION_DISABLED',
    });
    await mpq().expect(503);
    const serialized = logs.join('\n');
    for (const token of Object.values(t))
      expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(password);
    expect(serialized).not.toContain('Synthetic payer');
    expect(serialized).not.toContain('0000000000');
  });
});
