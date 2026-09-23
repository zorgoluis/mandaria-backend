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
const PREFIX = 'E2E_DEL_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@completion.test`.toLowerCase();
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
const ZONE = { lng: -95.4, lat: 18.4 };
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
      externalReference: `DEL-${run}-${randomUUID().slice(0, 8)}`,
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
const refundsOf = (dispatchId: string) =>
  prisma.creditLedgerEntry.count({
    where: { type: 'SERVICE_REFUND', referenceId: dispatchId },
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
      await api().post('/api/v1/auth/login').send({ email, password }).expect(200)
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
      bands: [{ minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '55' }],
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

/**
 * Removes every fixture of this suite from the shared *_test database. Everything is resolved by
 * prefix instead of from memory, so a run whose worker Vitest kills mid-flight cannot leave a
 * CLAIMED dispatch, an ACTIVE assignment or an unbalanced account behind for the suites that run
 * afterwards: the next run of this file cleans them up before creating its own.
 */
async function removeFixtures() {
  const userIds = (
    await prisma.user.findMany({
      where: { email: { endsWith: '@completion.test' } },
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

describe('V1.11-A provider completion', () => {
  withApp();

  it('closes CLAIM -> ASSIGN -> DELIVERED in one call, and records who and when', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const before = new Date();
    const res = await deliver(t.A, dispatch.id).expect(200);
    expect(res.body.status).toBe('DELIVERED');
    // The owner keeps the full detail of the service it just delivered.
    expect(res.body.access).toBe('OWNER');
    expect(res.body.deliveredAt).toBeTruthy();
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    // Who confirmed is the authenticated human, not anything the client sent.
    expect(row.deliveredByUserId).toBe(users.adminA);
    expect(row.deliveredAt!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    // The claim owner is frozen: that is what keeps the delivery final for credits.
    expect(row.claimedByProviderId).toBe(providers.A);
    expect(row.cancelledAt).toBeNull();
    expect(row.expiredAt).toBeNull();
  });

  it('ends the assignment as COMPLETED, with no failure motive and the same instant', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, dispatch.id).expect(200);
    const [assignment] = await assignmentsOf(dispatch.id);
    expect(assignment.status).toBe('COMPLETED');
    expect(assignment.endReason).toBeNull();
    expect(assignment.endReasonDetail).toBeNull();
    expect(assignment.endedByUserId).toBe(users.adminA);
    const row = await dispatchRow(dispatch.id);
    expect(assignment.endedAt!.toISOString()).toBe(row.deliveredAt!.toISOString());
    // History is preserved: the row is still there with its driver and vehicle.
    expect(assignment.driverId).toBe(drivers.ana);
    expect(assignment.vehicleId).toBe(vehicles.fleet1);
  });

  it('frees the driver and the vehicle for the next service', async () => {
    const first = await openDispatch();
    await claim(t.A, first.id).expect(200);
    await assign(t.A, first.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, first.id).expect(200);
    expect(
      await prisma.deliveryAssignment.count({
        where: { driverId: drivers.ana, status: 'ACTIVE' },
      }),
    ).toBe(0);
    // The very same driver and vehicle take the next dispatch immediately.
    const second = await openDispatch();
    await claim(t.A, second.id).expect(200);
    await assign(t.A, second.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, second.id).expect(200);
    expect((await dispatchRow(second.id)).status).toBe('DELIVERED');
  });

  it('repeats the same answer without writing again', async () => {
    const dispatch = await deliveredByProvider();
    const first = await dispatchRow(dispatch.id);
    const res = await deliver(t.A, dispatch.id).expect(200);
    expect(res.body.status).toBe('DELIVERED');
    const second = await dispatchRow(dispatch.id);
    expect(second.deliveredAt!.toISOString()).toBe(
      first.deliveredAt!.toISOString(),
    );
    expect(second.updatedAt.toISOString()).toBe(first.updatedAt.toISOString());
    expect(await assignmentsOf(dispatch.id)).toHaveLength(1);
  });

  it('refuses a claim with no driver and vehicle assigned yet', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    const res = await deliver(t.A, dispatch.id).expect(409);
    expect(res.body.code).toBe('NO_ACTIVE_ASSIGNMENT');
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
  });

  it('rejects any body: the client decides nothing about the delivery', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    for (const body of [
      { deliveredAt: '2020-01-01T00:00:00.000Z' },
      { deliveredByUserId: users.sa },
      { providerId: providers.B },
    ])
      await deliver(t.A, dispatch.id, body).expect(400);
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
  });
});

describe('V1.11-A only the actor that holds the service can close it', () => {
  withApp();

  it('refuses every other principal', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    // SUPER_ADMIN has no provider membership and is not an operational actor.
    await deliver(t.sa, dispatch.id).expect(403);
    // A driver of the provider executing it still cannot close a fleet service.
    await deliver(t.ana, dispatch.id).expect(403);
    // A B2B client token is not a human token.
    await deliver(t.b2b, dispatch.id).expect(401);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/deliver`)
      .send({})
      .expect(401);
    // Another candidate provider sees it, but does not hold the claim.
    const other = await deliver(t.B, dispatch.id).expect(409);
    expect(other.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    // A provider that was never a candidate cannot tell it from an unknown id.
    await deliver(t.C, dispatch.id).expect(404);
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
    expect((await assignmentsOf(dispatch.id))[0].status).toBe('ACTIVE');
  });

  it('refuses the provider that released the service', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
      .auth(t.A, bearer)
      .send({ reason: 'Sin unidades disponibles' })
      .expect(200);
    const res = await deliver(t.A, dispatch.id).expect(409);
    expect(res.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
  });

  it('refuses a cancelled service even to the provider that had it', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await api()
      .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'El cliente ya no lo quiere' })
      .expect(200);
    const res = await deliver(t.A, dispatch.id).expect(409);
    expect(res.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect((await dispatchRow(dispatch.id)).status).toBe('CANCELLED');
  });
});

describe('V1.11-A DELIVERED is terminal and irreversible', () => {
  withApp();

  it('admits no release, no reassignment, no cancellation and no new claim', async () => {
    const dispatch = await deliveredByProvider();
    const release = await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
      .auth(t.A, bearer)
      .send({ reason: 'Quiero deshacer la entrega' })
      .expect(409);
    expect(release.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    const reassign = await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/reassign`)
      .auth(t.A, bearer)
      .send({
        driverId: drivers.beto,
        vehicleId: vehicles.fleet2,
        reason: 'OPERATIONAL_CHANGE',
      })
      .expect(409);
    expect(reassign.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    const cancel = await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/cancel`)
      .auth(t.A, bearer)
      .send({ reason: 'OPERATIONAL_CHANGE' })
      .expect(409);
    expect(cancel.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    // Neither the owner nor another candidate can claim it again.
    expect((await claim(t.A, dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_DELIVERED',
    );
    expect((await claim(t.B, dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_DELIVERED',
    );
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    expect((await assignmentsOf(dispatch.id)).map((a) => a.status)).toEqual([
      'COMPLETED',
    ]);
  });

  it('survives a later cancellation of its DeliveryRequest', async () => {
    const dispatch = await deliveredByProvider();
    const before = await dispatchRow(dispatch.id);
    await api()
      .post(`/api/v1/delivery-requests/${dispatch.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'Cancelación tardía del comercio' })
      .expect(200);
    const after = await dispatchRow(dispatch.id);
    expect(after.status).toBe('DELIVERED');
    expect(after.cancelledAt).toBeNull();
    expect(after.deliveredAt!.toISOString()).toBe(
      before.deliveredAt!.toISOString(),
    );
    expect((await assignmentsOf(dispatch.id))[0].status).toBe('COMPLETED');
  });

  it('is not offered again to an independent driver', async () => {
    const dispatch = await deliveredByProvider();
    const available = await api()
      .get('/api/v1/driver/dispatches/available?page=1&pageSize=50')
      .auth(t.indy, bearer)
      .expect(200);
    expect(
      available.body.items.some((d: { id: string }) => d.id === dispatch.id),
    ).toBe(false);
    const res = await take(t.indy, dispatch.id, vehicles.indy).expect(409);
    expect(res.body.code).toBe('DISPATCH_DELIVERED');
  });
});

describe('V1.11-A independent completion', () => {
  withApp();

  it('closes TAKE -> DELIVERED and frees the driver and the vehicle', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const res = await driverDeliver(t.indy, dispatch.id).expect(200);
    expect(res.body.status).toBe('DELIVERED');
    expect(res.body.access).toBe('OWNER');
    expect(res.body.takenByMe).toBe(true);
    expect(res.body.deliveredAt).toBeTruthy();
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    expect(row.claimedByIndependentDriverId).toBe(drivers.indy);
    expect(row.deliveredByUserId).toBe(users.indy);
    const [assignment] = await assignmentsOf(dispatch.id);
    expect(assignment.status).toBe('COMPLETED');
    expect(assignment.mode).toBe('INDEPENDENT');
    expect(assignment.endReason).toBeNull();
    expect(assignment.endedByUserId).toBe(users.indy);
    // Free again in both execution models.
    const me = await api()
      .get('/api/v1/driver/me')
      .auth(t.indy, bearer)
      .expect(200);
    expect(me.body.independent.canTakeServices).toBe(true);
    expect(me.body.activeDeliveryAssignment).toBeNull();
    const next = await openDispatch();
    await take(t.indy, next.id, vehicles.indy).expect(200);
    await driverDeliver(t.indy, next.id).expect(200);
  });

  it('refuses a driver that does not hold the service, and a provider admin', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    // Another DRIVER, not enabled as independent, is rejected before anything else.
    await driverDeliver(t.otro, dispatch.id).expect(409);
    // The provider that is a candidate does not hold this independent claim.
    expect((await deliver(t.A, dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
    );
    await driverDeliver(t.sa, dispatch.id).expect(403);
    await driverDeliver(t.A, dispatch.id).expect(403);
    await driverDeliver(t.b2b, dispatch.id).expect(401);
    await driverDeliver(t.indy, dispatch.id, { deliveredAt: '2020-01-01' })
      .expect(400);
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
  });

  it('cannot be suspended while carrying a service, and can be once it is delivered', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    // V1.9 invariant, re-checked here: a driver executing a service cannot lose the capability
    // mid-flight, which is what keeps a taken service always closable by its owner.
    const blocked = await api()
      .post(`/api/v1/admin/drivers/${drivers.indy}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Intento de suspensión durante el servicio' })
      .expect(409);
    expect(blocked.body.code).toBe('INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT');
    await driverDeliver(t.indy, dispatch.id).expect(200);
    // Once delivered the assignment is closed, so the capability can be withdrawn.
    await api()
      .post(`/api/v1/admin/drivers/${drivers.indy}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Suspensión tras la entrega' })
      .expect(200);
    // A suspended driver cannot take new services, and the delivered one stays delivered.
    await take(t.indy, (await openDispatch()).id, vehicles.indy).expect(409);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
    await api()
      .post(`/api/v1/admin/drivers/${drivers.indy}/independent`)
      .auth(t.sa, bearer)
      .send({ reason: 'Rehabilitado para el resto de la suite' })
      .expect(200);
  });

  it('refuses a released service', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    await api()
      .post(`/api/v1/driver/dispatches/${dispatch.id}/release`)
      .auth(t.indy, bearer)
      .send({ reason: 'CANNOT_COMPLETE' })
      .expect(200);
    const res = await driverDeliver(t.indy, dispatch.id).expect(409);
    expect(res.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_DRIVER');
  });
});

describe('V1.11-A completion is not an economic event', () => {
  withApp();

  it('consumes 0 credits and returns 0 to the provider', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    const afterClaim = await providerBalance(prisma, providers.A);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const entriesBefore = await prisma.creditLedgerEntry.count({
      where: { referenceId: dispatch.id },
    });
    await deliver(t.A, dispatch.id).expect(200);
    expect(await providerBalance(prisma, providers.A)).toBe(afterClaim);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { referenceId: dispatch.id },
      }),
    ).toBe(entriesBefore);
    expect(await refundsOf(dispatch.id)).toBe(0);
    // The award that paid for the service stays exactly as it was.
    expect(
      await prisma.creditLedgerEntry.count({
        where: { type: 'SERVICE_AWARD', referenceId: dispatch.id },
      }),
    ).toBe(1);
  });

  it('consumes 0 credits and returns 0 to the independent driver', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const afterTake = await independentBalance(prisma, drivers.indy);
    await driverDeliver(t.indy, dispatch.id).expect(200);
    expect(await independentBalance(prisma, drivers.indy)).toBe(afterTake);
    expect(await refundsOf(dispatch.id)).toBe(0);
  });

  it('does not recalculate the price, the route or the frozen credit cost', async () => {
    const dispatch = await openDispatch();
    const quoteBefore = await prisma.deliveryQuote.findFirstOrThrow({
      where: { dispatch: { id: dispatch.id } },
    });
    const snapshotsBefore = await prisma.dispatchCreditSnapshot.findMany({
      where: { dispatchId: dispatch.id },
      orderBy: { actorType: 'asc' },
    });
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, dispatch.id).expect(200);
    const quoteAfter = await prisma.deliveryQuote.findUniqueOrThrow({
      where: { id: quoteBefore.id },
    });
    expect(quoteAfter.amount.toFixed(2)).toBe(quoteBefore.amount.toFixed(2));
    expect(quoteAfter.distanceMeters).toBe(quoteBefore.distanceMeters);
    expect(quoteAfter.updatedAt.toISOString()).toBe(
      quoteBefore.updatedAt.toISOString(),
    );
    const snapshotsAfter = await prisma.dispatchCreditSnapshot.findMany({
      where: { dispatchId: dispatch.id },
      orderBy: { actorType: 'asc' },
    });
    expect(snapshotsAfter.map((s) => s.credits)).toEqual(
      snapshotsBefore.map((s) => s.credits),
    );
  });

  it('logs the delivery without exposing tokens or personal data', async () => {
    logs.length = 0;
    const dispatch = await deliveredByProvider();
    const completed = logs.filter((l) => l.includes('DELIVERY_COMPLETED'));
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain(dispatch.id);
    expect(completed[0]).toContain(providers.A);
    const joined = logs.join('\n');
    for (const secret of [t.A, t.b2b, password])
      expect(joined).not.toContain(secret);
    expect(joined).not.toContain('9615550011');
  });
});

describe('V1.11-A the database enforces completion on its own', () => {
  withApp();

  it('refuses a DELIVERED dispatch whose assignment is still ACTIVE', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET status = 'DELIVERED', "deliveredAt" = now(), "deliveredByUserId" = $1::uuid WHERE id = $2::uuid`,
        users.adminA,
        dispatch.id,
      ),
    ).rejects.toThrow(/DISPATCH_HAS_ACTIVE_ASSIGNMENT/);
    expect((await dispatchRow(dispatch.id)).status).toBe('CLAIMED');
  });

  it('refuses a delivery without a stamp, and a stamp without a delivery', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET status = 'DELIVERED' WHERE id = $1::uuid`,
        dispatch.id,
      ),
    ).rejects.toThrow(/Dispatch_values_check|DISPATCH_INVALID/);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET "deliveredAt" = now() WHERE id = $1::uuid`,
        dispatch.id,
      ),
    ).rejects.toThrow(/Dispatch_values_check|DISPATCH_INVALID/);
  });

  it('refuses to reopen, re-stamp or un-stamp a delivered dispatch', async () => {
    const dispatch = await deliveredByProvider();
    for (const sql of [
      `UPDATE "Dispatch" SET status = 'CLAIMED', "deliveredAt" = NULL, "deliveredByUserId" = NULL WHERE id = $1::uuid`,
      `UPDATE "Dispatch" SET status = 'CANCELLED', "cancelledAt" = now() WHERE id = $1::uuid`,
      `UPDATE "Dispatch" SET "deliveredAt" = now() WHERE id = $1::uuid`,
      `UPDATE "Dispatch" SET "deliveredByUserId" = $2::uuid WHERE id = $1::uuid`,
    ])
      await expect(
        prisma.$executeRawUnsafe(sql, dispatch.id, users.sa),
      ).rejects.toThrow(/DISPATCH_IMMUTABLE/);
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredByUserId).toBe(users.adminA);
  });

  it('refuses to rewrite a COMPLETED assignment', async () => {
    const dispatch = await deliveredByProvider();
    const [assignment] = await assignmentsOf(dispatch.id);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "DeliveryAssignment" SET status = 'ACTIVE', "endedAt" = NULL, "endedByUserId" = NULL WHERE id = $1::uuid`,
        assignment.id,
      ),
    ).rejects.toThrow(/DELIVERY_ASSIGNMENT_IMMUTABLE/);
    expect((await assignmentsOf(dispatch.id))[0].status).toBe('COMPLETED');
  });

  it('refuses a COMPLETED assignment that claims a failure motive', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const [assignment] = await assignmentsOf(dispatch.id);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "DeliveryAssignment" SET status = 'COMPLETED', "endedAt" = now(), "endedByUserId" = $2::uuid, "endReason" = 'OPERATIONAL_CHANGE' WHERE id = $1::uuid`,
        assignment.id,
        users.adminA,
      ),
    ).rejects.toThrow(/DeliveryAssignment_values_check/);
    // And a COMPLETED row without the author of the close is refused too.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "DeliveryAssignment" SET status = 'COMPLETED', "endedAt" = now(), "endedByUserId" = NULL WHERE id = $1::uuid`,
        assignment.id,
      ),
    ).rejects.toThrow(/DeliveryAssignment_values_check/);
  });

  it('never lets a delivered service be refunded', async () => {
    const dispatch = await deliveredByProvider();
    const award = await prisma.creditLedgerEntry.findFirstOrThrow({
      where: { type: 'SERVICE_AWARD', referenceId: dispatch.id },
    });
    const account = await prisma.creditAccount.findUniqueOrThrow({
      where: { id: award.creditAccountId },
    });
    await expect(
      prisma.creditLedgerEntry.create({
        data: {
          creditAccountId: award.creditAccountId,
          type: 'SERVICE_REFUND',
          amount: Math.abs(award.amount),
          balanceBefore: account.balance,
          balanceAfter: account.balance + Math.abs(award.amount),
          referenceId: dispatch.id,
          reversesEntryId: award.id,
          refundReason: 'PROVIDER_RELEASE',
          idempotencyKey: randomUUID(),
        },
      }),
    ).rejects.toThrow();
    expect(await refundsOf(dispatch.id)).toBe(0);
  });
});

describe('V1.11-A concurrency', () => {
  withApp();

  it('completes exactly once under simultaneous confirmations', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => deliver(t.A, dispatch.id)),
    );
    // Repeating the confirmation is the same answer, so every caller may legitimately see 200.
    expect(results.every((r) => [200, 409].includes(r.status))).toBe(true);
    expect(results.some((r) => r.status === 200)).toBe(true);
    const assignments = await assignmentsOf(dispatch.id);
    expect(assignments).toHaveLength(1);
    expect(assignments[0].status).toBe('COMPLETED');
    const row = await dispatchRow(dispatch.id);
    expect(row.status).toBe('DELIVERED');
    expect(row.deliveredByUserId).toBe(users.adminA);
  });

  it('never both delivers and releases the same service', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const [delivered, released] = await Promise.all([
      deliver(t.A, dispatch.id),
      api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
        .auth(t.A, bearer)
        .send({ reason: 'Carrera entre entrega y liberación' }),
    ]);
    expect([200, 409]).toContain(delivered.status);
    expect([200, 409]).toContain(released.status);
    // Exactly one of the two applied; there is no state where both did.
    expect((delivered.status === 200) !== (released.status === 200)).toBe(true);
    const row = await dispatchRow(dispatch.id);
    if (delivered.status === 200) {
      expect(row.status).toBe('DELIVERED');
      expect((await assignmentsOf(dispatch.id))[0].status).toBe('COMPLETED');
      expect(await refundsOf(dispatch.id)).toBe(0);
    } else {
      expect(row.status).toBe('OPEN');
      expect(row.deliveredAt).toBeNull();
      expect((await assignmentsOf(dispatch.id))[0].status).toBe('CANCELLED');
    }
  });

  it('never both delivers and takes the same independent service', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    const [delivered, released] = await Promise.all([
      driverDeliver(t.indy, dispatch.id),
      api()
        .post(`/api/v1/driver/dispatches/${dispatch.id}/release`)
        .auth(t.indy, bearer)
        .send({ reason: 'CANNOT_COMPLETE' }),
    ]);
    expect((delivered.status === 200) !== (released.status === 200)).toBe(true);
    const row = await dispatchRow(dispatch.id);
    expect(['DELIVERED', 'OPEN']).toContain(row.status);
    const [assignment] = await assignmentsOf(dispatch.id);
    expect(assignment.status).toBe(
      row.status === 'DELIVERED' ? 'COMPLETED' : 'CANCELLED',
    );
    // The driver is free either way: no path leaves an ACTIVE assignment behind.
    expect(
      await prisma.deliveryAssignment.count({
        where: { driverId: drivers.indy, status: 'ACTIVE' },
      }),
    ).toBe(0);
  });
});
