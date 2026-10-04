import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_EXEC_';
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

describe('Detailed execution HTTP and PostgreSQL', () => {
  withApp();
  const phases = [
    'TO_PICKUP',
    'AT_PICKUP',
    'PICKED_UP',
    'TO_DROPOFF',
    'AT_DROPOFF',
  ];
  const view = async (id: string) =>
    (
      await api()
        .get('/api/v1/provider/dispatches/' + id + '/execution')
        .auth(t.A, bearer)
        .expect(200)
    ).body.execution;
  const step = async (id: string, phase: string, key = randomUUID()) => {
    const e = await view(id);
    return api()
      .post('/api/v1/driver/dispatches/' + id + '/execution-events')
      .auth(await assignedToken(id), bearer)
      .set('Idempotency-Key', key)
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        phase,
      });
  };
  const driverStep = async (id: string, token: string, phase: string) => {
    const e = (
      await api()
        .get('/api/v1/driver/dispatches/' + id + '/execution')
        .auth(token, bearer)
        .expect(200)
    ).body.execution;
    return api()
      .post('/api/v1/driver/dispatches/' + id + '/execution-events')
      .auth(token, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        phase,
      });
  };
  const start = async () => {
    const d = await openDispatch();
    await claim(t.A, d.id).expect(200);
    await assign(t.A, d.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    return d;
  };
  it('requires five consecutive reports; rejects role and duplicate writes; delivers once', async () => {
    const d = await start();
    expect((await step(d.id, 'PICKED_UP')).status).toBe(409);
    await deliver(t.A, d.id).expect(403);
    const e = await view(d.id),
      key = randomUUID(),
      body = {
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        phase: 'TO_PICKUP',
      };
    const call = () =>
      api()
        .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
        .auth(t.ana, bearer)
        .set('Idempotency-Key', key)
        .send(body);
    const replies = await Promise.all([call(), call()]);
    expect(replies.map((x) => x.status)).toEqual([200, 200]);
    expect(replies[0].body).toEqual(replies[1].body);
    await api()
      .post('/api/v1/provider/dispatches/' + d.id + '/execution-events')
      .auth(t.ana, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(403);
    for (const phase of phases.slice(1))
      expect((await step(d.id, phase)).status).toBe(200);
    await appDeliver(d.id);
    await appDeliver(d.id);
    expect(
      await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
    ).toBe(1);
    expect(await refundsOf(d.id)).toBe(0);
  });
  it('holds custody, rejects ordinary cancellation, and resolves return once under concurrency', async () => {
    const d = await start();
    for (const phase of phases.slice(0, 3))
      expect((await step(d.id, phase)).status).toBe(200);
    await api()
      .post('/api/v1/delivery-requests/' + d.requestPublicId + '/cancel')
      .auth(t.b2b, bearer)
      .send({ reason: 'Test custody cancellation' })
      .expect(409);
    const e = await view(d.id);
    await api()
      .post('/api/v1/provider/dispatches/' + d.id + '/custody-incidents')
      .auth(t.A, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'RECIPIENT_UNAVAILABLE',
        reasonDetail: '   ',
      })
      .expect(400);
    const incident = await api()
      .post('/api/v1/provider/dispatches/' + d.id + '/custody-incidents')
      .auth(t.A, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'RECIPIENT_UNAVAILABLE',
        reasonDetail: 'Recipient did not answer',
      })
      .expect(201);
    const v = incident.body.execution;
    const body = {
      assignmentId: v.activeAssignmentId,
      expectedRevision: v.revision,
      type: 'RETURN_TO_ORIGIN',
      reason: 'Restaurant received whole order',
      occurredAt: new Date().toISOString(),
      confirmationMethod: 'PHONE',
      custodianConfirmed: true,
      originConfirmed: true,
      originContactLabel: 'Test restaurant manager',
      originContactRole: 'Manager',
    };
    const call = () =>
      api()
        .post(
          '/api/v1/admin/dispatches/' +
            d.id +
            '/custody-incidents/' +
            incident.body.id +
            '/resolve',
        )
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send(body);
    const results = await Promise.all([call(), call()]);
    expect(results.map((x) => x.status).sort()).toEqual([200, 409]);
    expect((await dispatchRow(d.id)).status).toBe('RETURNED');
    expect(await refundsOf(d.id)).toBe(0);
    expect(
      await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
    ).toBe(0);
  });
  it('transfers fleet custody to independent atomically without another award or fabricated pickup', async () => {
    const d = await start();
    for (const phase of phases.slice(0, 3))
      expect((await step(d.id, phase)).status).toBe(200);
    const e = await view(d.id);
    const incident = await api()
      .post('/api/v1/provider/dispatches/' + d.id + '/custody-incidents')
      .auth(t.A, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'VEHICLE_FAILURE',
        reasonDetail: 'Vehicle unavailable for continuation',
      })
      .expect(201);
    const v = incident.body.execution;
    const body = {
      assignmentId: v.activeAssignmentId,
      expectedRevision: v.revision,
      type: 'TRANSFER',
      reason: 'Custody received by replacement',
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
    };
    const resolved = await api()
      .post(
        '/api/v1/admin/dispatches/' +
          d.id +
          '/custody-incidents/' +
          incident.body.id +
          '/resolve',
      )
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(200);
    expect(resolved.body.execution.phase).toBe('PICKED_UP');
    await api()
      .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
      .auth(t.ana, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: resolved.body.execution.revision,
        phase: 'TO_DROPOFF',
      })
      .expect(404);
    await api()
      .post('/api/v1/driver/dispatches/' + d.id + '/execution-completion')
      .auth(t.ana, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: resolved.body.execution.revision,
      })
      .expect(409);
    await deliver(t.A, d.id).expect(403);
    for (const phase of phases.slice(3)) {
      const state = (
        await api()
          .get('/api/v1/driver/dispatches/' + d.id + '/execution')
          .auth(t.indy, bearer)
          .expect(200)
      ).body.execution;
      await api()
        .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
        .auth(t.indy, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: state.activeAssignmentId,
          expectedRevision: state.revision,
          phase,
        })
        .expect(200);
    }
    await appDeliver(d.id);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { referenceId: d.id, type: 'SERVICE_AWARD' },
      }),
    ).toBe(1);
    expect(await refundsOf(d.id)).toBe(0);
  });
  it('rejects replay changes, forged actors and direct SQL jumps while preserving the original event', async () => {
    const d = await start(),
      e = await view(d.id),
      key = randomUUID();
    const body = {
      assignmentId: e.activeAssignmentId,
      expectedRevision: e.revision,
      phase: 'TO_PICKUP',
    };
    const call = (payload: object) =>
      api()
        .post(`/api/v1/driver/dispatches/${d.id}/execution-events`)
        .auth(t.ana, bearer)
        .set('Idempotency-Key', key)
        .send(payload);
    await call(body).expect(200);
    await call({ ...body, phase: 'AT_PICKUP' }).expect(409);
    await call({ ...body, actorUserId: users.sa }).expect(400);
    await api()
      .get(`/api/v1/provider/dispatches/${d.id}/execution`)
      .auth(t.B, bearer)
      .expect(404);
    await api()
      .get(`/api/v1/provider/dispatches/${d.id}/execution`)
      .auth(t.b2b, bearer)
      .expect(401);
    await expect(
      prisma.$executeRaw`UPDATE "DeliveryExecution" SET phase=5 WHERE "dispatchId"=${d.id}::uuid`,
    ).rejects.toThrow();
    await expect(
      prisma.$executeRaw`DELETE FROM "DeliveryExecutionEvent" WHERE "dispatchId"=${d.id}::uuid`,
    ).rejects.toThrow();
    expect((await view(d.id)).phase).toBe('TO_PICKUP');
    const current = await view(d.id);
    const next = () =>
      api()
        .post(`/api/v1/driver/dispatches/${d.id}/execution-events`)
        .auth(t.ana, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: current.activeAssignmentId,
          expectedRevision: current.revision,
          phase: 'AT_PICKUP',
        });
    expect(
      (await Promise.all([next(), next()])).map((r) => r.status).sort(),
    ).toEqual([200, 409]);
    for (const phase of phases.slice(2))
      expect((await step(d.id, phase)).status).toBe(200);
    await appDeliver(d.id);
  });
  it('transfers independent custody to fleet, rejects an ineligible vehicle and rolls back a forced insertion failure', async () => {
    const d = await openDispatch();
    await take(t.indy, d.id, vehicles.indy).expect(200);
    const indyView = async () =>
      (
        await api()
          .get(`/api/v1/driver/dispatches/${d.id}/execution`)
          .auth(t.indy, bearer)
          .expect(200)
      ).body.execution;
    for (const phase of phases.slice(0, 3)) {
      const e = await indyView();
      await api()
        .post(`/api/v1/driver/dispatches/${d.id}/execution-events`)
        .auth(t.indy, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: e.activeAssignmentId,
          expectedRevision: e.revision,
          phase,
        })
        .expect(200);
    }
    const e = await indyView();
    const incident = await api()
      .post(`/api/v1/driver/dispatches/${d.id}/custody-incidents`)
      .auth(t.indy, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        reasonCode: 'VEHICLE_FAILURE',
        reasonDetail: 'Controlled fixture incident',
      })
      .expect(201);
    const v = incident.body.execution;
    const body = {
      assignmentId: v.activeAssignmentId,
      expectedRevision: v.revision,
      type: 'TRANSFER',
      reason: 'Fleet received custody at pickup',
      occurredAt: new Date().toISOString(),
      confirmationMethod: 'PHONE',
      recipient: {
        mode: 'FLEET',
        providerId: providers.A,
        driverId: drivers.beto,
        vehicleId: vehicles.fleet2,
      },
      releasingCustodianConfirmed: true,
      receivingCustodianConfirmed: true,
      atCurrentStageLocation: true,
      recipientProviderAdminUserId: users.adminA,
      recipientProviderAdminConfirmed: true,
    };
    const key = randomUUID();
    const resolve = (payload = body, k = key) =>
      api()
        .post(
          `/api/v1/admin/dispatches/${d.id}/custody-incidents/${incident.body.id}/resolve`,
        )
        .auth(t.sa, bearer)
        .set('Idempotency-Key', k)
        .send(payload);
    await resolve(
      { ...body, recipient: { ...body.recipient, vehicleId: vehicles.indy } },
      randomUUID(),
    ).expect(409);
    const candidates = await api()
      .get(
        `/api/v1/admin/dispatches/${d.id}/custody-transfer-candidates?mode=FLEET`,
      )
      .auth(t.sa, bearer)
      .expect(200);
    expect(
      candidates.body.items.some(
        (x: { driverId: string; vehicleId: string }) =>
          x.driverId === drivers.beto && x.vehicleId === vehicles.fleet2,
      ),
    ).toBe(true);
    // This isolated database-only trigger fails AFTER predecessor mutation, proving rollback.
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION execution_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."dispatchId"='${d.id}'::uuid AND NEW."custodyResolutionId" IS NOT NULL THEN RAISE EXCEPTION 'CONTROLLED_TEST_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER execution_test_failure BEFORE INSERT ON "DeliveryAssignment" FOR EACH ROW EXECUTE FUNCTION execution_test_failure()',
    );
    try {
      await resolve().expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER execution_test_failure ON "DeliveryAssignment"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION execution_test_failure()');
    }
    expect((await indyView()).revision).toBe(v.revision);
    expect(
      await prisma.deliveryCustodyResolution.count({
        where: { incidentId: incident.body.id },
      }),
    ).toBe(0);
    expect(
      (await assignmentsOf(d.id)).filter((x) => x.status === 'ACTIVE'),
    ).toHaveLength(1);
    const resolved = await resolve().expect(200);
    expect((await resolve().expect(200)).body).toEqual(resolved.body);
    await api()
      .get(`/api/v1/driver/dispatches/${d.id}`)
      .auth(t.indy, bearer)
      .expect(404);
    const provider = await api()
      .get(`/api/v1/provider/dispatches/${d.id}`)
      .auth(t.A, bearer)
      .expect(200);
    expect(provider.body.advanceToOriginAllowed).toBe(false);
    for (const phase of phases.slice(3))
      expect((await step(d.id, phase)).status).toBe(200);
    await appDeliver(d.id);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { referenceId: d.id, type: 'SERVICE_AWARD' },
      }),
    ).toBe(1);
    expect(await refundsOf(d.id)).toBe(0);
    const status = await api()
      .get(`/api/v1/delivery-requests/${d.requestPublicId}/status`)
      .auth(t.b2b, bearer)
      .expect(200);
    expect(status.body.status).toBe('DELIVERED');
    expect(status.body.execution.mode).toBe('PROVIDER');
    expect(JSON.stringify(status.body)).not.toContain('reasonDetail');
  });
  it('serializes pickup against B2B cancellation without a refund under custody', async () => {
    const d = await start();
    for (const p of phases.slice(0, 2))
      expect((await step(d.id, p)).status).toBe(200);
    const e = await view(d.id);
    const pickup = api()
      .post(`/api/v1/driver/dispatches/${d.id}/execution-events`)
      .auth(t.ana, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.activeAssignmentId,
        expectedRevision: e.revision,
        phase: 'PICKED_UP',
      });
    const cancel = api()
      .post(`/api/v1/delivery-requests/${d.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'Concurrent synthetic cancellation' });
    const [p, c] = await Promise.all([pickup, cancel]);
    expect([p.status, c.status].sort()).toEqual([200, 409]);
    if (p.status === 200) {
      expect(await refundsOf(d.id)).toBe(0);
      for (const phase of phases.slice(3))
        expect((await step(d.id, phase)).status).toBe(200);
      await appDeliver(d.id);
    } else {
      expect((await dispatchRow(d.id)).status).toBe('CANCELLED');
      expect(await refundsOf(d.id)).toBe(1);
      expect(
        await prisma.deliveryExecutionEvent.count({
          where: { dispatchId: d.id, kind: 'ADVANCED', phase: 3 },
        }),
      ).toBe(0);
    }
  });
  it('permits only one of two concurrent custody transfers to the same recipient', async () => {
    const a = await start(),
      b = await openDispatch();
    await claim(t.A, b.id).expect(200);
    await assign(t.A, b.id, {
      driverId: drivers.beto,
      vehicleId: vehicles.fleet2,
    }).expect(201);
    const commands = [];
    for (const d of [a, b]) {
      for (const phase of phases.slice(0, 3))
        expect((await step(d.id, phase)).status).toBe(200);
      const e = await view(d.id);
      const i = await api()
        .post(`/api/v1/provider/dispatches/${d.id}/custody-incidents`)
        .auth(t.A, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: e.activeAssignmentId,
          expectedRevision: e.revision,
          reasonCode: 'VEHICLE_FAILURE',
          reasonDetail: 'Fixture competing for recipient',
        })
        .expect(201);
      commands.push({
        id: d.id,
        incidentId: i.body.id as string,
        assignmentId: i.body.execution.activeAssignmentId as string,
        revision: i.body.execution.revision as number,
      });
    }
    const responses = await Promise.all(
      commands.map((c) =>
        api()
          .post(
            `/api/v1/admin/dispatches/${c.id}/custody-incidents/${c.incidentId}/resolve`,
          )
          .auth(t.sa, bearer)
          .set('Idempotency-Key', randomUUID())
          .send({
            assignmentId: c.assignmentId,
            expectedRevision: c.revision,
            type: 'TRANSFER',
            reason: 'Physical transfer test',
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
          }),
      ),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    for (const [index, c] of commands.entries()) {
      expect(await refundsOf(c.id)).toBe(0);
      expect(
        await prisma.deliveryAssignment.count({
          where: { dispatchId: c.id, status: 'ACTIVE' },
        }),
      ).toBe(1);
      if (responses[index].status === 200) {
        for (const phase of phases.slice(3)) {
          const e = (
            await api()
              .get(`/api/v1/driver/dispatches/${c.id}/execution`)
              .auth(t.indy, bearer)
              .expect(200)
          ).body.execution;
          await api()
            .post(`/api/v1/driver/dispatches/${c.id}/execution-events`)
            .auth(t.indy, bearer)
            .set('Idempotency-Key', randomUUID())
            .send({
              assignmentId: e.activeAssignmentId,
              expectedRevision: e.revision,
              phase,
            })
            .expect(200);
        }
        await appDeliver(c.id);
      } else {
        await api()
          .post(
            `/api/v1/admin/dispatches/${c.id}/custody-incidents/${c.incidentId}/resolve`,
          )
          .auth(t.sa, bearer)
          .set('Idempotency-Key', randomUUID())
          .send({
            assignmentId: c.assignmentId,
            expectedRevision: c.revision,
            type: 'RETURN_TO_ORIGIN',
            reason: 'Origin received retained order',
            occurredAt: new Date().toISOString(),
            confirmationMethod: 'PHONE',
            custodianConfirmed: true,
            originConfirmed: true,
            originContactLabel: 'Fixture manager',
            originContactRole: 'Manager',
          })
          .expect(200);
      }
    }
  });
  it('starts a fresh chain on ordinary reassignment before pickup, even when new admission is disabled', async () => {
    const d = await start();
    expect((await step(d.id, 'TO_PICKUP')).status).toBe(200);
    const previous = await view(d.id);
    app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', false);
    try {
      await api()
        .post(`/api/v1/provider/dispatches/${d.id}/assignment/reassign`)
        .auth(t.A, bearer)
        .send({
          driverId: drivers.beto,
          vehicleId: vehicles.fleet2,
          reason: 'OPERATIONAL_CHANGE',
        })
        .expect(200);
      const current = await view(d.id);
      expect(current.phase).toBeNull();
      expect(current.revision).toBeGreaterThan(previous.revision);
      expect(current.activeAssignmentId).not.toBe(previous.activeAssignmentId);
      await api()
        .post('/api/v1/driver/dispatches/' + d.id + '/execution-events')
        .auth(t.ana, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: previous.activeAssignmentId,
          expectedRevision: current.revision,
          phase: 'TO_PICKUP',
        })
        .expect(404);
      for (const phase of phases)
        expect((await step(d.id, phase)).status).toBe(200);
      await appDeliver(d.id);
      expect(await refundsOf(d.id)).toBe(0);
    } finally {
      app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', true);
    }
  });
  for (const scenario of [
    'lost response',
    'rollback',
    'delayed original',
    'race',
    'closed replay',
    'unauthorized',
    'process restart',
  ]) {
    it(`reconciles resolution attempt: ${scenario}`, async () => {
      const d = await start();
      for (const phase of phases.slice(0, 3))
        expect((await step(d.id, phase)).status).toBe(200);
      const e = await view(d.id);
      const incident = await api()
        .post(`/api/v1/provider/dispatches/${d.id}/custody-incidents`)
        .auth(t.A, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          assignmentId: e.activeAssignmentId,
          expectedRevision: e.revision,
          reasonCode: 'OTHER',
          reasonDetail: 'Synthetic reconciliation test',
        })
        .expect(201);
      const base = `/api/v1/admin/dispatches/${d.id}/custody-incidents/${incident.body.id}`;
      const key = randomUUID();
      const body = {
        assignmentId: e.activeAssignmentId,
        expectedRevision: incident.body.execution.revision,
        type: 'RETURN_TO_ORIGIN',
        reason: 'Confirmed synthetic return',
        occurredAt: new Date().toISOString(),
        confirmationMethod: 'PHONE',
        custodianConfirmed: true,
        originConfirmed: true,
        originContactLabel: 'Fixture',
        originContactRole: 'Manager',
      };
      const resolve = (k = key) =>
        api()
          .post(base + '/resolve')
          .auth(t.sa, bearer)
          .set('Idempotency-Key', k)
          .send(body);
      const read = () =>
        api()
          .get(base + '/resolution-attempt')
          .auth(t.sa, bearer)
          .set('Idempotency-Key', key);
      const close = () =>
        api()
          .post(base + '/resolution-attempt/close')
          .auth(t.sa, bearer)
          .set('Idempotency-Key', key);
      expect((await read().expect(200)).body).toEqual({
        state: 'PENDING_OR_UNKNOWN',
        resolutionId: null,
        canStartNewAttempt: false,
      });
      expect(
        await prisma.deliveryExecutionCommand.count({
          where: { dispatchId: d.id, operation: `RESOLVE:${incident.body.id}` },
        }),
      ).toBe(0);
      if (scenario === 'lost response') {
        await resolve().expect(200); // The client discards the response; only durable lookup is used.
        const receipt = (await read().expect(200)).body;
        expect(receipt.state).toBe('APPLIED');
        expect(Object.keys(receipt).sort()).toEqual([
          'canStartNewAttempt',
          'resolutionId',
          'state',
        ]);
        expect((await close().expect(200)).body).toEqual(receipt);
      } else if (scenario === 'race') {
        const [original, closed] = await Promise.all([resolve(), close()]);
        expect(closed.status).toBe(200);
        if (closed.body.state === 'APPLIED') expect(original.status).toBe(200);
        else {
          expect(closed.body.state).toBe('CLOSED_NO_EFFECTS');
          expect(original.status).toBe(409);
        }
      } else if (scenario === 'rollback') {
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION test_reconciliation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'RESOLVE:%' AND NEW.state='APPLIED' THEN RAISE EXCEPTION 'CONTROLLED_TEST_FAILURE'; END IF; RETURN NEW; END $$`,
        );
        await prisma.$executeRawUnsafe(
          'CREATE TRIGGER test_reconciliation_failure BEFORE INSERT ON "DeliveryExecutionCommand" FOR EACH ROW EXECUTE FUNCTION test_reconciliation_failure()',
        );
        try {
          await resolve().expect(500);
        } finally {
          await prisma.$executeRawUnsafe(
            'DROP TRIGGER test_reconciliation_failure ON "DeliveryExecutionCommand"',
          );
          await prisma.$executeRawUnsafe(
            'DROP FUNCTION test_reconciliation_failure()',
          );
        }
        expect((await read()).body.state).toBe('PENDING_OR_UNKNOWN');
        expect(
          await prisma.deliveryCustodyResolution.count({
            where: { incidentId: incident.body.id },
          }),
        ).toBe(0);
        expect(
          (
            await prisma.deliveryAssignment.findUniqueOrThrow({
              where: { id: e.activeAssignmentId },
            })
          ).status,
        ).toBe('ACTIVE');
        expect((await close()).body.state).toBe('CLOSED_NO_EFFECTS');
      } else if (scenario === 'unauthorized') {
        await api()
          .get(base + '/resolution-attempt')
          .auth(t.A, bearer)
          .set('Idempotency-Key', key)
          .expect(403);
        await api()
          .post(base + '/resolution-attempt/close')
          .auth(t.b2b, bearer)
          .set('Idempotency-Key', key)
          .expect(401);
        // A different admin's identically named key does not close this actor's attempt.
        await api()
          .post(base + '/resolution-attempt/close')
          .auth(t.sa2, bearer)
          .set('Idempotency-Key', key)
          .expect(200);
        expect((await read()).body.state).toBe('PENDING_OR_UNKNOWN');
        await resolve().expect(200);
        expect(
          (
            await api()
              .get(base + '/resolution-attempt')
              .auth(t.sa2, bearer)
              .set('Idempotency-Key', key)
          ).body.state,
        ).toBe('CLOSED_NO_EFFECTS');
      } else {
        const closed = (await close().expect(200)).body;
        expect(closed).toEqual({
          state: 'CLOSED_NO_EFFECTS',
          resolutionId: null,
          canStartNewAttempt: true,
        });
        expect((await close().expect(200)).body).toEqual(closed);
        if (scenario === 'process restart') {
          await app.close();
          const script = `import {PrismaClient} from '@prisma/client'; import {ExecutionService} from './dist/delivery-execution/execution.service.js'; const db=new PrismaClient(); try { console.log(JSON.stringify(await new ExecutionService(db).reconcileResolution(process.argv[1],process.argv[2],{id:process.argv[3],role:'SUPER_ADMIN'},process.argv[4]))); } finally {await db.$disconnect();}`;
          const durable = execFileSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              script,
              d.id,
              incident.body.id,
              users.sa,
              key,
            ],
            { encoding: 'utf8', timeout: 15000 },
          );
          expect(JSON.parse(durable)).toEqual(closed);
          app = await bootstrap();
        }
        const rejected = await resolve().expect(409);
        expect(JSON.stringify(rejected.body)).toContain(
          'EXECUTION_ATTEMPT_CLOSED',
        );
        await resolve().expect(409);
        await api()
          .post(
            base.replace(incident.body.id, incident.body.id.toUpperCase()) +
              '/resolve',
          )
          .auth(t.sa, bearer)
          .set('Idempotency-Key', key.toUpperCase())
          .send(body)
          .expect(409);
      }
      if (
        !(await prisma.deliveryCustodyResolution.findUnique({
          where: { incidentId: incident.body.id },
        }))
      )
        await resolve(randomUUID()).expect(200);
      expect(
        await prisma.deliveryCustodyResolution.count({
          where: { incidentId: incident.body.id },
        }),
      ).toBe(1);
      expect(
        await prisma.deliveryAssignment.count({
          where: { dispatchId: d.id, status: 'ACTIVE' },
        }),
      ).toBe(0);
      expect(await refundsOf(d.id)).toBe(0);
    });
  }
  it('authorizes fleet driver context while denying provider advancement, unrelated driver and independent TAKE', async () => {
    const d = await start();
    const e = await view(d.id);
    expect(e.allowedActions).not.toContain('ADVANCE');
    const body = {
      assignmentId: e.activeAssignmentId,
      expectedRevision: e.revision,
      phase: 'TO_PICKUP',
    };
    await api()
      .post(`/api/v1/provider/dispatches/${d.id}/execution-events`)
      .auth(t.A, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(403);
    await api()
      .post(`/api/v1/driver/dispatches/${d.id}/execution-events`)
      .auth(t.otro, bearer)
      .set('Idempotency-Key', randomUUID())
      .send(body)
      .expect(404);
    await take(t.ana, d.id, vehicles.fleet1).expect(409);
    const details = await api()
      .get(`/api/v1/driver/dispatches/${d.id}`)
      .auth(t.ana, bearer)
      .expect(200);
    expect(details.body.access).toBe('OWNER');
    expect(details.body.paymentContext).toBeDefined();
    expect(details.body.execution.allowedActions).toContain('ADVANCE');
    const me = await api()
      .get('/api/v1/driver/me')
      .auth(t.ana, bearer)
      .expect(200);
    expect(me.body.activeDeliveryAssignment.dispatchId).toBe(d.id);
    for (const phase of phases)
      expect((await step(d.id, phase)).status).toBe(200);
    await deliver(t.A, d.id).expect(403);
    await appDeliver(d.id);
    expect((await dispatchRow(d.id)).deliveredByUserId).toBe(users.ana);
  });

  for (const mode of ['fleet', 'independent'] as const)
    for (const operation of ['ADVANCE', 'REPORT', 'DELIVER'] as const) {
      it(`reconciles ${mode} driver ${operation}: delayed command, closed replay, commit with lost response and durable restart`, async () => {
        const d = mode === 'fleet' ? await start() : await openDispatch();
        const token = mode === 'fleet' ? t.ana : t.indy;
        if (mode === 'independent')
          await take(token, d.id, vehicles.indy).expect(200);
        const preparatory =
          operation === 'REPORT'
            ? phases.slice(0, 3)
            : operation === 'DELIVER'
              ? phases
              : [];
        for (const phase of preparatory)
          expect((await driverStep(d.id, token, phase)).status).toBe(200);
        const e = (
          await api()
            .get(`/api/v1/driver/dispatches/${d.id}/execution`)
            .auth(token, bearer)
            .expect(200)
        ).body.execution;
        const body = {
          assignmentId: e.activeAssignmentId,
          expectedRevision: e.revision,
          ...(operation === 'ADVANCE'
            ? { phase: 'TO_PICKUP' }
            : operation === 'REPORT'
              ? {
                  reasonCode: 'OTHER',
                  reasonDetail: 'Synthetic app uncertainty',
                }
              : {}),
        };
        const suffix =
          operation === 'ADVANCE'
            ? 'execution-events'
            : operation === 'REPORT'
              ? 'custody-incidents'
              : 'execution-completion';
        const base = `/api/v1/driver/dispatches/${d.id}/assignments/${e.activeAssignmentId}/attempt`;
        const key = randomUUID();
        const command = (k: string) =>
          api()
            .post(`/api/v1/driver/dispatches/${d.id}/${suffix}`)
            .auth(token, bearer)
            .set('Idempotency-Key', k)
            .send(body);
        const read = (k: string, reader = token) =>
          api()
            .get(`${base}?operation=${operation}`)
            .auth(reader, bearer)
            .set('Idempotency-Key', k);
        expect((await read(key).expect(200)).body.state).toBe(
          'PENDING_OR_UNKNOWN',
        );
        await read(key, t.otro).expect(404);
        await read(key, t.A).expect(403);
        const closed = await api()
          .post(`${base}/close?operation=${operation}`)
          .auth(token, bearer)
          .set('Idempotency-Key', key)
          .expect(200);
        expect(closed.body.state).toBe('CLOSED_NO_EFFECTS');
        expect((await command(key).expect(409)).body.code).toBe(
          'EXECUTION_ATTEMPT_CLOSED',
        );
        const applied = randomUUID();
        const response = await command(applied).expect(
          operation === 'REPORT' ? 201 : 200,
        );
        // Discard the response as the app would after a network timeout; restart the server.
        await app.close();
        app = await bootstrap();
        expect((await read(applied).expect(200)).body.state).toBe('APPLIED');
        const replay = await command(applied).expect(
          operation === 'REPORT' ? 201 : 200,
        );
        expect(replay.body).toEqual(response.body);
        expect(
          (
            await api()
              .post(`${base}/close?operation=${operation}`)
              .auth(token, bearer)
              .set('Idempotency-Key', applied)
              .expect(200)
          ).body.state,
        ).toBe('APPLIED');
        if (operation === 'ADVANCE') {
          for (const phase of phases.slice(1))
            expect((await driverStep(d.id, token, phase)).status).toBe(200);
          await appDeliver(d.id);
        }
        if (operation === 'REPORT') {
          const v = (
            await api()
              .get(`/api/v1/driver/dispatches/${d.id}/execution`)
              .auth(token, bearer)
              .expect(200)
          ).body.execution;
          await api()
            .post(
              `/api/v1/admin/dispatches/${d.id}/custody-incidents/${v.openIncidentId}/resolve`,
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
              originContactRole: 'Manager',
            })
            .expect(200);
        }
        if (operation === 'DELIVER')
          expect(
            await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
          ).toBe(1);
      });
    }

  it('serializes driver completion against attempt closure and rolls back completion when receipt fails', async () => {
    const d = await start();
    for (const phase of phases)
      expect((await step(d.id, phase)).status).toBe(200);
    const e = await view(d.id);
    const key = randomUUID();
    const body = {
      assignmentId: e.activeAssignmentId,
      expectedRevision: e.revision,
    };
    const command = () =>
      api()
        .post(`/api/v1/driver/dispatches/${d.id}/execution-completion`)
        .auth(t.ana, bearer)
        .set('Idempotency-Key', key)
        .send(body);
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION app_receipt_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation LIKE 'APP_DELIVER:%' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER app_receipt_fail BEFORE INSERT ON "DeliveryExecutionCommand" FOR EACH ROW EXECUTE FUNCTION app_receipt_fail()',
    );
    try {
      await command().expect(500);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER app_receipt_fail ON "DeliveryExecutionCommand"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION app_receipt_fail()');
    }
    expect((await dispatchRow(d.id)).status).toBe('CLAIMED');
    expect(
      await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
    ).toBe(0);
    expect((await view(d.id)).revision).toBe(e.revision);
    const close = () =>
      api()
        .post(
          `/api/v1/driver/dispatches/${d.id}/assignments/${e.activeAssignmentId}/attempt/close?operation=DELIVER`,
        )
        .auth(t.ana, bearer)
        .set('Idempotency-Key', key);
    const [sent, closed] = await Promise.all([command(), close()]);
    if (closed.body.state === 'APPLIED') expect(sent.status).toBe(200);
    else {
      expect(closed.body.state).toBe('CLOSED_NO_EFFECTS');
      expect(sent.status).toBe(409);
      await appDeliver(d.id);
    }
    expect(
      await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
    ).toBe(1);
    expect(await refundsOf(d.id)).toBe(0);
  });

  it('allows assigned fleet driver to complete legacy using revision zero and a durable receipt', async () => {
    app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', false);
    try {
      const d = await start();
      const a = (await assignmentsOf(d.id))[0];
      const key = randomUUID();
      const send = () =>
        api()
          .post(`/api/v1/driver/dispatches/${d.id}/execution-completion`)
          .auth(t.ana, bearer)
          .set('Idempotency-Key', key)
          .send({ assignmentId: a.id, expectedRevision: 0 });
      await send().expect(200);
      await send().expect(200);
      expect(
        await prisma.deliveryExecution.count({ where: { dispatchId: d.id } }),
      ).toBe(0);
      expect(
        await prisma.b2bOutboxEvent.count({ where: { dispatchId: d.id } }),
      ).toBe(1);
    } finally {
      app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', true);
    }
  });

  it('preserves untracked assignments when admission is disabled; legacy delivers without invented milestones', async () => {
    app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', false);
    try {
      const d = await start();
      expect(
        await prisma.deliveryExecution.count({ where: { dispatchId: d.id } }),
      ).toBe(0);
      app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', true);
      await deliver(t.A, d.id).expect(200);
      expect(
        await prisma.deliveryExecutionEvent.count({
          where: { dispatchId: d.id },
        }),
      ).toBe(0);
    } finally {
      app.get(ConfigService).set('DETAILED_EXECUTION_ENABLED', true);
    }
  });
});
