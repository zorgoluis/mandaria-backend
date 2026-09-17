import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

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
const PREFIX = 'E2E_AS_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@assignments.test`.toLowerCase();
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
const ZONE = { lng: -95.0, lat: 18.0 };
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
/** Accepted quote → dispatch OPEN, claimed by the given provider admin. */
async function claimedDispatch(admin = 't.A') {
  const token = admin === 't.A' ? t.A : t.B;
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9614443322',
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `ASG-${run}`,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [{ category: 'FOOD', description: 'Pedido', quantity: 1 }],
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
  await api()
    .post(`/api/v1/provider/dispatches/${dispatch.id}/claim`)
    .auth(token, bearer)
    .expect(200);
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
}
const assign = (token: string, dispatchId: string, body: object) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/assignment`)
    .auth(token, bearer)
    .send(body);
const reassign = (token: string, dispatchId: string, body: object) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/assignment/reassign`)
    .auth(token, bearer)
    .send(body);
const cancelAssignment = (
  token: string,
  dispatchId: string,
  body: object = { reason: 'OPERATIONAL_CHANGE' },
) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/assignment/cancel`)
    .auth(token, bearer)
    .send(body);
const history = (token: string, dispatchId: string) =>
  api()
    .get(`/api/v1/provider/dispatches/${dispatchId}/assignments`)
    .auth(token, bearer);
const activeOf = (dispatchId: string) =>
  prisma.deliveryAssignment.findFirst({
    where: { dispatchId, status: 'ACTIVE' },
  });
/** Frees every driver and vehicle of provider A so the next block starts clean. */
async function freeResources() {
  const active = await prisma.deliveryAssignment.findMany({
    where: { providerId: providers.A, status: 'ACTIVE' },
    select: { dispatchId: true },
  });
  for (const { dispatchId } of active)
    await cancelAssignment(t.A, dispatchId).expect(200);
}

beforeAll(async () => {
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
  const saId = await user('sa', 'SUPER_ADMIN');
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
  // Provider A fleet: three usable drivers, one SUSPENDED, one with a disabled account.
  const driver = async (
    key: string,
    providerKey: 'A' | 'B',
    status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE',
    userActive = true,
  ) => {
    const userId = await user(key, 'DRIVER');
    if (!userActive)
      await prisma.user.update({
        where: { id: userId },
        data: { active: false },
      });
    const row = await prisma.driver.create({
      data: { providerId: providers[providerKey], userId, name: key, status },
    });
    drivers[key] = row.id;
  };
  await driver('carlos', 'A');
  await driver('pedro', 'A');
  await driver('ana', 'A');
  await driver('suspendido', 'A', 'SUSPENDED');
  await driver('sincuenta', 'A', 'ACTIVE', false);
  await driver('bruno', 'B');
  const vehicle = async (
    key: string,
    providerKey: 'A' | 'B',
    status: 'ACTIVE' | 'MAINTENANCE' = 'ACTIVE',
  ) => {
    const row = await prisma.vehicle.create({
      data: {
        providerId: providers[providerKey],
        identifier: `${key.toUpperCase()}-${run}`,
        type: 'MOTORCYCLE',
        status,
        plate: `PL-${key.toUpperCase()}`,
      },
    });
    vehicles[key] = row.id;
  };
  await vehicle('moto03', 'A');
  await vehicle('moto07', 'A');
  await vehicle('moto09', 'A');
  await vehicle('taller', 'A', 'MAINTENANCE');
  await vehicle('motoB', 'B');
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
  t.driver = await login(mail('carlos'));
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
  for (const key of ['A', 'B'] as const)
    await api()
      .post(`/api/v1/admin/providers/${providers[key]}/service-coverages`)
      .auth(t.sa, bearer)
      .send({ serviceZoneId: zoneId, serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  // V1.4 pairing: Carlos operates MOTO-03 and Ana MOTO-09; Pedro and MOTO-07 stay unpaired.
  for (const [driver, vehicle] of [
    [drivers.carlos, vehicles.moto03],
    [drivers.ana, vehicles.moto09],
  ])
    await api()
      .post(`/api/v1/provider/drivers/${driver}/vehicle`)
      .auth(t.A, bearer)
      .send({ vehicleId: vehicle })
      .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Assignments client', code: `${PREFIX}CLIENT_${run}` })
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
  t.clientSecret = credential.body.clientSecret;
  t.saId = saId;
  await app.close();
}, 120000);

afterAll(async () => {
  vi.useRealTimers();
  const providerIds = Object.values(providers);
  const zoneFilter = zoneId ? [{ serviceZoneId: zoneId }] : [];
  await prisma.deliveryQuote.deleteMany({
    where: {
      OR: [
        ...zoneFilter,
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
  await prisma.driver.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.vehicle.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.providerMembership.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: clientIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe.sequential(
  'Assigning a driver and vehicle to a claimed dispatch',
  () => {
    withApp();
    let dispatchId = '';

    it('lists only assignable resources of the claim owner and assigns one ACTIVE pair with its payment context', async () => {
      dispatchId = (await claimedDispatch()).id;
      const driverList = await api()
        .get(`/api/v1/provider/dispatches/${dispatchId}/available-drivers`)
        .query({ pageSize: 100 })
        .auth(t.A, bearer)
        .expect(200);
      const driverIds = driverList.body.items.map((d: { id: string }) => d.id);
      expect(driverIds).toEqual(
        expect.arrayContaining([drivers.carlos, drivers.pedro, drivers.ana]),
      );
      for (const excluded of ['suspendido', 'sincuenta', 'bruno'])
        expect(driverIds, excluded).not.toContain(drivers[excluded]);
      expect(
        driverList.body.items.find(
          (d: { id: string }) => d.id === drivers.carlos,
        ).pairedVehicle.id,
      ).toBe(vehicles.moto03);
      const vehicleList = await api()
        .get(`/api/v1/provider/dispatches/${dispatchId}/available-vehicles`)
        .query({ pageSize: 100 })
        .auth(t.A, bearer)
        .expect(200);
      const vehicleIds = vehicleList.body.items.map(
        (v: { id: string }) => v.id,
      );
      expect(vehicleIds).toEqual(
        expect.arrayContaining([
          vehicles.moto03,
          vehicles.moto07,
          vehicles.moto09,
        ]),
      );
      for (const excluded of ['taller', 'motoB'])
        expect(vehicleIds, excluded).not.toContain(vehicles[excluded]);

      const created = await assign(t.A, dispatchId, {
        driverId: drivers.carlos,
        vehicleId: vehicles.moto03,
      }).expect(201);
      expect(created.body).toMatchObject({
        status: 'ACTIVE',
        dispatchId,
        providerId: providers.A,
        driver: { id: drivers.carlos, name: 'carlos' },
        vehicle: { id: vehicles.moto03 },
        endedAt: null,
        endReason: null,
        paymentContext: {
          deliveryFee: { amount: '60.00', currency: 'MXN' },
          goodsValue: { amount: GOODS_VALUE, currency: 'MXN' },
          goodsPaymentMode: 'COURIER_ADVANCE',
          driverAdvancesGoods: true,
          driverAdvanceAmount: { amount: GOODS_VALUE, currency: 'MXN' },
        },
      });
      const row = await prisma.deliveryAssignment.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(row).toMatchObject({
        status: 'ACTIVE',
        providerId: providers.A,
        driverId: drivers.carlos,
        vehicleId: vehicles.moto03,
      });
      expect(row.assignedByUserId).toBeTruthy();
      // The dispatch stays CLAIMED and now shows who executes it.
      const detail = await api()
        .get(`/api/v1/provider/dispatches/${dispatchId}`)
        .auth(t.A, bearer)
        .expect(200);
      expect(detail.body).toMatchObject({
        status: 'CLAIMED',
        access: 'OWNER',
        assignment: { id: created.body.id, driver: { id: drivers.carlos } },
        assignmentOverdue: false,
      });
      expect(Date.parse(detail.body.assignmentDeadline)).not.toBeNaN();
      expect(
        (
          await assign(t.A, dispatchId, {
            driverId: drivers.pedro,
            vehicleId: vehicles.moto07,
          }).expect(409)
        ).body.code,
      ).toBe('DISPATCH_ALREADY_ASSIGNED');
    });

    it('keeps resources inside the provider and the claim owner', async () => {
      const other = await claimedDispatch();
      for (const [driverId, vehicleId] of [
        [drivers.bruno, vehicles.moto07],
        [drivers.pedro, vehicles.motoB],
        [randomUUID(), vehicles.moto07],
      ])
        await assign(t.A, other.id, { driverId, vehicleId }).expect(404);
      // Provider B is a candidate but not the owner; C-like outsiders never see it.
      expect(
        (
          await assign(t.B, other.id, {
            driverId: drivers.bruno,
            vehicleId: vehicles.motoB,
          }).expect(409)
        ).body.code,
      ).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
      await api()
        .get(`/api/v1/provider/dispatches/${other.id}/available-drivers`)
        .auth(t.B, bearer)
        .expect(409);
      await assign(t.sa, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      }).expect(403);
      await assign(t.driver, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      }).expect(403);
      await assign(t.b2b, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      }).expect(401);
      await api()
        .get(`/api/v1/admin/dispatches/${other.id}/assignments`)
        .auth(t.A, bearer)
        .expect(403);
      // The provider never comes from the payload.
      await assign(t.A, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
        providerId: providers.B,
      }).expect(400);
      await assign(t.A, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
        status: 'ACTIVE',
      }).expect(400);
      expect(await activeOf(other.id)).toBeNull();
      await api()
        .post(
          `/api/v1/provider/dispatches/${other.id}/assignment?providerId=${providers.B}`,
        )
        .auth(t.A, bearer)
        .send({ driverId: drivers.pedro, vehicleId: vehicles.moto07 })
        .expect(403);
    });

    it('respects the V1.4 driver ↔ vehicle pairing in both directions', async () => {
      const other = await claimedDispatch();
      // Ana is paired with MOTO-09: neither half of that pair works with another.
      for (const [driverId, vehicleId] of [
        [drivers.ana, vehicles.moto07],
        [drivers.pedro, vehicles.moto09],
      ]) {
        const res = await assign(t.A, other.id, { driverId, vehicleId }).expect(
          409,
        );
        expect(res.body.code).toBe('DRIVER_VEHICLE_MISMATCH');
      }
      expect(await activeOf(other.id)).toBeNull();
      await assign(t.A, other.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      }).expect(201);
    });

    it('refuses a driver or vehicle already executing another delivery', async () => {
      const third = await claimedDispatch();
      expect(
        (
          await assign(t.A, third.id, {
            driverId: drivers.pedro,
            vehicleId: vehicles.moto09,
          }).expect(409)
        ).body.code,
      ).toBe('DRIVER_BUSY');
      expect(
        (
          await assign(t.A, third.id, {
            driverId: drivers.ana,
            vehicleId: vehicles.moto07,
          }).expect(409)
        ).body.code,
      ).toBe('VEHICLE_BUSY');
      expect(
        (
          await assign(t.A, third.id, {
            driverId: drivers.suspendido,
            vehicleId: vehicles.moto09,
          }).expect(409)
        ).body.code,
      ).toBe('DRIVER_NOT_ELIGIBLE');
      expect(
        (
          await assign(t.A, third.id, {
            driverId: drivers.sincuenta,
            vehicleId: vehicles.moto09,
          }).expect(409)
        ).body.code,
      ).toBe('DRIVER_NOT_ELIGIBLE');
      expect(
        (
          await assign(t.A, third.id, {
            driverId: drivers.ana,
            vehicleId: vehicles.taller,
          }).expect(409)
        ).body.code,
      ).toBe('VEHICLE_NOT_ELIGIBLE');
      expect(await activeOf(third.id)).toBeNull();
      await assign(t.A, third.id, {
        driverId: drivers.ana,
        vehicleId: vehicles.moto09,
      }).expect(201);
    });

    it('blocks changing the V1.4 vehicle pairing while the resources execute a delivery', async () => {
      await api()
        .post(`/api/v1/provider/drivers/${drivers.carlos}/vehicle`)
        .auth(t.A, bearer)
        .send({ vehicleId: vehicles.moto09 })
        .expect(409);
      await api()
        .delete(`/api/v1/provider/drivers/${drivers.carlos}/vehicle`)
        .auth(t.A, bearer)
        .expect(409);
      await freeResources();
      await api()
        .delete(`/api/v1/provider/drivers/${drivers.carlos}/vehicle`)
        .auth(t.A, bearer)
        .expect(200);
      await api()
        .post(`/api/v1/provider/drivers/${drivers.carlos}/vehicle`)
        .auth(t.A, bearer)
        .send({ vehicleId: vehicles.moto03 })
        .expect(201);
    });
  },
);

describe.sequential('Reassignment, release protection and cancellation', () => {
  withApp();

  it('reassigns atomically keeping history and rejects an unchanged pair', async () => {
    const dispatch = await claimedDispatch();
    const first = await assign(t.A, dispatch.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    expect(
      (
        await reassign(t.A, dispatch.id, {
          driverId: drivers.carlos,
          vehicleId: vehicles.moto03,
          reason: 'OPERATIONAL_CHANGE',
        }).expect(409)
      ).body.code,
    ).toBe('ASSIGNMENT_UNCHANGED');
    for (const body of [
      { driverId: drivers.pedro, vehicleId: vehicles.moto07, reason: 'OTHER' },
      {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
        reason: 'OTHER',
        reasonDetail: 'no',
      },
      {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
        reason: 'DELIVERY_CANCELLED',
      },
    ])
      await reassign(t.A, dispatch.id, body).expect(400);
    const second = await reassign(t.A, dispatch.id, {
      driverId: drivers.pedro,
      vehicleId: vehicles.moto07,
      reason: 'DRIVER_UNAVAILABLE',
      reasonDetail: 'Carlos terminó su turno',
    }).expect(200);
    expect(second.body).toMatchObject({
      status: 'ACTIVE',
      driver: { id: drivers.pedro },
      vehicle: { id: vehicles.moto07 },
    });
    expect(second.body.id).not.toBe(first.body.id);
    const rows = await prisma.deliveryAssignment.findMany({
      where: { dispatchId: dispatch.id },
      orderBy: { assignedAt: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: first.body.id,
      status: 'REASSIGNED',
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
      endReason: 'DRIVER_UNAVAILABLE',
      endReasonDetail: 'Carlos terminó su turno',
    });
    expect(rows[0].endedAt).not.toBeNull();
    expect(rows[1].status).toBe('ACTIVE');
    const list = await history(t.A, dispatch.id).expect(200);
    expect(list.body.map((a: { id: string }) => a.id)).toEqual([
      second.body.id,
      first.body.id,
    ]);
    // Carlos and MOTO-03 are free again.
    const another = await claimedDispatch();
    await assign(t.A, another.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    await cancelAssignment(t.A, another.id).expect(200);
    await cancelAssignment(t.A, dispatch.id, {
      reason: 'OPERATIONAL_CHANGE',
    }).expect(200);
  });

  it('refuses to release a dispatch with an active assignment and allows it after cancelling', async () => {
    const dispatch = await claimedDispatch();
    await assign(t.A, dispatch.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    const blocked = await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
      .auth(t.A, bearer)
      .send({ reason: 'NO_DRIVER_AVAILABLE' })
      .expect(409);
    expect(blocked.body.code).toBe('DISPATCH_HAS_ACTIVE_ASSIGNMENT');
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
        .status,
    ).toBe('CLAIMED');
    const cancelled = await cancelAssignment(t.A, dispatch.id, {
      reason: 'DRIVER_UNAVAILABLE',
    }).expect(200);
    expect(cancelled.body).toMatchObject({
      status: 'CANCELLED',
      endReason: 'DRIVER_UNAVAILABLE',
    });
    expect(await activeOf(dispatch.id)).toBeNull();
    expect(
      (await cancelAssignment(t.A, dispatch.id).expect(409)).body.code,
    ).toBe('NO_ACTIVE_ASSIGNMENT');
    const released = await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
      .auth(t.A, bearer)
      .send({ reason: 'NO_DRIVER_AVAILABLE' })
      .expect(200);
    expect(released.body.status).toBe('OPEN');
    // Without the claim there is nothing to assign.
    expect(
      (
        await assign(t.A, dispatch.id, {
          driverId: drivers.carlos,
          vehicleId: vehicles.moto03,
        }).expect(409)
      ).body.code,
    ).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
  });

  it('cancels the active assignment when the delivery is cancelled, keeping the history', async () => {
    const dispatch = await claimedDispatch();
    const created = await assign(t.A, dispatch.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    await api()
      .post(
        `/api/v1/admin/delivery-requests/${dispatch.requestPublicId}/cancel`,
      )
      .auth(t.sa, bearer)
      .send({ reason: 'Cliente canceló' })
      .expect(200);
    const row = await prisma.deliveryAssignment.findUniqueOrThrow({
      where: { id: created.body.id },
    });
    expect(row).toMatchObject({
      status: 'CANCELLED',
      endReason: 'DELIVERY_CANCELLED',
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    });
    expect(row.endedAt).not.toBeNull();
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
        .status,
    ).toBe('CANCELLED');
    expect((await history(t.A, dispatch.id).expect(200)).body).toHaveLength(1);
    expect(
      (
        await assign(t.A, dispatch.id, {
          driverId: drivers.carlos,
          vehicleId: vehicles.moto03,
        }).expect(409)
      ).body.code,
    ).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    // Resources are free for the next dispatch.
    const next = await claimedDispatch();
    await assign(t.A, next.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    await cancelAssignment(t.A, next.id).expect(200);
  });

  it('flags an overdue assignment after the configured deadline', async () => {
    const dispatch = await claimedDispatch();
    const real = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(real + 6 * 60_000);
      const overdue = await api()
        .get(`/api/v1/provider/dispatches/${dispatch.id}`)
        .auth(t.A, bearer)
        .expect(200);
      expect(overdue.body).toMatchObject({
        status: 'CLAIMED',
        assignmentOverdue: true,
      });
      await assign(t.A, dispatch.id, {
        driverId: drivers.carlos,
        vehicleId: vehicles.moto03,
      }).expect(201);
      const assigned = await api()
        .get(`/api/v1/provider/dispatches/${dispatch.id}`)
        .auth(t.A, bearer)
        .expect(200);
      expect(assigned.body.assignmentOverdue).toBe(false);
      // Cancelled under the same travelled clock: endedAt is never before assignedAt.
      await cancelAssignment(t.A, dispatch.id).expect(200);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.sequential('Concurrency and database invariants', () => {
  withApp();

  it('10 simultaneous assignments on one dispatch leave exactly one ACTIVE', async () => {
    const dispatch = await claimedDispatch();
    const pairs = [
      [drivers.carlos, vehicles.moto03],
      [drivers.pedro, vehicles.moto07],
      [drivers.ana, vehicles.moto09],
    ];
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => {
        const [driverId, vehicleId] = pairs[i % pairs.length];
        return assign(t.A, dispatch.id, { driverId, vehicleId });
      }),
    );
    expect(responses.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      responses.filter(
        (r) =>
          r.status === 409 &&
          ['DISPATCH_ALREADY_ASSIGNED', 'ASSIGNMENT_CONFLICT'].includes(
            r.body.code,
          ),
      ),
    ).toHaveLength(9);
    expect(
      await prisma.deliveryAssignment.count({
        where: { dispatchId: dispatch.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await cancelAssignment(t.A, dispatch.id).expect(200);
  });

  it('the same driver or vehicle cannot be assigned to two dispatches at once', async () => {
    const [first, second] = [await claimedDispatch(), await claimedDispatch()];
    const driverRace = await Promise.all([
      assign(t.A, first.id, {
        driverId: drivers.carlos,
        vehicleId: vehicles.moto03,
      }),
      assign(t.A, second.id, {
        driverId: drivers.carlos,
        vehicleId: vehicles.moto03,
      }),
    ]);
    expect(driverRace.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      driverRace.filter(
        (r) =>
          r.status === 409 &&
          ['DRIVER_BUSY', 'VEHICLE_BUSY', 'ASSIGNMENT_CONFLICT'].includes(
            r.body.code,
          ),
      ),
    ).toHaveLength(1);
    expect(
      await prisma.deliveryAssignment.count({
        where: { driverId: drivers.carlos, status: 'ACTIVE' },
      }),
    ).toBe(1);

    const [third, fourth] = [await claimedDispatch(), await claimedDispatch()];
    const vehicleRace = await Promise.all([
      assign(t.A, third.id, {
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      }),
      assign(t.A, fourth.id, {
        driverId: drivers.ana,
        vehicleId: vehicles.moto07,
      }),
    ]);
    expect(vehicleRace.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      await prisma.deliveryAssignment.count({
        where: { vehicleId: vehicles.moto07, status: 'ACTIVE' },
      }),
    ).toBe(1);
    for (const dispatch of [first, second, third, fourth])
      if (await activeOf(dispatch.id))
        await cancelAssignment(t.A, dispatch.id).expect(200);
  });

  it('enforces the three ACTIVE invariants and history immutability in PostgreSQL', async () => {
    const dispatch = await claimedDispatch();
    const created = await assign(t.A, dispatch.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    const base = {
      providerId: providers.A,
      assignedAt: new Date(),
      assignedByUserId: t.saId,
    };
    // Second ACTIVE per dispatch, per driver and per vehicle.
    for (const data of [
      {
        dispatchId: dispatch.id,
        driverId: drivers.pedro,
        vehicleId: vehicles.moto07,
      },
      {
        dispatchId: (await claimedDispatch()).id,
        driverId: drivers.carlos,
        vehicleId: vehicles.moto07,
      },
      {
        dispatchId: (await claimedDispatch()).id,
        driverId: drivers.pedro,
        vehicleId: vehicles.moto03,
      },
    ])
      await expect(
        prisma.deliveryAssignment.create({ data: { ...base, ...data } }),
      ).rejects.toThrow();
    // An assignment needs a dispatch CLAIMED by the same provider.
    const foreign = await claimedDispatch();
    await expect(
      prisma.deliveryAssignment.create({
        data: {
          ...base,
          providerId: providers.B,
          dispatchId: foreign.id,
          driverId: drivers.bruno,
          vehicleId: vehicles.motoB,
        },
      }),
    ).rejects.toThrow(/DELIVERY_ASSIGNMENT_INVALID/);
    await expect(
      prisma.deliveryAssignment.update({
        where: { id: created.body.id },
        data: { driverId: drivers.pedro },
      }),
    ).rejects.toThrow(/DELIVERY_ASSIGNMENT_IMMUTABLE/);
    // The dispatch cannot leave CLAIMED while the assignment is ACTIVE.
    await expect(
      prisma.dispatch.update({
        where: { id: dispatch.id },
        data: { status: 'OPEN', claimedByProviderId: null, claimedAt: null },
      }),
    ).rejects.toThrow(/DISPATCH_HAS_ACTIVE_ASSIGNMENT/);
    await cancelAssignment(t.A, dispatch.id).expect(200);
    await expect(
      prisma.deliveryAssignment.update({
        where: { id: created.body.id },
        data: { status: 'ACTIVE', endedAt: null, endReason: null },
      }),
    ).rejects.toThrow(/DELIVERY_ASSIGNMENT_IMMUTABLE/);
  });

  it('gives SUPER_ADMIN the full history and never leaks secrets in logs', async () => {
    const dispatch = await claimedDispatch();
    const created = await assign(t.A, dispatch.id, {
      driverId: drivers.carlos,
      vehicleId: vehicles.moto03,
    }).expect(201);
    await reassign(t.A, dispatch.id, {
      driverId: drivers.pedro,
      vehicleId: vehicles.moto07,
      reason: 'VEHICLE_ISSUE',
    }).expect(200);
    const admin = await api()
      .get(`/api/v1/admin/dispatches/${dispatch.id}/assignments`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(admin.body).toHaveLength(2);
    expect(admin.body.at(-1)).toMatchObject({
      id: created.body.id,
      status: 'REASSIGNED',
      provider: { id: providers.A },
    });
    const adminDispatch = await api()
      .get(`/api/v1/admin/dispatches/${dispatch.id}`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(adminDispatch.body.activeAssignment).toMatchObject({
      driver: { id: drivers.pedro },
    });
    await cancelAssignment(t.A, dispatch.id).expect(200);
    const joined = logs.join('\n');
    for (const event of [
      'DELIVERY_ASSIGNMENT_CREATED',
      'DELIVERY_ASSIGNMENT_REASSIGNED',
      'DELIVERY_ASSIGNMENT_CANCELLED',
    ])
      expect(joined, event).toContain(event);
    expect(
      logs.some(
        (l) =>
          l.includes('DELIVERY_ASSIGNMENT_CREATED') &&
          l.includes('"driverId"') &&
          l.includes('"vehicleId"') &&
          l.includes('"actorUserId"'),
      ),
    ).toBe(true);
    for (const secret of [
      password,
      t.A,
      t.sa,
      t.b2b,
      t.clientSecret,
      '9614443322',
    ])
      expect(joined.includes(secret), 'sensitive value in logs').toBe(false);
  });
});
