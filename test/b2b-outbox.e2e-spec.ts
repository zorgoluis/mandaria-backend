import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import {
  fundForAward,
  purgeFixtureCredits,
  purgeFixtureDispatches,
} from './support/credits.js';

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

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_OUTBOX_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@b2b-outbox.test`.toLowerCase();
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
  calls: 0,
  async calculateRoute() {
    routing.calls += 1;
    return {
      distanceMeters: 3900,
      durationSeconds: 640,
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
const ZONE = { lng: -96.4, lat: 19.4 };
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
const ids: Record<string, string> = {};
let zoneId = '';
let app: INestApplication;
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;

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

/** A fresh app per block resets the in-memory throttler counters. */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}

/** Accepted quote → OPEN dispatch, with every actor funded for exactly this one service. */
async function openDispatch() {
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Avenida ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9615550011',
    instructions: `Portón ${sequence}`,
  });
  const reference = `OUT-${run}-${randomUUID().slice(0, 8)}`;
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: reference,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [{ category: 'FOOD', description: 'Comida', quantity: 1 }],
      financialContext: {
        goodsValue: '350.00',
        goodsPaymentMode: 'PREPAID',
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
  for (const providerId of [providers.A, providers.B])
    await fundForAward(prisma, dispatch.id, { providerId });
  await fundForAward(prisma, dispatch.id, { driverId: drivers.indy });
  return {
    id: dispatch.id,
    requestPublicId: req.body.publicId as string,
    reference,
  };
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
const deliver = (token: string, dispatchId: string, body: object = {}) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/deliver`)
    .auth(token, bearer)
    .send(body);
const driverDeliver = (token: string, dispatchId: string, body: object = {}) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/deliver`)
    .auth(token, bearer)
    .send(body);
const take = (token: string, dispatchId: string, vehicleId: string) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
const dispatchRow = (id: string) =>
  prisma.dispatch.findUniqueOrThrow({ where: { id } });
const assignmentsOf = (dispatchId: string) =>
  prisma.deliveryAssignment.findMany({
    where: { dispatchId },
    orderBy: { assignedAt: 'asc' },
  });
/**
 * Returns the fixtures to a clean state between cases that deliberately stop mid-flow: the ACTIVE
 * assignment ends and its dispatch stops being CLAIMED, so no case starts with a busy driver and
 * nothing is left in the shape «claimed with nobody executing it», which the global invariant
 * scans of other suites read as corruption. This is fixture teardown, not a business event, so the
 * award is purged with the *_test-only switch and the reversal then has nothing to return.
 */
async function freeFixtureResources() {
  const active = await prisma.deliveryAssignment.findMany({
    where: { driverId: { in: Object.values(drivers) }, status: 'ACTIVE' },
    select: { id: true, dispatchId: true },
  });
  for (const a of active) {
    await prisma.deliveryAssignment.update({
      where: { id: a.id },
      data: {
        status: 'CANCELLED',
        endedAt: new Date(),
        endedByUserId: users.sa,
        endReason: 'OPERATIONAL_CHANGE',
        endReasonDetail: 'E2E cleanup',
      },
    });
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.creditLedgerEntry.deleteMany({
        where: { type: 'SERVICE_REFUND', referenceId: a.dispatchId },
      }),
      prisma.creditLedgerEntry.deleteMany({
        where: { type: 'SERVICE_AWARD', referenceId: a.dispatchId },
      }),
      prisma.dispatch.updateMany({
        where: { id: a.dispatchId, status: 'CLAIMED' },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          cancellationReason: 'E2E_CLEANUP',
          claimedByProviderId: null,
          claimedByIndependentDriverId: null,
          claimedAt: null,
        },
      }),
    ]);
  }
}
beforeEach(freeFixtureResources);

/** A provider service already delivered: the common starting point of the terminality cases. */
async function deliveredByProvider() {
  const dispatch = await openDispatch();
  await claim(t.A, dispatch.id).expect(200);
  await assign(t.A, dispatch.id, {
    driverId: drivers.ana,
    vehicleId: vehicles.fleet1,
  }).expect(201);
  await deliver(t.A, dispatch.id).expect(200);
  return dispatch;
}

beforeAll(async () => {
  // Leftovers of a previous killed run would otherwise collide with these fixtures and with the
  // global invariant scans of other suites.
  await removeFixtures();
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
  t.otro = await login(mail('otro'));
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
    .send({ reason: 'Alta para V1.12-B' })
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
    .send({ name: 'B2B outbox client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
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
  ids.b2bClient = client.body.id as string;
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

/**
 * Removes every fixture of this suite from the shared *_test database. Everything is resolved by
 * prefix instead of from memory, so a run whose worker Vitest kills mid-flight cannot leave a
 * CLAIMED dispatch, an ACTIVE assignment or an unbalanced account behind for the suites that run
 * afterwards: the next run of this file cleans them up before creating its own.
 */
async function removeFixtures() {
  const userIds = (
    await prisma.user.findMany({
      where: { email: { endsWith: '@b2b-outbox.test' } },
      select: { id: true },
    })
  ).map((u) => u.id);
  const driverIds = (
    await prisma.driver.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    })
  ).map((d) => d.id);
  const providerIds = (
    await prisma.deliveryProvider.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const clientIds = (
    await prisma.integrationClient.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((c) => c.id);
  const zoneIds = (
    await prisma.serviceZone.findMany({
      where: { code: { startsWith: PREFIX } },
      select: { id: true },
    })
  ).map((z) => z.id);
  await purgeFixtureDispatches(prisma, clientIds);
  await prisma.deliveryAssignment.deleteMany({
    where: { driverId: { in: driverIds } },
  });
  await prisma.deliveryQuote.deleteMany({
    where: {
      OR: [
        { serviceZoneId: { in: zoneIds } },
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
  await prisma.driverVehicleAssignment.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.providerServiceCoverage.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.rateBand.deleteMany({
    where: { ratePlan: { serviceZoneId: { in: zoneIds } } },
  });
  await prisma.ratePlan.deleteMany({
    where: { serviceZoneId: { in: zoneIds } },
  });
  await prisma.serviceZone.deleteMany({ where: { id: { in: zoneIds } } });
  await purgeFixtureCredits(prisma, { providerIds, driverIds });
  await prisma.vehicle.deleteMany({
    where: { independentDriverProfile: { driverId: { in: driverIds } } },
  });
  await prisma.independentDriverProfile.deleteMany({
    where: { driverId: { in: driverIds } },
  });
  await prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
  await prisma.vehicle.deleteMany({
    where: { providerId: { in: providerIds } },
  });
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
}

afterAll(async () => {
  await removeFixtures();
  await prisma.$disconnect();
}, 120000);

const eventsOf = (dispatchId: string) =>
  prisma.b2bOutboxEvent.findMany({
    where: { dispatchId },
    orderBy: { recordedAt: 'asc' },
  });
const statusOf = (publicId: string) =>
  api().get(`/api/v1/delivery-requests/${publicId}/status`).auth(t.b2b, bearer);
/** Everything V1.10 holds, to prove recording an event is not an economic act. */
const economy = async () => ({
  accounts: (
    await prisma.creditAccount.findMany({
      select: { id: true, balance: true, updatedAt: true },
      orderBy: { id: 'asc' },
    })
  ).map((a) => `${a.id}:${a.balance.toString()}:${a.updatedAt.toISOString()}`),
  entries: await prisma.creditLedgerEntry.count(),
  awards: await prisma.creditLedgerEntry.count({
    where: { type: 'SERVICE_AWARD' },
  }),
  refunds: await prisma.creditLedgerEntry.count({
    where: { type: 'SERVICE_REFUND' },
  }),
  snapshots: await prisma.dispatchCreditSnapshot.count(),
  policies: await prisma.creditPolicy.count(),
});

describe('V1.12-B a completed delivery records its B2B event', () => {
  withApp();

  it('a provider delivery writes exactly one delivery.completed, owned by the right client', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    // Baseline taken here on purpose: the CLAIM is what charges credits (V1.10-D). Completing the
    // delivery and recording its event must move nothing at all.
    const before = await economy();
    const routingBefore = routing.calls;
    await deliver(t.A, dispatch.id).expect(200);

    const events = await eventsOf(dispatch.id);
    expect(events).toHaveLength(1);
    const [event] = events;
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    expect((await assignmentsOf(dispatch.id)).map((a) => a.status)).toEqual([
      'COMPLETED',
    ]);

    expect(event.type).toBe('DELIVERY_COMPLETED');
    expect(event.integrationClientId).toBe(ids.b2bClient);
    expect(event.deliveryRequestId).toBe(row.deliveryRequestId);
    expect(event.dispatchId).toBe(dispatch.id);
    // The event clock is the delivery's own, not a second reading.
    expect(event.occurredAt.toISOString()).toBe(row.deliveredAt!.toISOString());
    expect(event.id).not.toBe(row.deliveryRequestId);
    expect(event.payload).toEqual({
      publicId: dispatch.requestPublicId,
      externalReference: dispatch.reference,
      status: 'DELIVERED',
      execution: { mode: 'PROVIDER' },
      requestedAt: expect.any(String),
      deliveredAt: row.deliveredAt!.toISOString(),
      cancelledAt: null,
    });
    // Nothing economic and nothing geographic happened while recording it.
    expect(await economy()).toEqual(before);
    expect(routing.calls).toBe(routingBefore);
  });

  it('an independent delivery records the same event with INDEPENDENT execution', async () => {
    const dispatch = await openDispatch();
    const before = await economy();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const afterTake = await economy();
    await driverDeliver(t.indy, dispatch.id).expect(200);

    const events = await eventsOf(dispatch.id);
    expect(events).toHaveLength(1);
    const row = await dispatchRow(dispatch.id);
    expect(events[0].integrationClientId).toBe(ids.b2bClient);
    expect(events[0].payload).toMatchObject({
      publicId: dispatch.requestPublicId,
      externalReference: dispatch.reference,
      status: 'DELIVERED',
      execution: { mode: 'INDEPENDENT' },
      deliveredAt: row.deliveredAt!.toISOString(),
    });
    // TAKE charged credits; the completion itself moved nothing further.
    expect(await economy()).toEqual(afterTake);
    expect(afterTake).not.toEqual(before);
  });

  it('the snapshot is exactly what the V1.12-A endpoint answers at that moment', async () => {
    const dispatch = await deliveredByProvider();
    const status = await statusOf(dispatch.requestPublicId).expect(200);
    const [event] = await eventsOf(dispatch.id);
    // Two representations of the same delivery cannot contradict each other.
    expect(event.payload).toEqual(status.body);
  });

  it('the payload carries no internal identifier of any kind', async () => {
    const dispatch = await deliveredByProvider();
    const [event] = await eventsOf(dispatch.id);
    const payload = JSON.stringify(event.payload);
    expect(Object.keys(event.payload as object).sort()).toEqual([
      'cancelledAt',
      'deliveredAt',
      'execution',
      'externalReference',
      'publicId',
      'requestedAt',
      'status',
    ]);
    for (const forbidden of [
      dispatch.id,
      event.deliveryRequestId,
      event.integrationClientId,
      providers.A,
      drivers.ana,
      vehicles.fleet1,
      users.adminA,
      'deliveredByUserId',
      'creditCost',
      'ledger',
      'goodsValue',
      'Bearer',
      'secret',
      'token',
      'password',
      'postgres',
    ])
      expect(payload).not.toContain(forbidden);
  });

  it('the event outlives the process: it is in PostgreSQL, not in memory', async () => {
    const dispatch = await deliveredByProvider();
    const before = await eventsOf(dispatch.id);
    await app.close();
    app = await bootstrap();
    const after = await eventsOf(dispatch.id);
    expect(after).toEqual(before);
    // And the public status still agrees after the restart.
    expect((await statusOf(dispatch.requestPublicId).expect(200)).body).toEqual(
      before[0].payload,
    );
  });

  it('the snapshot is frozen: later legitimate changes to the request do not touch it', async () => {
    const dispatch = await deliveredByProvider();
    const [before] = await eventsOf(dispatch.id);
    // Cancelling the request afterwards is legitimate and does change the DeliveryRequest row.
    await api()
      .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'Contabilidad del cliente' })
      .expect(200);
    const request = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { id: before.deliveryRequestId },
    });
    expect(request.status).toBe('CANCELLED');
    expect(request.cancelledAt).not.toBeNull();
    // The event still describes what happened when it happened.
    expect(await eventsOf(dispatch.id)).toEqual([before]);
    expect(before.payload).toMatchObject({
      status: 'DELIVERED',
      cancelledAt: null,
    });
  });
});

describe('V1.12-B one delivery, one event', () => {
  withApp();

  it('repeating deliver keeps one event with the identical payload', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, dispatch.id).expect(200);
    const [first] = await eventsOf(dispatch.id);
    await deliver(t.A, dispatch.id).expect(200);
    await deliver(t.A, dispatch.id).expect(200);
    const events = await eventsOf(dispatch.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(first);
  });

  it('ten simultaneous provider completions produce one transition and one event', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        deliver(t.A, dispatch.id).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((s) => s === 200 || s === 409)).toBe(true);
    expect(await eventsOf(dispatch.id)).toHaveLength(1);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
    expect(
      (await assignmentsOf(dispatch.id)).filter(
        (a) => a.status === 'COMPLETED',
      ),
    ).toHaveLength(1);
  });

  it('ten simultaneous independent completions produce one transition and one event', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        driverDeliver(t.indy, dispatch.id).then((r) => r.status),
      ),
    );
    expect(results.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((s) => s === 200 || s === 409)).toBe(true);
    expect(await eventsOf(dispatch.id)).toHaveLength(1);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
  });
});

describe('V1.12-B the event and the delivery are the same commit', () => {
  withApp();

  it('a failing event insert rolls the whole delivery back', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const before = {
      economy: await economy(),
      dispatch: await dispatchRow(dispatch.id),
      assignments: await assignmentsOf(dispatch.id),
      events: await prisma.b2bOutboxEvent.count(),
    };
    // A real failure in real PostgreSQL, not a mock: any INSERT into the outbox aborts.
    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "e2e_outbox_break"() RETURNS trigger AS $fn$
      BEGIN RAISE EXCEPTION 'E2E_OUTBOX_BREAK: injected failure'; END $fn$ LANGUAGE plpgsql`);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "e2e_outbox_break" BEFORE INSERT ON "B2bOutboxEvent"
      FOR EACH ROW EXECUTE FUNCTION "e2e_outbox_break"()`);
    try {
      const failed = await deliver(t.A, dispatch.id);
      expect(failed.status).toBeGreaterThanOrEqual(400);
      // Nothing happened: not the dispatch, not the assignment, not the event, not the credits.
      expect(await dispatchRow(dispatch.id)).toEqual(before.dispatch);
      expect(await assignmentsOf(dispatch.id)).toEqual(before.assignments);
      expect(await prisma.b2bOutboxEvent.count()).toBe(before.events);
      expect(await economy()).toEqual(before.economy);
      expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
      expect((await assignmentsOf(dispatch.id)).map((a) => a.status)).toEqual([
        'ACTIVE',
      ]);
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS "e2e_outbox_break" ON "B2bOutboxEvent"`,
      );
      await prisma.$executeRawUnsafe(
        `DROP FUNCTION IF EXISTS "e2e_outbox_break"()`,
      );
    }
    // With the injected failure gone, the same delivery completes normally and records its event.
    await deliver(t.A, dispatch.id).expect(200);
    expect(await eventsOf(dispatch.id)).toHaveLength(1);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
  });

  it('PostgreSQL refuses a new DELIVERED that carries no event', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const [assignment] = await assignmentsOf(dispatch.id);
    // Writing the same transition by hand, skipping the outbox, is rejected at COMMIT.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.deliveryAssignment.update({
          where: { id: assignment.id },
          data: {
            status: 'COMPLETED',
            endedAt: new Date(),
            endedByUserId: users.adminA,
          },
        });
        await tx.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status: 'DELIVERED',
            deliveredAt: new Date(),
            deliveredByUserId: users.adminA,
          },
        });
      }),
    ).rejects.toThrow(/B2B_EVENT_REQUIRED/);
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
    expect(await eventsOf(dispatch.id)).toHaveLength(0);
  });
});

describe('V1.12-B a recorded event is history', () => {
  withApp();

  it('SQL cannot change its identity, its owner, its subject, its clock or its snapshot', async () => {
    const dispatch = await deliveredByProvider();
    const [event] = await eventsOf(dispatch.id);
    const other = await openDispatch();
    const mutations: [string, Promise<unknown>][] = [
      [
        'id',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "id" = gen_random_uuid() WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'type',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "type" = 'DELIVERY_COMPLETED' WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'owner',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "integrationClientId" = gen_random_uuid() WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'subject',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "dispatchId" = '${other.id}'::uuid WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'occurredAt',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "occurredAt" = now() WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'payload',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bOutboxEvent" SET "payload" = '{"publicId":"MDR-000001"}'::jsonb WHERE id = '${event.id}'::uuid`,
        ),
      ],
      [
        'delete',
        prisma.$executeRawUnsafe(
          `DELETE FROM "B2bOutboxEvent" WHERE id = '${event.id}'::uuid`,
        ),
      ],
      ['truncate', prisma.$executeRawUnsafe(`TRUNCATE TABLE "B2bOutboxEvent"`)],
    ];
    const rejected: string[] = [];
    for (const [name, attempt] of mutations)
      await attempt.then(
        () => undefined,
        () => rejected.push(name),
      );
    expect(rejected).toEqual([
      'id',
      'type',
      'owner',
      'subject',
      'occurredAt',
      'payload',
      'delete',
      'truncate',
    ]);
    expect(await eventsOf(dispatch.id)).toEqual([event]);
  });

  it('SQL cannot record a second delivery.completed for the same delivery', async () => {
    const dispatch = await deliveredByProvider();
    const [event] = await eventsOf(dispatch.id);
    await expect(
      prisma.b2bOutboxEvent.create({
        data: {
          type: 'DELIVERY_COMPLETED',
          integrationClientId: event.integrationClientId,
          deliveryRequestId: event.deliveryRequestId,
          dispatchId: event.dispatchId,
          occurredAt: event.occurredAt,
          payload: event.payload as never,
        },
      }),
    ).rejects.toThrow();
    expect(await eventsOf(dispatch.id)).toHaveLength(1);
  });

  it('SQL cannot record an event for a delivery that is not being delivered right now', async () => {
    const open = await openDispatch();
    const request = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: open.requestPublicId },
      select: { id: true, integrationClientId: true, requestedAt: true },
    });
    const payload = {
      publicId: open.requestPublicId,
      externalReference: open.reference,
      status: 'DELIVERED',
      execution: { mode: 'PROVIDER' },
      requestedAt: request.requestedAt.toISOString(),
      deliveredAt: new Date().toISOString(),
      cancelledAt: null,
    };
    await expect(
      prisma.b2bOutboxEvent.create({
        data: {
          type: 'DELIVERY_COMPLETED',
          integrationClientId: request.integrationClientId,
          deliveryRequestId: request.id,
          dispatchId: open.id,
          occurredAt: new Date(payload.deliveredAt),
          payload,
        },
      }),
    ).rejects.toThrow(/B2B_EVENT_INVALID/);
    expect(await eventsOf(open.id)).toHaveLength(0);
  });

  it('SQL cannot attribute an event to a client that does not own the request', async () => {
    const dispatch = await deliveredByProvider();
    const [event] = await eventsOf(dispatch.id);
    const stranger = await api()
      .post('/api/v1/admin/integrations')
      .auth(t.sa, bearer)
      .send({ name: 'B2B outbox stranger', code: `${PREFIX}OTHER_${run}` })
      .expect(201);
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "B2bOutboxEvent" ("id","type","integrationClientId","deliveryRequestId","dispatchId","occurredAt","payload")
         VALUES (gen_random_uuid(), 'DELIVERY_COMPLETED', '${stranger.body.id}'::uuid, '${event.deliveryRequestId}'::uuid,
                 '${dispatch.id}'::uuid, now(), '${JSON.stringify(event.payload)}'::jsonb)`,
      ),
    ).rejects.toThrow();
    // A non-existent client and a non-existent request are refused just the same.
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "B2bOutboxEvent" ("id","type","integrationClientId","deliveryRequestId","dispatchId","occurredAt","payload")
         VALUES (gen_random_uuid(), 'DELIVERY_COMPLETED', gen_random_uuid(), '${event.deliveryRequestId}'::uuid,
                 '${dispatch.id}'::uuid, now(), '${JSON.stringify(event.payload)}'::jsonb)`,
      ),
    ).rejects.toThrow();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "B2bOutboxEvent" ("id","type","integrationClientId","deliveryRequestId","dispatchId","occurredAt","payload")
         VALUES (gen_random_uuid(), 'DELIVERY_COMPLETED', '${event.integrationClientId}'::uuid, gen_random_uuid(),
                 '${dispatch.id}'::uuid, now(), '${JSON.stringify(event.payload)}'::jsonb)`,
      ),
    ).rejects.toThrow();
    expect(await eventsOf(dispatch.id)).toHaveLength(1);
  });
});

describe('V1.12-B deliveries older than the outbox', () => {
  withApp();

  it('a delivery completed before the boundary keeps no event and stays observable', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, dispatch.id).expect(200);
    // Reproduce what a pre-V1.12-B row looks like: DELIVERED with no event. The enforcement is a
    // trigger on the *transition*, so removing the event of an already delivered dispatch leaves a
    // perfectly legitimate historical row, which is exactly the shape of the 22 that already exist.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.b2bOutboxEvent.deleteMany({ where: { dispatchId: dispatch.id } }),
    ]);
    expect(await eventsOf(dispatch.id)).toHaveLength(0);
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    // V1.12-A still answers for it: a historical delivery is not corruption.
    const status = await statusOf(dispatch.requestPublicId).expect(200);
    expect(status.body).toMatchObject({
      status: 'DELIVERED',
      execution: { mode: 'PROVIDER' },
      deliveredAt: row.deliveredAt!.toISOString(),
    });
  });

  it('the integrity scan finds no violation across the whole database', async () => {
    await deliveredByProvider();
    const [scan] = await prisma.$queryRawUnsafe<Record<string, bigint>[]>(`
      SELECT
        (SELECT count(*) FROM (
           SELECT "dispatchId" FROM "B2bOutboxEvent" WHERE "type" = 'DELIVERY_COMPLETED'
            GROUP BY "dispatchId" HAVING count(*) > 1) x) AS duplicated,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE NOT EXISTS (SELECT 1 FROM "DeliveryRequest" r
                             WHERE r.id = e."deliveryRequestId"
                               AND r."integrationClientId" = e."integrationClientId")) AS wrong_owner,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE e."type" = 'DELIVERY_COMPLETED'
            AND NOT EXISTS (SELECT 1 FROM "Dispatch" d
                             WHERE d.id = e."dispatchId"
                               AND d."deliveryRequestId" = e."deliveryRequestId"
                               AND d."status" = 'DELIVERED')) AS wrong_subject,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE e."type" = 'DELIVERY_COMPLETED'
            AND (e."payload"->>'status') IS DISTINCT FROM 'DELIVERED') AS snapshot_not_delivered,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE (e."payload"->>'publicId') IS NULL) AS payload_without_public_id,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE e."payload" ?| ARRAY['id','dispatchId','deliveryRequestId','integrationClientId',
                                     'providerId','driverId','vehicleId','deliveredByUserId']) AS payload_internal_ids,
        (SELECT count(*) FROM "B2bOutboxEvent" e JOIN "Dispatch" d ON d.id = e."dispatchId"
          WHERE e."type" = 'DELIVERY_COMPLETED' AND d."deliveredAt" IS DISTINCT FROM e."occurredAt") AS clock_drift,
        (SELECT count(*) FROM "B2bOutboxEvent" e
          WHERE e."type" = 'DELIVERY_COMPLETED'
            AND (("payload"->>'deliveredAt')::timestamptz AT TIME ZONE 'UTC') IS DISTINCT FROM e."occurredAt") AS payload_clock_drift
    `);
    const violations = Object.fromEntries(
      Object.entries(scan).map(([k, v]) => [k, Number(v)]),
    );
    expect(violations).toEqual({
      duplicated: 0,
      wrong_owner: 0,
      wrong_subject: 0,
      snapshot_not_delivered: 0,
      payload_without_public_id: 0,
      payload_internal_ids: 0,
      clock_drift: 0,
      payload_clock_drift: 0,
    });
  });
});
