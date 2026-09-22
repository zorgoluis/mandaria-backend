import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
process.env.LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES = '5';
process.env.INDEPENDENT_DRIVER_MAX_VEHICLES = '2';
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_IND_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@independent.test`.toLowerCase();
const GOODS_VALUE = '800.00';
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
const ZONE = { lng: -96.5, lat: 19.5 };
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
const userIds: string[] = [];
const clientIds: string[] = [];
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

function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}

/** Accepted quote → dispatch OPEN. Provider A is always an eligible candidate. */
async function openDispatch() {
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9614443322',
    instructions: `Timbre ${sequence}`,
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `IND-${run}`,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [
        {
          category: 'FOOD',
          description: 'Pedido secreto',
          quantity: 1,
          handlingInstructions: 'No voltear',
        },
      ],
      financialContext: {
        goodsValue: GOODS_VALUE,
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
  // V1.10-D: taking debits the frozen cost. This suite is about the take rules, so every driver
  // and the fleet provider get exactly what this one service costs, never a fat balance.
  for (const driverId of Object.values(drivers))
    if (
      await prisma.independentDriverProfile.findUnique({ where: { driverId } })
    )
      await fundForAward(prisma, dispatch.id, { driverId });
  for (const providerId of Object.values(providers))
    await fundForAward(prisma, dispatch.id, { providerId });
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
}
const take = (token: string, dispatchId: string, vehicleId: string) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
const release = (
  token: string,
  dispatchId: string,
  body: object = { reason: 'CANNOT_COMPLETE' },
) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/release`)
    .auth(token, bearer)
    .send(body);
const activeOf = (dispatchId: string) =>
  prisma.deliveryAssignment.findFirst({
    where: { dispatchId, status: 'ACTIVE' },
  });
const dispatchRow = (id: string) =>
  prisma.dispatch.findUniqueOrThrow({ where: { id } });
/** Ends every ACTIVE assignment so the next block starts with free resources. */
async function freeAll() {
  const active = await prisma.deliveryAssignment.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, dispatchId: true, mode: true },
  });
  for (const a of active) {
    await prisma.deliveryAssignment.update({
      where: { id: a.id },
      data: {
        status: 'CANCELLED',
        endedAt: new Date(),
        endReason: 'OPERATIONAL_CHANGE',
      },
    });
    await prisma.dispatch.updateMany({
      where: { id: a.dispatchId, status: 'CLAIMED' },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'E2E_CLEANUP',
        claimedByProviderId: null,
        claimedByIndependentDriverId: null,
        claimedAt: null,
      },
    });
  }
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
  for (const key of ['A', 'B'] as const) {
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
    const userId = await user(key, 'DRIVER');
    const row = await prisma.driver.create({
      data: {
        providerId: providers[providerKey],
        userId,
        name: key,
        status: 'ACTIVE',
      },
    });
    drivers[key] = row.id;
  };
  // carlos, pedro and luis are real drivers of provider A; only the first two become independent.
  await driver('carlos');
  await driver('pedro');
  await driver('luis');
  await driver('bruno', 'B');
  // Fleet vehicles of provider A, used by the V1.8 path.
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
  t.carlos = await login(mail('carlos'));
  t.pedro = await login(mail('pedro'));
  t.luis = await login(mail('luis'));
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
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '60' },
      ],
    })
    .expect(201);
  await api()
    .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  await api()
    .post(`/api/v1/admin/providers/${providers.A}/service-coverages`)
    .auth(t.sa, bearer)
    .send({ serviceZoneId: zoneId, serviceType: 'LOCAL_DELIVERY' })
    .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Independent client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  clientIds.push(client.body.id);
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

afterAll(async () => {
  await purgeFixtureDispatches(prisma, clientIds);
  const providerIds = Object.values(providers);
  const driverIds = Object.values(drivers);
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
  await prisma.driverVehicleAssignment.deleteMany({
    where: { providerId: { in: providerIds } },
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
  await prisma.$disconnect();
}, 120000);

describe('V1.9 enabling independent drivers', () => {
  withApp();
  it('only SUPER_ADMIN can enable; nobody can self-approve', async () => {
    const url = `/api/v1/admin/drivers/${drivers.carlos}/independent`;
    // A driver cannot enable itself, and a provider admin cannot enable its own drivers.
    for (const token of [t.carlos, t.A])
      await api().post(url).auth(token, bearer).send({}).expect(403);
    // A B2B token is not a human token at all.
    await api().post(url).auth(t.b2b, bearer).send({}).expect(401);
    await api().post(url).send({}).expect(401);
    expect(
      await prisma.independentDriverProfile.count({
        where: { driverId: drivers.carlos },
      }),
    ).toBe(0);
  });

  it('enables an existing Driver straight to APPROVED, idempotently', async () => {
    for (const key of ['carlos', 'pedro'] as const) {
      const res = await api()
        .post(`/api/v1/admin/drivers/${drivers[key]}/independent`)
        .auth(t.sa, bearer)
        .send({ reason: 'Alta piloto V1.9' })
        .expect(200);
      expect(res.body).toMatchObject({
        driverId: drivers[key],
        status: 'APPROVED',
        suspendedAt: null,
        rejectedAt: null,
        driver: { id: drivers[key], status: 'ACTIVE', providerId: providers.A },
      });
      expect(res.body.approvedAt).toBeTruthy();
    }
    // Repeating changes nothing and never creates a second profile.
    const again = await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    expect(again.body.status).toBe('APPROVED');
    expect(
      await prisma.independentDriverProfile.count({
        where: { driverId: drivers.carlos },
      }),
    ).toBe(1);
    // No fake provider was created for the independent driver: this run made exactly the two
    // fleets of its own fixture. Scoped by `run` so leftovers of an interrupted run cannot alter it.
    expect(
      await prisma.deliveryProvider.count({
        where: { code: { contains: run } },
      }),
    ).toBe(2);
    // And the independent driver has no membership anywhere.
    expect(
      await prisma.providerMembership.count({
        where: { user: { driver: { id: drivers.carlos } } },
      }),
    ).toBe(0);
  });

  it('refuses a driver that is not operational and reports unknown ids as 404', async () => {
    await prisma.driver.update({
      where: { id: drivers.luis },
      data: { status: 'SUSPENDED' },
    });
    await api()
      .post(`/api/v1/admin/drivers/${drivers.luis}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DRIVER_NOT_ELIGIBLE'));
    await prisma.driver.update({
      where: { id: drivers.luis },
      data: { status: 'ACTIVE' },
    });
    await api()
      .post(`/api/v1/admin/drivers/${randomUUID()}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(404);
  });

  it('registers vehicles owned by the driver, never by a provider, within the limit', async () => {
    for (const [key, identifier, type] of [
      ['carlosMoto', `MOTO-CARLOS-${run}`, 'MOTORCYCLE'],
      ['carlosAuto', `AUTO-CARLOS-${run}`, 'CAR'],
    ] as const) {
      const res = await api()
        .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles`)
        .auth(t.sa, bearer)
        .send({ identifier, type, brand: 'Italika' })
        .expect(201);
      vehicles[key] = res.body.id;
      expect(res.body.independentDriverProfileId).toBeTruthy();
      expect(res.body).not.toHaveProperty('providerId');
    }
    const stored = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicles.carlosMoto },
    });
    expect(stored.providerId).toBeNull();
    // INDEPENDENT_DRIVER_MAX_VEHICLES = 2 in this suite.
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `EXTRA-${run}`, type: 'BICYCLE' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('VEHICLE_LIMIT_REACHED'));
    const pedroVehicle = await api()
      .post(`/api/v1/admin/drivers/${drivers.pedro}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `MOTO-PEDRO-${run}`, type: 'MOTORCYCLE' })
      .expect(201);
    vehicles.pedroMoto = pedroVehicle.body.id;
    // Only SUPER_ADMIN administers them.
    for (const token of [t.A, t.carlos])
      await api()
        .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles`)
        .auth(token, bearer)
        .send({ identifier: `X-${run}`, type: 'BICYCLE' })
        .expect(403);
  });

  it('shows the capability and its own vehicles to the driver', async () => {
    const me = await api()
      .get('/api/v1/driver/me')
      .auth(t.carlos, bearer)
      .expect(200);
    expect(me.body.independent).toMatchObject({
      status: 'APPROVED',
      canTakeServices: true,
    });
    expect(me.body.activeDeliveryAssignment).toBeNull();
    const own = await api()
      .get('/api/v1/driver/vehicles')
      .auth(t.carlos, bearer)
      .expect(200);
    expect(own.body.map((v: { id: string }) => v.id).sort()).toEqual(
      [vehicles.carlosMoto, vehicles.carlosAuto].sort(),
    );
    // Luis is a driver of provider A but was never enabled as independent.
    const luis = await api()
      .get('/api/v1/driver/me')
      .auth(t.luis, bearer)
      .expect(200);
    expect(luis.body.independent).toBeNull();
    await api()
      .get('/api/v1/driver/vehicles')
      .auth(t.luis, bearer)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INDEPENDENT_NOT_APPROVED'));
    await api()
      .get('/api/v1/driver/dispatches/available')
      .auth(t.luis, bearer)
      .expect(409);
  });
});

describe('V1.9 taking a service', () => {
  withApp();
  it('lists eligible dispatches without leaking private data', async () => {
    const { id } = await openDispatch();
    const list = await api()
      .get('/api/v1/driver/dispatches/available')
      .auth(t.carlos, bearer)
      .expect(200);
    const offer = list.body.items.find((d: { id: string }) => d.id === id);
    expect(offer).toMatchObject({
      status: 'OPEN',
      access: 'OFFER',
      takenByMe: false,
      serviceType: 'LOCAL_DELIVERY',
    });
    // Enough to decide: route, addresses, coordinates and the money involved.
    expect(offer.service.pickup.address).toContain(run);
    expect(offer.service.route.distanceMeters).toBe(4200);
    expect(offer.paymentContext).toMatchObject({
      deliveryFee: { amount: '60.00', currency: 'MXN' },
      driverAdvancesGoods: true,
      driverAdvanceAmount: { amount: GOODS_VALUE, currency: 'MXN' },
    });
    // Nothing else: no contacts, instructions, package text, merchant reference or providers.
    const serialized = JSON.stringify(offer);
    for (const forbidden of [
      'Contacto',
      '9614443322',
      'Timbre',
      'Pedido secreto',
      'No voltear',
      'MDR-',
      'IND-',
      'integrationClient',
      'candidates',
      'providerId',
    ])
      expect(serialized).not.toContain(forbidden);
    await prisma.dispatch.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancellationReason: 'E2E_CLEANUP',
      },
    });
  });

  it('take is claim + assignment in one step, with OWNER detail and payment context', async () => {
    const { id, requestPublicId } = await openDispatch();
    const res = await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    expect(res.body).toMatchObject({
      status: 'CLAIMED',
      access: 'OWNER',
      takenByMe: true,
      assignment: {
        mode: 'INDEPENDENT',
        vehicle: { id: vehicles.carlosMoto },
      },
    });
    // OWNER adds exactly what executing the service requires.
    expect(res.body.service.pickup.contactPhone).toBe('9614443322');
    expect(res.body.service.deliveryRequestPublicId).toBe(requestPublicId);
    expect(res.body.paymentContext.driverAdvanceAmount.amount).toBe(
      GOODS_VALUE,
    );

    const dispatch = await dispatchRow(id);
    expect(dispatch.status).toBe('CLAIMED');
    expect(dispatch.claimedByIndependentDriverId).toBe(drivers.carlos);
    // The provider column is never overloaded with a driver id.
    expect(dispatch.claimedByProviderId).toBeNull();
    const active = await activeOf(id);
    expect(active).toMatchObject({
      mode: 'INDEPENDENT',
      providerId: null,
      driverId: drivers.carlos,
      vehicleId: vehicles.carlosMoto,
      status: 'ACTIVE',
    });
    expect(active!.independentDriverProfileId).toBeTruthy();
    // A claim never exists without its assignment.
    expect(
      await prisma.dispatch.count({
        where: {
          status: 'CLAIMED',
          claimedByIndependentDriverId: { not: null },
          deliveryAssignments: { none: { status: 'ACTIVE' } },
        },
      }),
    ).toBe(0);
    await freeAll();
  });

  it('refuses a vehicle that is not the driver own, in either direction', async () => {
    const { id } = await openDispatch();
    // A fleet vehicle of the provider Carlos works for is not his to use.
    await take(t.carlos, id, vehicles.fleet1).expect(404);
    // Another independent driver's vehicle is equally invisible.
    await take(t.carlos, id, vehicles.pedroMoto).expect(404);
    await take(t.carlos, id, randomUUID()).expect(404);
    expect(await activeOf(id)).toBeNull();
    expect((await dispatchRow(id)).status).toBe('OPEN');
    // And a provider admin cannot assign an independent vehicle to its fleet claim.
    await api()
      .post(`/api/v1/provider/dispatches/${id}/claim`)
      .auth(t.A, bearer)
      .expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${id}/assignment`)
      .auth(t.A, bearer)
      .send({ driverId: drivers.carlos, vehicleId: vehicles.carlosMoto })
      .expect(404);
    await freeAll();
  });

  it('a suspended independent driver cannot take anything', async () => {
    await api()
      .post(`/api/v1/admin/drivers/${drivers.pedro}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Documentos vencidos' })
      .expect(200);
    const { id } = await openDispatch();
    await take(t.pedro, id, vehicles.pedroMoto)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INDEPENDENT_NOT_APPROVED'));
    await api()
      .get('/api/v1/driver/dispatches/available')
      .auth(t.pedro, bearer)
      .expect(409);
    expect((await dispatchRow(id)).status).toBe('OPEN');
    await api()
      .post(`/api/v1/admin/drivers/${drivers.pedro}/independent`)
      .auth(t.sa, bearer)
      .send({ reason: 'Documentos al día' })
      .expect(200);
    await take(t.pedro, id, vehicles.pedroMoto).expect(200);
    await freeAll();
  });
});

describe('V1.9 releasing a service', () => {
  withApp();
  it('release cancels the assignment and reopens the dispatch, atomically', async () => {
    const { id } = await openDispatch();
    await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    const released = await release(t.carlos, id, {
      reason: 'VEHICLE_ISSUE',
      reasonDetail: 'Llanta ponchada',
    }).expect(200);
    expect(released.body).toMatchObject({ status: 'OPEN', takenByMe: false });
    const dispatch = await dispatchRow(id);
    expect(dispatch.status).toBe('OPEN');
    expect(dispatch.claimedByIndependentDriverId).toBeNull();
    expect(dispatch.claimedAt).toBeNull();
    expect(await activeOf(id)).toBeNull();
    const history = await prisma.deliveryAssignment.findMany({
      where: { dispatchId: id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      status: 'CANCELLED',
      endReason: 'VEHICLE_ISSUE',
      endReasonDetail: 'Llanta ponchada',
    });
    // Whoever released cannot take it again, but another driver can.
    await take(t.carlos, id, vehicles.carlosMoto)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DISPATCH_RETAKE_NOT_ALLOWED'));
    await take(t.pedro, id, vehicles.pedroMoto).expect(200);
    expect((await dispatchRow(id)).claimedByIndependentDriverId).toBe(
      drivers.pedro,
    );
    await freeAll();
  });

  it('requires a motive and only the driver holding the service may release it', async () => {
    const { id } = await openDispatch();
    await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    await release(t.carlos, id, {}).expect(400);
    await release(t.carlos, id, { reason: 'OTHER' }).expect(400);
    await release(t.carlos, id, { reason: 'NOT_A_REASON' }).expect(400);
    // Pedro does not hold it; the provider admin and SUPER_ADMIN have no such route.
    await release(t.pedro, id)
      .expect(409)
      .expect((r) =>
        expect(r.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_DRIVER'),
      );
    for (const token of [t.A, t.sa])
      await api()
        .post(`/api/v1/driver/dispatches/${id}/release`)
        .auth(token, bearer)
        .send({ reason: 'CANNOT_COMPLETE' })
        .expect(403);
    expect(await activeOf(id)).not.toBeNull();
    await freeAll();
  });

  it('gives the driver no way to reassign a service to anyone', async () => {
    const { id } = await openDispatch();
    await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    // The V1.8 provider routes are closed to the DRIVER role, own service or not.
    for (const path of [
      'assignment',
      'assignment/reassign',
      'assignment/cancel',
    ])
      await api()
        .post(`/api/v1/provider/dispatches/${id}/${path}`)
        .auth(t.carlos, bearer)
        .send({
          driverId: drivers.pedro,
          vehicleId: vehicles.pedroMoto,
          reason: 'OPERATIONAL_CHANGE',
        })
        .expect(403);
    // And a provider admin cannot appropriate a service claimed by an independent driver.
    for (const body of [
      { driverId: drivers.luis, vehicleId: vehicles.fleet1 },
      { driverId: drivers.carlos, vehicleId: vehicles.fleet1 },
    ])
      await api()
        .post(`/api/v1/provider/dispatches/${id}/assignment`)
        .auth(t.A, bearer)
        .send(body)
        .expect(409)
        .expect((r) =>
          expect(r.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER'),
        );
    await api()
      .post(`/api/v1/provider/dispatches/${id}/claim`)
      .auth(t.A, bearer)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DISPATCH_ALREADY_CLAIMED'));
    const active = await activeOf(id);
    expect(active!.driverId).toBe(drivers.carlos);
    await freeAll();
  });
});

describe('V1.9 concurrency: exactly one winner', () => {
  withApp();
  it('a provider CLAIM and an independent TAKE on the same dispatch produce one owner', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const { id } = await openDispatch();
      const [claim, taken] = await Promise.all([
        api().post(`/api/v1/provider/dispatches/${id}/claim`).auth(t.A, bearer),
        take(t.carlos, id, vehicles.carlosMoto),
      ]);
      const codes = [claim.status, taken.status].sort();
      expect(codes).toEqual([200, 409]);
      const dispatch = await dispatchRow(id);
      expect(dispatch.status).toBe('CLAIMED');
      // Exactly one owner column is set, never both.
      expect(
        [
          dispatch.claimedByProviderId,
          dispatch.claimedByIndependentDriverId,
        ].filter(Boolean),
      ).toHaveLength(1);
      if (taken.status === 200) {
        expect(dispatch.claimedByIndependentDriverId).toBe(drivers.carlos);
        expect(await activeOf(id)).not.toBeNull();
      } else {
        expect(dispatch.claimedByProviderId).toBe(providers.A);
        // The provider claim alone creates no assignment: that is still a separate V1.8 step.
        expect(await activeOf(id)).toBeNull();
      }
      await freeAll();
    }
  });

  it('several independent drivers competing for one dispatch: exactly one wins', async () => {
    const { id } = await openDispatch();
    const results = await Promise.all([
      take(t.carlos, id, vehicles.carlosMoto),
      take(t.carlos, id, vehicles.carlosAuto),
      take(t.pedro, id, vehicles.pedroMoto),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      await prisma.deliveryAssignment.count({
        where: { dispatchId: id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await freeAll();
  });

  it('the same driver taking two dispatches at once ends up busy on exactly one', async () => {
    const a = await openDispatch();
    const b = await openDispatch();
    const results = await Promise.all([
      take(t.carlos, a.id, vehicles.carlosMoto),
      take(t.carlos, b.id, vehicles.carlosAuto),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);
    expect(
      await prisma.deliveryAssignment.count({
        where: { driverId: drivers.carlos, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await freeAll();
  });

  it('the same vehicle on two dispatches at once is used by exactly one', async () => {
    const a = await openDispatch();
    const b = await openDispatch();
    const results = await Promise.all([
      take(t.carlos, a.id, vehicles.carlosMoto),
      take(t.pedro, b.id, vehicles.pedroMoto),
      take(t.carlos, b.id, vehicles.carlosMoto),
    ]);
    expect(
      results.filter((r) => r.status === 200).length,
    ).toBeGreaterThanOrEqual(1);
    expect(
      await prisma.deliveryAssignment.count({
        where: { vehicleId: vehicles.carlosMoto, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await freeAll();
  });
});

describe('V1.9 one active service per driver and per vehicle, across both models', () => {
  withApp();
  it('a driver busy with fleet work cannot take an independent service, and the reverse', async () => {
    // Fleet first: provider A claims and assigns Carlos with a fleet vehicle.
    const fleet = await openDispatch();
    await api()
      .post(`/api/v1/provider/dispatches/${fleet.id}/claim`)
      .auth(t.A, bearer)
      .expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${fleet.id}/assignment`)
      .auth(t.A, bearer)
      .send({ driverId: drivers.carlos, vehicleId: vehicles.fleet1 })
      .expect(201);
    const own = await openDispatch();
    await take(t.carlos, own.id, vehicles.carlosMoto)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DRIVER_BUSY'));
    const me = await api()
      .get('/api/v1/driver/me')
      .auth(t.carlos, bearer)
      .expect(200);
    expect(me.body.independent.canTakeServices).toBe(false);
    expect(me.body.activeDeliveryAssignment).toMatchObject({ mode: 'FLEET' });
    await freeAll();

    // Now the reverse: Carlos is executing his own service.
    const independent = await openDispatch();
    await take(t.carlos, independent.id, vehicles.carlosMoto).expect(200);
    const fleet2 = await openDispatch();
    await api()
      .post(`/api/v1/provider/dispatches/${fleet2.id}/claim`)
      .auth(t.A, bearer)
      .expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${fleet2.id}/assignment`)
      .auth(t.A, bearer)
      .send({ driverId: drivers.carlos, vehicleId: vehicles.fleet1 })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DRIVER_BUSY'));
    expect(
      await prisma.deliveryAssignment.count({
        where: { driverId: drivers.carlos, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await freeAll();
  });

  it('a vehicle executing a service cannot start another one', async () => {
    const a = await openDispatch();
    await take(t.carlos, a.id, vehicles.carlosMoto).expect(200);
    await release(t.carlos, a.id).expect(200);
    // Freed by the release, the vehicle is usable again.
    const b = await openDispatch();
    await take(t.carlos, b.id, vehicles.carlosMoto).expect(200);
    expect(
      await prisma.deliveryAssignment.count({
        where: { vehicleId: vehicles.carlosMoto, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await freeAll();
  });
});

describe('V1.9 suspension and vehicle deactivation with a service in progress', () => {
  withApp();
  it('refuses both instead of leaving an inconsistent delivery', async () => {
    const { id } = await openDispatch();
    await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Revision urgente' })
      .expect(409)
      .expect((r) =>
        expect(r.body.code).toBe('INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT'),
      );
    await api()
      .patch(
        `/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles/${vehicles.carlosMoto}`,
      )
      .auth(t.sa, bearer)
      .send({ status: 'MAINTENANCE' })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('VEHICLE_HAS_ACTIVE_ASSIGNMENT'));
    // Nothing changed: the delivery is still running.
    const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
      where: { driverId: drivers.carlos },
    });
    expect(profile.status).toBe('APPROVED');
    const vehicle = await prisma.vehicle.findUniqueOrThrow({
      where: { id: vehicles.carlosMoto },
    });
    expect(vehicle.status).toBe('ACTIVE');
    expect(await activeOf(id)).not.toBeNull();

    // After the driver releases the service, both operations succeed.
    await release(t.carlos, id).expect(200);
    await api()
      .patch(
        `/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles/${vehicles.carlosMoto}`,
      )
      .auth(t.sa, bearer)
      .send({ status: 'MAINTENANCE' })
      .expect(200);
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent/suspend`)
      .auth(t.sa, bearer)
      .send({ reason: 'Revision urgente' })
      .expect(200);
    // A vehicle in MAINTENANCE is not usable even once the driver is enabled again.
    await api()
      .post(`/api/v1/admin/drivers/${drivers.carlos}/independent`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    const next = await openDispatch();
    await take(t.carlos, next.id, vehicles.carlosMoto)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('VEHICLE_NOT_ELIGIBLE'));
    await api()
      .patch(
        `/api/v1/admin/drivers/${drivers.carlos}/independent/vehicles/${vehicles.carlosMoto}`,
      )
      .auth(t.sa, bearer)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await freeAll();
  });
});

describe('V1.9 database invariants and audit', () => {
  withApp();
  it('SQL rejects a dispatch owned by both models, whatever the service layer does', async () => {
    const { id } = await openDispatch();
    // OPEN must carry no owner at all. The trigger allows this UPDATE (no status change, no
    // identity change), so what rejects it is Dispatch_values_check itself.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET "claimedByIndependentDriverId"=$1::uuid WHERE id=$2::uuid`,
        drivers.carlos,
        id,
      ),
    ).rejects.toThrow(/Dispatch_values_check/);

    // Now a legitimate provider claim, so the trigger's "owner is a CLAIMED candidate" rule is
    // satisfied; adding the second owner column is rejected only by the XOR in the CHECK.
    await api()
      .post(`/api/v1/provider/dispatches/${id}/claim`)
      .auth(t.A, bearer)
      .expect(200);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET "claimedByIndependentDriverId"=$1::uuid WHERE id=$2::uuid`,
        drivers.carlos,
        id,
      ),
    ).rejects.toThrow(/Dispatch_values_check/);
    const still = await dispatchRow(id);
    expect(still.claimedByIndependentDriverId).toBeNull();
    expect(still.claimedByProviderId).toBe(providers.A);
    await freeAll();
  });

  it('SQL rejects an assignment whose dispatch nobody has taken, and unowned vehicles', async () => {
    const { id } = await openDispatch();
    const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
      where: { driverId: drivers.carlos },
    });
    await expect(
      prisma.deliveryAssignment.create({
        data: {
          dispatchId: id,
          mode: 'INDEPENDENT',
          independentDriverProfileId: profile.id,
          driverId: drivers.carlos,
          vehicleId: vehicles.carlosMoto,
          assignedAt: new Date(),
          assignedByUserId: userIds[0],
        },
      }),
    ).rejects.toThrow(/DELIVERY_ASSIGNMENT_INVALID/);
    // Taking it for real and then claiming a vehicle that is not the driver's is refused too.
    await take(t.carlos, id, vehicles.carlosMoto).expect(200);
    await expect(
      prisma.deliveryAssignment.create({
        data: {
          dispatchId: id,
          mode: 'INDEPENDENT',
          independentDriverProfileId: profile.id,
          driverId: drivers.carlos,
          vehicleId: vehicles.fleet1,
          assignedAt: new Date(),
          assignedByUserId: userIds[0],
        },
      }),
    ).rejects.toThrow();
    await freeAll();

    // A vehicle belongs to a provider XOR an independent driver: never both, never neither.
    await expect(
      prisma.vehicle.create({
        data: {
          providerId: providers.A,
          independentDriverProfileId: profile.id,
          identifier: `BOTH-${run}`,
          type: 'MOTORCYCLE',
        },
      }),
    ).rejects.toThrow(/Vehicle_owner_check/);
    await expect(
      prisma.vehicle.create({
        data: { identifier: `NEITHER-${run}`, type: 'MOTORCYCLE' },
      }),
    ).rejects.toThrow(/Vehicle_owner_check/);
    // Ownership is immutable: this is what replaces the V1.8 composite foreign keys.
    await expect(
      prisma.vehicle.update({
        where: { id: vehicles.carlosMoto },
        data: { independentDriverProfileId: null, providerId: providers.A },
      }),
    ).rejects.toThrow(/RESOURCE_OWNER_IMMUTABLE/);
  });

  it('keeps the V1.8 guarantees and adds the V1.9 ones as database objects', async () => {
    const names = async (sql: string) =>
      (await prisma.$queryRawUnsafe<{ name: string }[]>(sql)).map(
        (r) => r.name,
      );
    expect(
      await names(
        `SELECT conname AS name FROM pg_constraint WHERE conname IN ('Vehicle_owner_check','Dispatch_values_check','DeliveryAssignment_mode_check','DeliveryAssignment_values_check','IndependentDriverProfile_values_check') ORDER BY 1`,
      ),
    ).toEqual([
      'DeliveryAssignment_mode_check',
      'DeliveryAssignment_values_check',
      'Dispatch_values_check',
      'IndependentDriverProfile_values_check',
      'Vehicle_owner_check',
    ]);
    expect(
      await names(
        `SELECT tgname AS name FROM pg_trigger WHERE tgname IN ('Dispatch_guard','DeliveryAssignment_guard','Driver_owner_guard','Vehicle_owner_guard','IndependentDriverProfile_guard') ORDER BY 1`,
      ),
    ).toEqual([
      'DeliveryAssignment_guard',
      'Dispatch_guard',
      'Driver_owner_guard',
      'IndependentDriverProfile_guard',
      'Vehicle_owner_guard',
    ]);
    // One ACTIVE assignment per dispatch, per driver and per vehicle — still global in V1.9.
    expect(
      await names(
        `SELECT indexname AS name FROM pg_indexes WHERE indexname IN ('DeliveryAssignment_active_dispatch_key','DeliveryAssignment_active_driver_key','DeliveryAssignment_active_vehicle_key','Vehicle_independent_identifier_key') ORDER BY 1`,
      ),
    ).toEqual([
      'DeliveryAssignment_active_dispatch_key',
      'DeliveryAssignment_active_driver_key',
      'DeliveryAssignment_active_vehicle_key',
      'Vehicle_independent_identifier_key',
    ]);
    // Every V1.8 fleet assignment kept its mode through the migration.
    expect(
      await prisma.deliveryAssignment.count({
        where: { mode: 'FLEET', providerId: null },
      }),
    ).toBe(0);
    expect(
      await prisma.deliveryAssignment.count({
        where: { mode: 'INDEPENDENT', providerId: { not: null } },
      }),
    ).toBe(0);
  });

  it('every V1.9 event is audited and no secret reaches the logs', async () => {
    const text = logs.join('\n');
    for (const event of [
      'INDEPENDENT_DRIVER_ENABLED',
      'INDEPENDENT_DRIVER_SUSPENDED',
      'INDEPENDENT_DISPATCH_TAKEN',
      'INDEPENDENT_DISPATCH_RELEASED',
      'INDEPENDENT_VEHICLE_CREATED',
    ])
      expect(text).toContain(event);
    // The take event carries actor, driver, dispatch and vehicle.
    const taken = logs.find((l) => l.includes('INDEPENDENT_DISPATCH_TAKEN'))!;
    for (const field of [
      'dispatchId',
      'assignmentId',
      'driverId',
      'vehicleId',
      'actorUserId',
      'profileId',
    ])
      expect(taken).toContain(field);
    for (const secret of [password, t.carlos, t.sa, t.b2b])
      expect(text).not.toContain(secret);
  });
});
