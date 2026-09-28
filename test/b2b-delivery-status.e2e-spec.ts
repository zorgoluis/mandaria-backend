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
  independentBalance,
  providerBalance,
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
const PREFIX = 'E2E_B2BST_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@b2b-status.test`.toLowerCase();
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
const ZONE = { lng: -94.4, lat: 17.4 };
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
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `BST-${run}-${randomUUID().slice(0, 8)}`,
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
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
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
    .send({ reason: 'Alta para V1.12-A' })
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
    .send({ name: 'B2B status client A', code: `${PREFIX}CLIENT_${run}` })
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
  t.b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  // A second IntegrationClient, so ownership isolation is proven with a real foreign token.
  const otherClient = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'B2B status client B', code: `${PREFIX}CLIENT_B_${run}` })
    .expect(201);
  const otherCredential = await api()
    .post(`/api/v1/admin/integrations/${otherClient.body.id}/credentials`)
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
  t.b2bOther = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: otherCredential.body.clientId,
        clientSecret: otherCredential.body.clientSecret,
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
      where: { email: { endsWith: '@b2b-status.test' } },
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

const statusOf = (token: string, publicId: string) =>
  api().get(`/api/v1/delivery-requests/${publicId}/status`).auth(token, bearer);

/** Everything the V1.10 economy holds, to prove that a read never moves any of it. */
const economy = async () => ({
  accounts: (
    await prisma.creditAccount.findMany({
      select: { id: true, balance: true, updatedAt: true },
      orderBy: { id: 'asc' },
    })
  ).map((a) => ({ ...a, balance: a.balance.toString() })),
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

describe('V1.12-A a B2B client can observe its own delivery', () => {
  withApp();

  it('reports every public state of a provider service, ending in DELIVERED', async () => {
    const dispatch = await openDispatch();
    const open = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(open.body).toMatchObject({
      publicId: dispatch.requestPublicId,
      status: 'OPEN',
      execution: null,
      deliveredAt: null,
      cancelledAt: null,
    });
    expect(open.body.externalReference).toMatch(/^BST-/);
    expect(typeof open.body.requestedAt).toBe('string');

    await claim(t.A, dispatch.id).expect(200);
    const claimed = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(claimed.body).toMatchObject({
      status: 'ASSIGNED',
      execution: { mode: 'PROVIDER' },
      deliveredAt: null,
    });

    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    // Who drives is an internal matter: publicly the service is still ASSIGNED.
    const assigned = await statusOf(t.b2b, dispatch.requestPublicId).expect(
      200,
    );
    expect(assigned.body).toMatchObject({
      status: 'ASSIGNED',
      execution: { mode: 'PROVIDER' },
      deliveredAt: null,
    });

    await deliver(t.A, dispatch.id).expect(200);
    const delivered = await statusOf(t.b2b, dispatch.requestPublicId).expect(
      200,
    );
    const row = await dispatchRow(dispatch.id);
    expect(delivered.body).toMatchObject({
      status: 'DELIVERED',
      execution: { mode: 'PROVIDER' },
      cancelledAt: null,
    });
    expect(delivered.body.deliveredAt).toBe(row.deliveredAt!.toISOString());
  });

  it('reports an independent delivery with the same public shape', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const taken = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(taken.body).toMatchObject({
      status: 'ASSIGNED',
      execution: { mode: 'INDEPENDENT' },
      deliveredAt: null,
    });
    await driverDeliver(t.indy, dispatch.id).expect(200);
    const delivered = await statusOf(t.b2b, dispatch.requestPublicId).expect(
      200,
    );
    const row = await dispatchRow(dispatch.id);
    expect(delivered.body).toMatchObject({
      status: 'DELIVERED',
      execution: { mode: 'INDEPENDENT' },
    });
    expect(delivered.body.deliveredAt).toBe(row.deliveredAt!.toISOString());
  });

  it('a request with no accepted quote is REQUESTED, never a 500', async () => {
    const stop = (type: string, sequence: number, d: number) => ({
      type,
      sequence,
      address: `Avenida ${run} ${sequence}`,
      latitude: ZONE.lat + d,
      longitude: ZONE.lng + d,
      contactName: `Contacto ${run}`,
      contactPhone: '9615550011',
    });
    const req = await api()
      .post('/api/v1/delivery-requests')
      .auth(t.b2b, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        externalReference: `BST-${run}-noquote`,
        stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
        packages: [{ category: 'FOOD', description: 'Comida', quantity: 1 }],
        financialContext: {
          goodsValue: '350.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      })
      .expect(201);
    const status = await statusOf(t.b2b, req.body.publicId).expect(200);
    expect(status.body).toMatchObject({
      status: 'REQUESTED',
      execution: null,
      deliveredAt: null,
      cancelledAt: null,
    });
  });

  it('a cancelled request reads as CANCELLED with its timestamp', async () => {
    const dispatch = await openDispatch();
    await api()
      .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'El cliente ya no lo necesita' })
      .expect(200);
    const status = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(status.body).toMatchObject({
      status: 'CANCELLED',
      deliveredAt: null,
    });
    expect(typeof status.body.cancelledAt).toBe('string');
  });

  it('a lapsed dispatch reads as EXPIRED, distinct from a cancellation', async () => {
    const dispatch = await openDispatch();
    // The window is immutable (DISPATCH_IMMUTABLE) and the TTL lasts minutes, so the fixture
    // writes the very state the real expiry path persists: OPEN -> EXPIRED with its stamp.
    await prisma.dispatch.update({
      where: { id: dispatch.id },
      data: { status: 'EXPIRED', expiredAt: new Date() },
    });
    const status = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(status.body).toMatchObject({
      status: 'EXPIRED',
      execution: null,
      deliveredAt: null,
      cancelledAt: null,
    });
  });

  it('exposes only the public contract: no internal ids, no credits, no payment context', async () => {
    const dispatch = await deliveredByProvider();
    const status = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(Object.keys(status.body).sort()).toEqual([
      'cancelledAt',
      'deliveredAt',
      'execution',
      'externalReference',
      'publicId',
      'requestedAt',
      'status',
    ]);
    const body = JSON.stringify(status.body);
    for (const forbidden of [
      dispatch.id,
      'deliveredByUserId',
      'driverId',
      'vehicleId',
      'providerId',
      'dispatchId',
      'creditCost',
      'credit',
      'ledger',
      'goodsValue',
      'deliveryFee',
      'noProviderAvailable',
      'claimedBy',
    ])
      expect(body).not.toContain(forbidden);
  });
});

describe('V1.12-A ownership and authorization', () => {
  withApp();

  it('another IntegrationClient gets a 404 indistinguishable from a request that does not exist', async () => {
    const dispatch = await openDispatch();
    const owned = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    const foreign = await statusOf(t.b2bOther, dispatch.requestPublicId).expect(
      404,
    );
    const unknown = await statusOf(t.b2bOther, 'MDR-999999').expect(404);
    // Only the caller's own echoed inputs may differ; everything else must be identical, so a
    // foreign publicId cannot be told apart from one that was never issued.
    const shape = (body: Record<string, unknown>) => ({
      ...body,
      timestamp: undefined,
      requestId: undefined,
      path: undefined,
    });
    expect(shape(foreign.body)).toEqual(shape(unknown.body));
    expect(foreign.body.message).toBe('Delivery request not found');
    // Not one field of the real request escapes with the rejection.
    const leaked = JSON.stringify(foreign.body);
    for (const value of Object.values(owned.body).filter(
      (v) => typeof v === 'string' && v !== dispatch.requestPublicId,
    ))
      expect(leaked).not.toContain(value as string);
    expect(leaked).not.toContain(dispatch.id);
    // The owner still sees it: the 404 is isolation, not absence.
    await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
  });

  it('an unknown request of my own answers with the same rejection', async () => {
    const unknown = await statusOf(t.b2b, 'MDR-999999').expect(404);
    expect(unknown.body.message).toBe('Delivery request not found');
  });

  it('human and missing credentials cannot read the B2B status', async () => {
    const dispatch = await openDispatch();
    const attempts = {
      superAdmin: (await statusOf(t.sa, dispatch.requestPublicId)).status,
      providerAdmin: (await statusOf(t.A, dispatch.requestPublicId)).status,
      driver: (await statusOf(t.indy, dispatch.requestPublicId)).status,
      anonymous: (
        await api().get(
          `/api/v1/delivery-requests/${dispatch.requestPublicId}/status`,
        )
      ).status,
      garbage: (await statusOf('not-a-token', dispatch.requestPublicId)).status,
    };
    expect(attempts).toEqual({
      superAdmin: 401,
      providerAdmin: 401,
      driver: 401,
      anonymous: 401,
      garbage: 401,
    });
  });

  it('a token without deliveries:read cannot read the status', async () => {
    const dispatch = await openDispatch();
    const limited = await api()
      .post('/api/v1/admin/integrations')
      .auth(t.sa, bearer)
      .send({ name: 'B2B status no-read', code: `${PREFIX}CLIENT_NR_${run}` })
      .expect(201);
    const credential = await api()
      .post(`/api/v1/admin/integrations/${limited.body.id}/credentials`)
      .auth(t.sa, bearer)
      .send({ scopes: ['deliveries:create'] })
      .expect(201);
    const token = (
      await api()
        .post('/api/v1/integrations/token')
        .send({
          clientId: credential.body.clientId,
          clientSecret: credential.body.clientSecret,
        })
        .expect(200)
    ).body.accessToken as string;
    await statusOf(token, dispatch.requestPublicId).expect(403);
  });

  it('a B2B client has no way to move the delivery itself', async () => {
    const dispatch = await openDispatch();
    const mutations = await Promise.all([
      api()
        .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/status`)
        .auth(t.b2b, bearer)
        .send({ status: 'DELIVERED' })
        .then((r) => r.status),
      api()
        .patch(`/api/v1/delivery-requests/${dispatch.requestPublicId}/status`)
        .auth(t.b2b, bearer)
        .send({ status: 'DELIVERED' })
        .then((r) => r.status),
      api()
        .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/delivered`)
        .auth(t.b2b, bearer)
        .send({})
        .then((r) => r.status),
      api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/claim`)
        .auth(t.b2b, bearer)
        .send({})
        .then((r) => r.status),
      api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/deliver`)
        .auth(t.b2b, bearer)
        .send({})
        .then((r) => r.status),
      api()
        .post(`/api/v1/driver/dispatches/${dispatch.id}/take`)
        .auth(t.b2b, bearer)
        .send({ vehicleId: vehicles.indy })
        .then((r) => r.status),
    ]);
    expect(mutations.every((s) => s === 404 || s === 401)).toBe(true);
    expect((await dispatchRow(dispatch.id)).status).toBe('OPEN');
  });
});

describe('V1.12-A reading has no consequences', () => {
  withApp();

  it('repeated reads change nothing: no economy, no dispatch, no assignment, no routing', async () => {
    const dispatch = await deliveredByProvider();
    const before = {
      economy: await economy(),
      dispatch: await dispatchRow(dispatch.id),
      assignments: await assignmentsOf(dispatch.id),
      routing: routing.calls,
      providerBalance: (await providerBalance(prisma, providers.A)).toString(),
      independentBalance: String(
        await independentBalance(prisma, drivers.indy),
      ),
      logs: logs.length,
    };
    const reads: string[] = [];
    for (let i = 0; i < 12; i += 1)
      reads.push(
        JSON.stringify((await statusOf(t.b2b, dispatch.requestPublicId)).body),
      );
    // Twelve identical answers, and nothing behind them moved.
    expect(new Set(reads).size).toBe(1);
    expect(await economy()).toEqual(before.economy);
    expect(await dispatchRow(dispatch.id)).toEqual(before.dispatch);
    expect(await assignmentsOf(dispatch.id)).toEqual(before.assignments);
    expect(routing.calls).toBe(before.routing);
    expect((await providerBalance(prisma, providers.A)).toString()).toBe(
      before.providerBalance,
    );
    expect(String(await independentBalance(prisma, drivers.indy))).toBe(
      before.independentBalance,
    );
    // A read is not an event: it emits no audit line about this delivery.
    expect(
      logs
        .slice(before.logs)
        .filter((l) => l.includes(dispatch.requestPublicId)),
    ).toEqual([]);
  });

  it('many simultaneous reads are safe and agree with each other', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    const before = await economy();
    const results = await Promise.all(
      Array.from({ length: 15 }, () =>
        statusOf(t.b2b, dispatch.requestPublicId).then((r) => ({
          status: r.status,
          body: JSON.stringify(r.body),
        })),
      ),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    expect(new Set(results.map((r) => r.body)).size).toBe(1);
    expect(await economy()).toEqual(before);
  });

  it('a read racing the delivery is coherent: never DELIVERED without its timestamp', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const [delivery, ...reads] = await Promise.all([
      deliver(t.A, dispatch.id).then((r) => r.status),
      ...Array.from({ length: 10 }, () =>
        statusOf(t.b2b, dispatch.requestPublicId).then(
          (r) => r.body as { status: string; deliveredAt: string | null },
        ),
      ),
    ]);
    expect(delivery).toBe(200);
    for (const body of reads) {
      expect(['ASSIGNED', 'DELIVERED']).toContain(body.status);
      // The hybrid that must never be observable.
      if (body.status === 'DELIVERED') expect(body.deliveredAt).not.toBeNull();
      else expect(body.deliveredAt).toBeNull();
    }
    const settled = await statusOf(t.b2b, dispatch.requestPublicId).expect(200);
    expect(settled.body.status).toBe('DELIVERED');
    expect(settled.body.deliveredAt).not.toBeNull();
  });
});

describe('V1.12-G public execution identity CHECK', () => {
  withApp();
  const configureName = (key: string, displayName: string | null) =>
    api()
      .patch(`/api/v1/admin/providers/${providers.A}/drivers/${drivers[key]}`)
      .auth(t.sa, bearer)
      .send({ displayName });
  const eventFor = (dispatchId: string) =>
    prisma.b2bOutboxEvent.findFirstOrThrow({ where: { dispatchId } });

  it('rejects a forged Outbox identity and rolls back the entire completion including its snapshot', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const original = await dispatchRow(dispatch.id);
    const assignments = await assignmentsOf(dispatch.id);
    const before = await economy();
    const subject = await prisma.deliveryRequest.findUniqueOrThrow({
      where: { publicId: dispatch.requestPublicId },
    });
    const current = (
      await statusOf(t.b2b, dispatch.requestPublicId).expect(200)
    ).body;
    await expect(
      prisma.$transaction(async (tx) => {
        const at = new Date();
        await tx.$queryRaw`SELECT id FROM "Dispatch" WHERE id = ${dispatch.id}::uuid FOR UPDATE`;
        await tx.deliveryAssignment.update({
          where: { id: assignments[0].id },
          data: {
            status: 'COMPLETED',
            endedAt: at,
            endedByUserId: users.adminA,
          },
        });
        await tx.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status: 'DELIVERED',
            deliveredAt: at,
            deliveredByUserId: users.adminA,
          },
        });
        await tx.b2bOutboxEvent.create({
          data: {
            type: 'DELIVERY_COMPLETED',
            integrationClientId: subject.integrationClientId,
            deliveryRequestId: subject.id,
            dispatchId: dispatch.id,
            occurredAt: at,
            payload: {
              ...current,
              status: 'DELIVERED',
              deliveredAt: at.toISOString(),
              execution: {
                mode: 'PROVIDER',
                provider: null,
                driver: { displayName: 'Wrong assignment' },
              },
            },
          },
        });
      }),
    ).rejects.toThrow(/PUBLIC_EXECUTION_MISMATCH/);
    expect(await dispatchRow(dispatch.id)).toEqual(original);
    expect(await assignmentsOf(dispatch.id)).toEqual(assignments);
    expect(
      await prisma.b2bOutboxEvent.count({ where: { dispatchId: dispatch.id } }),
    ).toBe(0);
    expect(await economy()).toEqual(before);
  });

  it('configures only explicit public names, validates them and preserves provider isolation', async () => {
    for (const displayName of ['', '  ', 'a'.repeat(101), 42])
      await configureName('ana', displayName as string).expect(400);
    const saved = await configureName('ana', '  Ana pública  ').expect(200);
    expect(saved.body.displayName).toBe('Ana pública');
    await api()
      .patch(`/api/v1/provider/drivers/${drivers.ana}`)
      .auth(t.B, bearer)
      .send({ displayName: 'forged' })
      .expect(404);
    await api()
      .patch(`/api/v1/admin/providers/${providers.A}/drivers/${drivers.ana}`)
      .auth(t.b2b, bearer)
      .send({ displayName: 'forged' })
      .expect(401);
    expect(
      (await configureName('ana', null).expect(200)).body.displayName,
    ).toBeNull();
  });

  it('claim, assignment, reassignment, completion and later profile changes preserve the right identity', async () => {
    await configureName('ana', 'Ana pública').expect(200);
    await configureName('beto', 'Beto público').expect(200);
    const dispatch = await openDispatch();
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body
        .execution,
    ).toBeNull();
    await claim(t.A, dispatch.id).expect(200);
    const claimed = (
      await statusOf(t.b2b, dispatch.requestPublicId).expect(200)
    ).body;
    expect(claimed.execution).toEqual({
      mode: 'PROVIDER',
      provider: { displayName: `Proveedor A ${run}` },
      driver: null,
    });
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId)).body.execution.driver,
    ).toEqual({ displayName: 'Ana pública' });
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/reassign`)
      .auth(t.A, bearer)
      .send({
        driverId: drivers.beto,
        vehicleId: vehicles.fleet2,
        reason: 'OPERATIONAL_CHANGE',
      })
      .expect(200);
    const reassigned = (
      await statusOf(t.b2b, dispatch.requestPublicId).expect(200)
    ).body;
    expect(reassigned.execution.driver).toEqual({
      displayName: 'Beto público',
    });
    const before = {
      economy: await economy(),
      routing: routing.calls,
      quote: await prisma.deliveryQuote.findFirstOrThrow({
        where: { deliveryRequest: { publicId: dispatch.requestPublicId } },
      }),
      request: await prisma.deliveryRequest.findUniqueOrThrow({
        where: { publicId: dispatch.requestPublicId },
      }),
    };
    await deliver(t.A, dispatch.id).expect(200);
    const final = (await statusOf(t.b2b, dispatch.requestPublicId).expect(200))
      .body;
    const event = await eventFor(dispatch.id);
    expect(event.payload).toEqual(final);
    expect((await dispatchRow(dispatch.id)).publicExecutionSnapshot).toEqual(
      final.execution,
    );
    expect(final.execution).toEqual(reassigned.execution);
    await configureName('beto', 'Nombre posterior').expect(200);
    await prisma.deliveryProvider.update({
      where: { id: providers.A },
      data: { name: 'Marca posterior' },
    });
    await prisma.user.update({
      where: { id: users.beto },
      data: { active: false },
    });
    try {
      expect(
        (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body,
      ).toEqual(final);
      expect((await eventFor(dispatch.id)).payload).toEqual(final);
      await api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/reassign`)
        .auth(t.A, bearer)
        .send({
          driverId: drivers.ana,
          vehicleId: vehicles.fleet1,
          reason: 'OPERATIONAL_CHANGE',
        })
        .expect(409);
      await expect(
        prisma.dispatch.update({
          where: { id: dispatch.id },
          data: {
            publicExecutionSnapshot: {
              mode: 'PROVIDER',
              provider: null,
              driver: { displayName: 'forged' },
            },
          },
        }),
      ).rejects.toThrow();
      await deliver(t.A, dispatch.id).expect(200);
      expect(await economy()).toEqual(before.economy);
      expect(routing.calls).toBe(before.routing);
      expect(
        await prisma.deliveryQuote.findUniqueOrThrow({
          where: { id: before.quote.id },
        }),
      ).toEqual(before.quote);
      expect(
        await prisma.deliveryRequest.findUniqueOrThrow({
          where: { id: before.request.id },
        }),
      ).toEqual(before.request);
      await statusOf(t.b2bOther, dispatch.requestPublicId).expect(404);
      const serialized = JSON.stringify(final);
      for (const value of [
        drivers.beto,
        providers.A,
        users.beto,
        vehicles.fleet2,
        mail('beto'),
        '9615550011',
        'driverId',
        'userId',
        'vehicleId',
        'secretHash',
      ])
        expect(serialized).not.toContain(value);
      // Existing consumers still read the unchanged mode field.
      expect(final.execution.mode).toBe('PROVIDER');
    } finally {
      await prisma.user.update({
        where: { id: users.beto },
        data: { active: true },
      });
      await prisma.deliveryProvider.update({
        where: { id: providers.A },
        data: { name: `Proveedor A ${run}` },
      });
    }
  }, 30000);

  it('missing public identity never falls back to private operational name, including after completion', async () => {
    await configureName('ana', null).expect(200);
    const dispatch = await deliveredByProvider();
    const final = (await statusOf(t.b2b, dispatch.requestPublicId).expect(200))
      .body;
    expect(final.execution.driver).toBeNull();
    await configureName('ana', 'Configured too late').expect(200);
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body,
    ).toEqual(final);
    expect((await eventFor(dispatch.id)).payload).toEqual(final);
  });

  it('Independent TAKE uses the same explicit Driver identity, with no provider; freezes it at delivery', async () => {
    await configureName('indy', 'Independiente público').expect(200);
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const current = (
      await statusOf(t.b2b, dispatch.requestPublicId).expect(200)
    ).body;
    expect(current.execution).toEqual({
      mode: 'INDEPENDENT',
      provider: null,
      driver: { displayName: 'Independiente público' },
    });
    const before = await economy();
    await driverDeliver(t.indy, dispatch.id).expect(200);
    const final = (await statusOf(t.b2b, dispatch.requestPublicId).expect(200))
      .body;
    expect((await eventFor(dispatch.id)).payload).toEqual(final);
    await configureName('indy', null).expect(200);
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body,
    ).toEqual(final);
    expect(await economy()).toEqual(before);
  });

  it('release removes identity; reads racing release never publish the old actor as OPEN', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    const [released, ...reads] = await Promise.all([
      api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
        .auth(t.A, bearer)
        .send({ reason: 'No disponible' }),
      ...Array.from({ length: 8 }, () =>
        statusOf(t.b2b, dispatch.requestPublicId),
      ),
    ]);
    expect(released.status).toBe(200);
    for (const read of reads) {
      expect(read.status).toBe(200);
      if (read.body.status === 'OPEN') expect(read.body.execution).toBeNull();
      else expect(read.body.execution.mode).toBe('PROVIDER');
    }
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body,
    ).toMatchObject({ status: 'OPEN', execution: null });
  });

  it('reads racing reassignment contain one current driver, never a historical row', async () => {
    await configureName('ana', 'Ana pública').expect(200);
    await configureName('beto', 'Beto público').expect(200);
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const [changed, ...reads] = await Promise.all([
      api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/reassign`)
        .auth(t.A, bearer)
        .send({
          driverId: drivers.beto,
          vehicleId: vehicles.fleet2,
          reason: 'OPERATIONAL_CHANGE',
        }),
      ...Array.from({ length: 8 }, () =>
        statusOf(t.b2b, dispatch.requestPublicId),
      ),
    ]);
    expect(changed.status).toBe(200);
    for (const read of reads) {
      expect(read.status).toBe(200);
      expect(['Ana pública', 'Beto público']).toContain(
        read.body.execution.driver.displayName,
      );
    }
    expect(
      (await statusOf(t.b2b, dispatch.requestPublicId).expect(200)).body
        .execution.driver,
    ).toEqual({ displayName: 'Beto público' });
  });
});
