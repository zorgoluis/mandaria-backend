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
// LOCAL/TEST ONLY: lets the suite point Mandaria at a real receiver on 127.0.0.1 over http.
// Production refuses to start with this enabled.
process.env.B2B_WEBHOOK_ALLOW_INSECURE_TARGETS = 'true';
process.env.B2B_WEBHOOK_TIMEOUT_MS = '1500';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_HOOK_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@b2b-webhook.test`.toLowerCase();
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
const ZONE = { lng: -98.4, lat: 21.4 };
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
async function openDispatch(asClient = t.b2b) {
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
    .auth(asClient, bearer)
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
    .auth(asClient, bearer)
    .expect(201);
  await api()
    .post(`/api/v1/delivery-quotes/${quote.body.publicId}/accept`)
    .auth(asClient, bearer)
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
    .send({ reason: 'Alta para V1.12-C' })
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
    .send({ name: 'Webhook client A', code: `${PREFIX}CLIENT_${run}` })
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
      where: { email: { endsWith: '@b2b-webhook.test' } },
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
  // V1.12-C: attempts hold their event and endpoint with RESTRICT and refuse ordinary deletion,
  // so fixture teardown removes them under the same *_test-only switch the ledger uses.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.b2bWebhookDeliveryAttempt.deleteMany({
      where: { integrationClientId: { in: clientIds } },
    }),
  ]);
  await prisma.b2bWebhookEndpoint.deleteMany({
    where: { integrationClientId: { in: clientIds } },
  });
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

/**
 * A throwaway HTTP receiver, outside the product, so the suite can watch what Mandaria actually
 * puts on the wire: method, path, headers and body. It is scripted per request — status codes,
 * deliberate slowness, redirects — which is what makes the failure cases real instead of mocked.
 */
type Received = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  raw: string;
};
type Script = { status?: number; delayMs?: number; location?: string };

function createReceiver() {
  const received: Received[] = [];
  const script: Script[] = [];
  let fallback: Script = { status: 200 };
  let server: import('node:http').Server | undefined;
  let port = 0;
  return {
    received,
    /** Answers this way once, then moves on to the next scripted answer. */
    reply(next: Script) {
      script.push(next);
    },
    /** Answers this way from now on. */
    always(next: Script) {
      fallback = next;
      script.length = 0;
    },
    reset() {
      received.length = 0;
      script.length = 0;
      fallback = { status: 200 };
    },
    get url() {
      return `http://127.0.0.1:${port}/hooks/mandaria`;
    },
    get port() {
      return port;
    },
    async start() {
      const { createServer } = await import('node:http');
      server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            body = raw;
          }
          received.push({
            method: req.method ?? '',
            path: req.url ?? '',
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(',') : (v ?? ''),
              ]),
            ),
            body,
            raw,
          });
          const next = script.shift() ?? fallback;
          const answer = () => {
            if (next.location) {
              res.writeHead(next.status ?? 302, { Location: next.location });
              res.end();
              return;
            }
            res.writeHead(next.status ?? 200, { 'Content-Type': 'text/plain' });
            res.end('ok');
          };
          if (next.delayMs) setTimeout(answer, next.delayMs);
          else answer();
        });
      });
      await new Promise<void>((resolve) =>
        server!.listen(0, '127.0.0.1', resolve),
      );
      port = (server!.address() as { port: number }).port;
    },
    async stop() {
      if (!server) return;
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    },
  };
}

const receiver = createReceiver();
const otherReceiver = createReceiver();

/** Waits for the background first attempt to land in the database. */
async function waitForAttempts(eventId: string, count = 1, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId },
      orderBy: { attemptedAt: 'asc' },
    });
    if (rows.length >= count) return rows;
    if (Date.now() > deadline)
      throw new Error(
        `expected ${count} attempt(s) for ${eventId}, saw ${rows.length}`,
      );
    await new Promise((r) => setTimeout(r, 50));
  }
}
const eventOf = (dispatchId: string) =>
  prisma.b2bOutboxEvent.findFirstOrThrow({ where: { dispatchId } });
const setEndpoint = (clientId: string, body: object) =>
  api()
    .put(`/api/v1/admin/integrations/${clientId}/webhook`)
    .auth(t.sa, bearer)
    .send(body);
const deliverEvent = (eventId: string) =>
  api()
    .post(`/api/v1/admin/b2b-events/${eventId}/deliver`)
    .auth(t.sa, bearer)
    .send({});
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
});

describe('V1.12-C a completed delivery reaches the client that asked for it', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await otherReceiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
    await otherReceiver.stop();
  });
  beforeEach(async () => {
    receiver.reset();
    otherReceiver.reset();
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    }).expect(200);
  });

  it('a provider delivery is POSTed as the recorded event, with its id in a header', async () => {
    const dispatch = await openDispatch();
    await claim(t.A, dispatch.id).expect(200);
    await assign(t.A, dispatch.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    const before = await economy();
    const routingBefore = routing.calls;
    await deliver(t.A, dispatch.id).expect(200);

    const event = await eventOf(dispatch.id);
    const [attempt] = await waitForAttempts(event.id);
    expect(receiver.received).toHaveLength(1);
    const [request] = receiver.received;
    expect(request.method).toBe('POST');
    expect(request.path).toBe('/hooks/mandaria');
    expect(request.headers['content-type']).toContain('application/json');
    expect(request.headers['x-mandaria-event-id']).toBe(event.id);
    expect(request.headers['x-mandaria-event-type']).toBe('delivery.completed');
    expect(request.body).toEqual({
      eventId: event.id,
      type: 'delivery.completed',
      occurredAt: event.occurredAt.toISOString(),
      // The very snapshot V1.12-B froze, not a fresh read of the tables.
      data: event.payload,
    });
    expect(request.raw).not.toContain('DELIVERY_COMPLETED');
    expect(attempt).toMatchObject({
      eventId: event.id,
      integrationClientId: ids.b2bClient,
      endpointUrl: receiver.url,
      result: 'SUCCEEDED',
      httpStatus: 200,
      failureKind: null,
      failureDetail: null,
    });
    expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
    // Transport moved nothing of the domain.
    expect(await economy()).toEqual(before);
    expect(routing.calls).toBe(routingBefore);
  });

  it('an independent delivery arrives the same way, with its own execution mode', async () => {
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    await driverDeliver(t.indy, dispatch.id).expect(200);
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const [request] = receiver.received;
    expect(request.body).toEqual({
      eventId: event.id,
      type: 'delivery.completed',
      occurredAt: event.occurredAt.toISOString(),
      data: event.payload,
    });
    expect(
      (request.body as { data: { execution: { mode: string } } }).data.execution
        .mode,
    ).toBe('INDEPENDENT');
  });

  it('the body carries no internal identifier and no secret', async () => {
    const dispatch = await deliveredByProvider();
    await waitForAttempts((await eventOf(dispatch.id)).id);
    const { raw } = receiver.received[0];
    for (const forbidden of [
      dispatch.id,
      ids.b2bClient,
      providers.A,
      drivers.ana,
      vehicles.fleet1,
      users.adminA,
      'deliveredByUserId',
      'creditCost',
      'Authorization',
      'secret',
      'password',
    ])
      expect(raw).not.toContain(forbidden);
  });

  it('every 2xx counts as delivered', async () => {
    for (const status of [200, 201, 202, 204]) {
      receiver.always({ status });
      const dispatch = await deliveredByProvider();
      const event = await eventOf(dispatch.id);
      const [attempt] = await waitForAttempts(event.id);
      expect([status, attempt.result, attempt.httpStatus]).toEqual([
        status,
        'SUCCEEDED',
        status,
      ]);
    }
  });
});

describe('V1.12-C a failing client cannot undo a delivery', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(async () => {
    receiver.reset();
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    }).expect(200);
  });

  it('every non-2xx is a transport failure and nothing else changes', async () => {
    for (const status of [400, 401, 404, 409, 429, 500, 503]) {
      receiver.always({ status });
      const dispatch = await openDispatch();
      await claim(t.A, dispatch.id).expect(200);
      await assign(t.A, dispatch.id, {
        driverId: drivers.ana,
        vehicleId: vehicles.fleet1,
      }).expect(201);
      const before = await economy();
      await deliver(t.A, dispatch.id).expect(200);
      const event = await eventOf(dispatch.id);
      const [attempt] = await waitForAttempts(event.id);
      expect([status, attempt.result, attempt.httpStatus]).toEqual([
        status,
        'FAILED',
        status,
      ]);
      expect(attempt.failureKind).toBe('HTTP_STATUS');
      expect(attempt.failureDetail).toBe(`HTTP_${status}`);
      // The obligatory one: a 500 from the client does not revert the delivery.
      const row = await dispatchRow(dispatch.id);
      expect(row.status).toBe('DELIVERED');
      expect((await assignmentsOf(dispatch.id)).map((a) => a.status)).toEqual([
        'COMPLETED',
      ]);
      expect(await economy()).toEqual(before);
      // And the recorded event is untouched.
      expect(await eventOf(dispatch.id)).toEqual(event);
    }
  });

  it('a receiver that never answers is cut off by the timeout', async () => {
    receiver.always({ status: 200, delayMs: 4000 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const [attempt] = await waitForAttempts(event.id);
    expect(attempt).toMatchObject({
      result: 'FAILED',
      failureKind: 'TIMEOUT',
      httpStatus: null,
    });
    // The process is healthy: the next delivery works.
    receiver.always({ status: 200 });
    const next = await deliveredByProvider();
    const [ok] = await waitForAttempts((await eventOf(next.id)).id);
    expect(ok.result).toBe('SUCCEEDED');
  });

  it('a permitted destination with nobody listening fails cleanly', async () => {
    await receiver.stop();
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const [attempt] = await waitForAttempts(event.id);
    expect(attempt).toMatchObject({
      result: 'FAILED',
      failureKind: 'NETWORK',
      httpStatus: null,
    });
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
    // An unrelated API is unaffected.
    await api()
      .get(`/api/v1/delivery-requests/${dispatch.requestPublicId}/status`)
      .auth(t.b2b, bearer)
      .expect(200);
    await receiver.start();
  });

  it('a redirect is not followed: it is recorded as a failure', async () => {
    receiver.always({ status: 302, location: 'http://169.254.169.254/latest' });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const [attempt] = await waitForAttempts(event.id);
    expect(attempt).toMatchObject({
      result: 'FAILED',
      failureKind: 'HTTP_STATUS',
      httpStatus: 302,
    });
    // Exactly one request left Mandaria: the redirect was never chased.
    expect(receiver.received).toHaveLength(1);
  });

  it('a failed attempt and its event survive a restart', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const before = await waitForAttempts(event.id);
    await app.close();
    app = await bootstrap();
    expect(
      await prisma.b2bWebhookDeliveryAttempt.findMany({
        where: { eventId: event.id },
        orderBy: { attemptedAt: 'asc' },
      }),
    ).toEqual(before);
    expect(await eventOf(dispatch.id)).toEqual(event);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
  });
});

describe('V1.12-C without a destination there is nothing to attempt', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(() => receiver.reset());

  it('a disabled endpoint means no request and no attempt', async () => {
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: false,
    }).expect(200);
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    // Give the background work a chance to do the wrong thing.
    await new Promise((r) => setTimeout(r, 400));
    expect(receiver.received).toHaveLength(0);
    expect(
      await prisma.b2bWebhookDeliveryAttempt.count({
        where: { eventId: event.id },
      }),
    ).toBe(0);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
    // And the manual route says why, instead of pretending something was tried.
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toEqual({
      kind: 'skipped',
      reason: 'ENDPOINT_DISABLED',
    });
  });

  it('no endpoint at all behaves the same way', async () => {
    // An endpoint with attempts against it cannot be removed (RESTRICT, on purpose: transport
    // history keeps pointing at what it was sent to), so the fixture clears them first with the
    // *_test-only switch, the same way it clears the ledger.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.b2bWebhookDeliveryAttempt.deleteMany({
        where: { integrationClientId: ids.b2bClient },
      }),
    ]);
    await prisma.b2bWebhookEndpoint.deleteMany({
      where: { integrationClientId: ids.b2bClient },
    });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(receiver.received).toHaveLength(0);
    expect(
      await prisma.b2bWebhookDeliveryAttempt.count({
        where: { eventId: event.id },
      }),
    ).toBe(0);
    expect((await dispatchRow(dispatch.id)).status).toBe('DELIVERED');
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toEqual({ kind: 'skipped', reason: 'NO_ENDPOINT' });
  });
});

describe('V1.12-C one client, one destination', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await otherReceiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
    await otherReceiver.stop();
  });

  it('the event of one client never reaches the receiver of another', async () => {
    receiver.reset();
    otherReceiver.reset();
    // A second IntegrationClient with its own receiver and its own delivery.
    const other = await api()
      .post('/api/v1/admin/integrations')
      .auth(t.sa, bearer)
      .send({ name: 'Webhook client B', code: `${PREFIX}OTHER_${run}` })
      .expect(201);
    const credential = await api()
      .post(`/api/v1/admin/integrations/${other.body.id}/credentials`)
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
    const otherToken = (
      await api()
        .post('/api/v1/integrations/token')
        .send({
          clientId: credential.body.clientId,
          clientSecret: credential.body.clientSecret,
        })
        .expect(200)
    ).body.accessToken as string;
    await setEndpoint(ids.b2bClient, { url: receiver.url }).expect(200);
    await setEndpoint(other.body.id, { url: otherReceiver.url }).expect(200);

    const mine = await deliveredByProvider();
    const mineEvent = await eventOf(mine.id);
    await waitForAttempts(mineEvent.id);

    const theirs = await openDispatch(otherToken);
    await freeFixtureResources();
    await claim(t.A, theirs.id).expect(200);
    await assign(t.A, theirs.id, {
      driverId: drivers.ana,
      vehicleId: vehicles.fleet1,
    }).expect(201);
    await deliver(t.A, theirs.id).expect(200);
    const theirEvent = await eventOf(theirs.id);
    await waitForAttempts(theirEvent.id);

    // Each receiver saw exactly its own event, and nothing of the other.
    expect(
      receiver.received.map((r) => r.headers['x-mandaria-event-id']),
    ).toEqual([mineEvent.id]);
    expect(
      otherReceiver.received.map((r) => r.headers['x-mandaria-event-id']),
    ).toEqual([theirEvent.id]);
    const attempts = await prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId: { in: [mineEvent.id, theirEvent.id] } },
      select: { eventId: true, integrationClientId: true, endpointUrl: true },
    });
    expect(
      attempts.every(
        (a) =>
          a.integrationClientId ===
          (a.eventId === mineEvent.id ? ids.b2bClient : other.body.id),
      ),
    ).toBe(true);
  });
});

describe('V1.12-C configuring a destination is an administrative act', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
  });
  afterAll(async () => {
    await receiver.stop();
  });

  it('only SUPER_ADMIN may write it', async () => {
    const body = { url: receiver.url };
    const path = `/api/v1/admin/integrations/${ids.b2bClient}/webhook`;
    const codes = {
      superAdmin: (await api().put(path).auth(t.sa, bearer).send(body)).status,
      providerAdmin: (await api().put(path).auth(t.A, bearer).send(body))
        .status,
      driver: (await api().put(path).auth(t.indy, bearer).send(body)).status,
      b2b: (await api().put(path).auth(t.b2b, bearer).send(body)).status,
      anonymous: (await api().put(path).send(body)).status,
    };
    expect(codes).toEqual({
      superAdmin: 200,
      providerAdmin: 403,
      driver: 403,
      b2b: 401,
      anonymous: 401,
    });
  });

  it('only SUPER_ADMIN may trigger a delivery by hand', async () => {
    await setEndpoint(ids.b2bClient, { url: receiver.url }).expect(200);
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const path = `/api/v1/admin/b2b-events/${event.id}/deliver`;
    expect({
      providerAdmin: (await api().post(path).auth(t.A, bearer).send({})).status,
      driver: (await api().post(path).auth(t.indy, bearer).send({})).status,
      b2b: (await api().post(path).auth(t.b2b, bearer).send({})).status,
      anonymous: (await api().post(path).send({})).status,
    }).toEqual({ providerAdmin: 403, driver: 403, b2b: 401, anonymous: 401 });
  });

  it('a destination Mandaria must not call is refused with a reason', async () => {
    // The suite runs with the LOCAL/TEST switch on, so loopback is allowed here on purpose; what
    // is checked is that the shape of the URL is still policed. The address policy itself is
    // covered against production settings in the unit tests.
    for (const url of [
      'https://user:pass@example.com/h',
      'not-a-url',
      'ftp://example.com/h',
      `https://example.com/${'x'.repeat(2100)}`,
    ]) {
      const res = await setEndpoint(ids.b2bClient, { url });
      expect([url, res.status]).toEqual([url, 400]);
    }
  });

  it('a manual delivery makes exactly one more attempt and leaves the event alone', async () => {
    await setEndpoint(ids.b2bClient, { url: receiver.url }).expect(200);
    receiver.reset();
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toMatchObject({
      kind: 'attempted',
      result: 'SUCCEEDED',
      httpStatus: 200,
    });
    const attempts = await waitForAttempts(event.id, 2);
    // At-least-once is the contract: two attempts, two rows, one unchanged event.
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((a) => a.id)).size).toBe(2);
    expect(await eventOf(dispatch.id)).toEqual(event);
    expect(receiver.received).toHaveLength(2);
    expect(
      new Set(receiver.received.map((r) => r.headers['x-mandaria-event-id'])),
    ).toEqual(new Set([event.id]));
  });
});

describe('V1.12-C attempts are history', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await setEndpoint(ids.b2bClient, { url: receiver.url }).expect(200);
  });
  afterAll(async () => {
    await receiver.stop();
  });

  it('SQL cannot turn a failure into a success or move it to another endpoint', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const [attempt] = await waitForAttempts(event.id);
    expect(attempt.result).toBe('FAILED');
    const results: Record<string, string> = {};
    const attempts: [string, Promise<unknown>][] = [
      [
        'result',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bWebhookDeliveryAttempt" SET "result" = 'SUCCEEDED' WHERE id = $1::uuid`,
          attempt.id,
        ),
      ],
      [
        'httpStatus',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bWebhookDeliveryAttempt" SET "httpStatus" = 200 WHERE id = $1::uuid`,
          attempt.id,
        ),
      ],
      [
        'eventId',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bWebhookDeliveryAttempt" SET "eventId" = gen_random_uuid() WHERE id = $1::uuid`,
          attempt.id,
        ),
      ],
      [
        'endpoint',
        prisma.$executeRawUnsafe(
          `UPDATE "B2bWebhookDeliveryAttempt" SET "endpointUrl" = 'https://elsewhere.example.com/h' WHERE id = $1::uuid`,
          attempt.id,
        ),
      ],
      [
        'delete',
        prisma.$executeRawUnsafe(
          `DELETE FROM "B2bWebhookDeliveryAttempt" WHERE id = $1::uuid`,
          attempt.id,
        ),
      ],
      [
        'truncate',
        prisma.$executeRawUnsafe(`TRUNCATE TABLE "B2bWebhookDeliveryAttempt"`),
      ],
    ];
    for (const [name, work] of attempts)
      results[name] = await work.then(
        () => 'ACCEPTED',
        (error: unknown) =>
          String((error as Error).message).includes(
            'B2B_WEBHOOK_ATTEMPT_IMMUTABLE',
          )
            ? 'IMMUTABLE'
            : 'REJECTED',
      );
    expect(results).toEqual({
      result: 'IMMUTABLE',
      httpStatus: 'IMMUTABLE',
      eventId: 'IMMUTABLE',
      endpoint: 'IMMUTABLE',
      delete: 'IMMUTABLE',
      truncate: 'IMMUTABLE',
    });
    expect(
      await prisma.b2bWebhookDeliveryAttempt.findUniqueOrThrow({
        where: { id: attempt.id },
      }),
    ).toEqual(attempt);
    receiver.always({ status: 200 });
  });

  it('SQL cannot move an endpoint to another client, nor invent one', async () => {
    const endpoint = await prisma.b2bWebhookEndpoint.findUniqueOrThrow({
      where: { integrationClientId: ids.b2bClient },
    });
    const owner = await prisma
      .$executeRawUnsafe(
        `UPDATE "B2bWebhookEndpoint" SET "integrationClientId" = gen_random_uuid() WHERE id = $1::uuid`,
        endpoint.id,
      )
      .then(
        () => 'ACCEPTED',
        (e: unknown) =>
          String((e as Error).message).includes(
            'B2B_WEBHOOK_ENDPOINT_IMMUTABLE',
          )
            ? 'IMMUTABLE'
            : 'REJECTED',
      );
    const ghost = await prisma
      .$executeRawUnsafe(
        `INSERT INTO "B2bWebhookEndpoint" ("id","integrationClientId","url","enabled","updatedAt","createdByUserId","updatedByUserId")
       VALUES (gen_random_uuid(), gen_random_uuid(), 'https://example.com/h', true, now(), $1::uuid, $1::uuid)`,
        users.sa,
      )
      .then(
        () => 'ACCEPTED',
        () => 'REJECTED',
      );
    expect({ owner, ghost }).toEqual({ owner: 'IMMUTABLE', ghost: 'REJECTED' });
    expect(
      await prisma.b2bWebhookEndpoint.findUniqueOrThrow({
        where: { id: endpoint.id },
      }),
    ).toEqual(endpoint);
  });

  it('an attempt cannot be attached to an event of another client', async () => {
    const endpoint = await prisma.b2bWebhookEndpoint.findUniqueOrThrow({
      where: { integrationClientId: ids.b2bClient },
    });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const stranger = await api()
      .post('/api/v1/admin/integrations')
      .auth(t.sa, bearer)
      .send({ name: 'Webhook stranger', code: `${PREFIX}STR_${run}` })
      .expect(201);
    const outcome = await prisma
      .$executeRawUnsafe(
        `INSERT INTO "B2bWebhookDeliveryAttempt"
         ("id","eventId","integrationClientId","endpointId","endpointUrl","attemptedAt","durationMs","result","httpStatus")
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'https://example.com/h', now(), 1, 'SUCCEEDED', 200)`,
        event.id,
        stranger.body.id,
        endpoint.id,
      )
      .then(
        () => 'ACCEPTED',
        () => 'REJECTED',
      );
    expect(outcome).toBe('REJECTED');
  });
});
