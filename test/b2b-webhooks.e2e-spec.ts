import 'reflect-metadata';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { B2bWebhooksService } from '../dist/b2b-webhooks/b2b-webhooks.service.js';
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
// V1.12-D: a master key for the per-endpoint HMAC secrets, and a worker the suite drives itself
// (poll 0) so every case is deterministic instead of waiting for a timer.
process.env.B2B_WEBHOOK_SECRET_KEY = randomBytes(32).toString('hex');
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';
process.env.B2B_WEBHOOK_LEASE_SECONDS = '5';

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
    prisma.b2bWebhookDelivery.deleteMany({
      where: { integrationClientId: { in: clientIds } },
    }),
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
        // Several cases cut Mandaria's request off on purpose (the timeout, the closed
        // connection). The socket then dies under this handler, and an unhandled 'error' on it
        // takes the whole worker process down mid-suite — which is exactly how runs were
        // disappearing. Nothing here needs to react to it beyond not dying.
        req.on('error', () => undefined);
        res.on('error', () => undefined);
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
            if (res.destroyed || res.writableEnded) return;
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
      server.on('clientError', (_error, socket) => socket.destroy());
      server.on('error', () => undefined);
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
const secrets: Record<string, string> = {};
const setEndpoint = (clientId: string, body: object) =>
  api()
    .put(`/api/v1/admin/integrations/${clientId}/webhook`)
    .auth(t.sa, bearer)
    .send(body);
/** Configures the endpoint and issues its signing secret, which V1.12-D requires to deliver. */
const configureEndpoint = async (clientId: string, body: object) => {
  await setEndpoint(clientId, body).expect(200);
  secrets[clientId] = await issueSecret(clientId);
};
const issueSecret = async (clientId: string) =>
  (
    await api()
      .post(`/api/v1/admin/integrations/${clientId}/webhook/secret`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200)
  ).body.secret as string;
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
    await configureEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    });
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
    await configureEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    });
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
    await configureEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: false,
    });
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
    // And the manual route says why, instead of pretending something was tried. V1.12-E adds the
    // operator's reading of the same answer, which for a skip is that nothing was sent.
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toEqual({
      kind: 'skipped',
      reason: 'ENDPOINT_DISABLED',
      outcome: 'SKIPPED',
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
      prisma.b2bWebhookDelivery.deleteMany({
        where: { integrationClientId: ids.b2bClient },
      }),
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
    expect(manual.body).toEqual({
      kind: 'skipped',
      reason: 'NO_ENDPOINT',
      outcome: 'SKIPPED',
    });
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
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
    await configureEndpoint(other.body.id, { url: otherReceiver.url });

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
    const mineSeen = receiver.received.map(
      (r) => r.headers['x-mandaria-event-id'],
    );
    const theirsSeen = otherReceiver.received.map(
      (r) => r.headers['x-mandaria-event-id'],
    );
    expect(mineSeen).toContain(mineEvent.id);
    expect(theirsSeen).toContain(theirEvent.id);
    // V1.12-D: the worker drains everything eligible for a client, so what matters is not how
    // many each receiver saw but that neither ever sees the other client's event.
    expect(mineSeen).not.toContain(theirEvent.id);
    expect(theirsSeen).not.toContain(mineEvent.id);
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
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
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
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
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
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
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

/** V1.12-D helpers: the worker is driven explicitly, and the receiver verifies signatures. */
const worker = () => app.get(B2bWebhooksService);
const deliveryOf = (eventId: string) =>
  prisma.b2bWebhookDelivery.findUniqueOrThrow({ where: { eventId } });
const verifySignature = (
  request: { raw: string; headers: Record<string, string> },
  secret: string,
) => {
  const timestamp = request.headers['x-mandaria-timestamp'];
  const expected = `v1=${createHmac('sha256', secret)
    .update(`${timestamp}.${request.raw}`)
    .digest('hex')}`;
  return request.headers['x-mandaria-signature'] === expected;
};
/** Moves a pending delivery's schedule into the past, instead of waiting an hour for it. */
const makeDue = (eventId: string) =>
  prisma.b2bWebhookDelivery.update({
    where: { eventId },
    data: { nextAttemptAt: new Date(Date.now() - 1000) },
  });

describe('V1.12-D reliable delivery', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(() => receiver.reset());

  it('a provider delivery is signed, delivered on the first attempt and closed', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const delivery = await deliveryOf(event.id);
    expect(delivery).toMatchObject({
      state: 'DELIVERED',
      attemptCount: 1,
      nextAttemptAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      exhaustedAt: null,
    });
    expect(delivery.deliveredAt).not.toBeNull();
    const request = receiver.received.find(
      (r) => r.headers['x-mandaria-event-id'] === event.id,
    )!;
    // The receiver verifies the signature over the exact bytes it received.
    expect(verifySignature(request, secrets[ids.b2bClient])).toBe(true);
    expect(request.headers['x-mandaria-timestamp']).toMatch(/^\d{10}$/);
    const [attempt] = await prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId: event.id },
    });
    expect(attempt.attemptNumber).toBe(1);
  }, 30000);

  it('an independent delivery travels the same way', async () => {
    receiver.always({ status: 200 });
    const dispatch = await openDispatch();
    await take(t.indy, dispatch.id, vehicles.indy).expect(200);
    await driverDeliver(t.indy, dispatch.id).expect(200);
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
    const request = receiver.received.find(
      (r) => r.headers['x-mandaria-event-id'] === event.id,
    )!;
    expect(verifySignature(request, secrets[ids.b2bClient])).toBe(true);
    expect(
      (request.body as { data: { execution: { mode: string } } }).data.execution
        .mode,
    ).toBe('INDEPENDENT');
  }, 30000);

  it('a failure is rescheduled, and the retry that succeeds carries the same event', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const failed = await deliveryOf(event.id);
    expect(failed).toMatchObject({ state: 'PENDING', attemptCount: 1 });
    // One minute out, per the policy, and not due yet.
    expect(
      Math.round(
        (failed.nextAttemptAt!.getTime() - failed.lastAttemptAt!.getTime()) /
          60000,
      ),
    ).toBe(1);
    expect(await worker().tick()).toEqual([]);

    receiver.always({ status: 200 });
    await makeDue(event.id);
    await worker().tick();
    const delivered = await deliveryOf(event.id);
    expect(delivered).toMatchObject({ state: 'DELIVERED', attemptCount: 2 });
    const attempts = await prisma.b2bWebhookDeliveryAttempt.findMany({
      where: { eventId: event.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(attempts.map((a) => [a.attemptNumber, a.result])).toEqual([
      [1, 'FAILED'],
      [2, 'SUCCEEDED'],
    ]);
    // Same event, same body; only the proof of when it was sent differs.
    const sent = receiver.received.filter(
      (r) => r.headers['x-mandaria-event-id'] === event.id,
    );
    expect(sent).toHaveLength(2);
    expect(sent[0].raw).toBe(sent[1].raw);
    // Each attempt is signed afresh over its own timestamp. Two retries inside the same second
    // legitimately produce the same proof, which is why the property asserted here is that both
    // verify against the active secret; the unit tests pin the clock to show they differ.
    expect(sent[0].headers['x-mandaria-event-id']).toBe(
      sent[1].headers['x-mandaria-event-id'],
    );
    expect(sent.every((r) => verifySignature(r, secrets[ids.b2bClient]))).toBe(
      true,
    );
  }, 30000);

  it('five failures exhaust it, and nothing is deleted', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    for (let i = 0; i < 4; i += 1) {
      await makeDue(event.id);
      await worker().tick();
    }
    const exhausted = await deliveryOf(event.id);
    expect(exhausted).toMatchObject({
      state: 'EXHAUSTED',
      attemptCount: 5,
      nextAttemptAt: null,
      deliveredAt: null,
    });
    expect(exhausted.exhaustedAt).not.toBeNull();
    // The worker will not touch it again.
    expect(await worker().tick()).toEqual([]);
    expect(
      await prisma.b2bWebhookDeliveryAttempt.count({
        where: { eventId: event.id },
      }),
    ).toBe(5);
    expect(await eventOf(dispatch.id)).toEqual(event);
    receiver.always({ status: 200 });
  }, 30000);

  it('a terminal answer stops it at once, without spending the schedule', async () => {
    receiver.always({ status: 422 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    expect(await deliveryOf(event.id)).toMatchObject({
      state: 'EXHAUSTED',
      attemptCount: 1,
    });
    receiver.always({ status: 200 });
  }, 30000);

  it('an administrator can rescue an exhausted handover', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    for (let i = 0; i < 4; i += 1) {
      await makeDue(event.id);
      await worker().tick();
    }
    expect((await deliveryOf(event.id)).state).toBe('EXHAUSTED');
    receiver.always({ status: 200 });
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toMatchObject({
      result: 'SUCCEEDED',
      state: 'DELIVERED',
    });
    const rescued = await deliveryOf(event.id);
    expect(rescued).toMatchObject({ state: 'DELIVERED', attemptCount: 6 });
    expect(rescued.exhaustedAt).toBeNull();
  });
});

describe('V1.12-D the work survives the process', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(() => receiver.reset());

  it('an event committed while nothing could send it is found after a restart', async () => {
    // The crash window of V1.12-C: the event commits and no request ever happens. Here the
    // endpoint is disabled at completion time, so nothing in this process can send it.
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: false,
    }).expect(200);
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(receiver.received).toHaveLength(0);
    expect(
      await prisma.b2bWebhookDelivery.count({ where: { eventId: event.id } }),
    ).toBe(0);

    // A whole new process, with no memory of anything, finds the work in the outbox.
    await app.close();
    app = await bootstrap();
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    }).expect(200);
    receiver.always({ status: 200 });
    await worker().tick();
    await waitForAttempts(event.id);
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
    expect(
      receiver.received.map((r) => r.headers['x-mandaria-event-id']),
    ).toContain(event.id);
  }, 30000);

  it('an abandoned lease expires and another worker takes the work over', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // A worker took it and died: the lease is still in the future, owned by nobody alive.
    await prisma.b2bWebhookDelivery.update({
      where: { eventId: event.id },
      data: {
        nextAttemptAt: new Date(Date.now() - 1000),
        leaseOwner: 'dead-worker',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect(await worker().tick()).toEqual([]);
    // The lease lapses, and the work is recoverable again.
    await prisma.b2bWebhookDelivery.update({
      where: { eventId: event.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1000) },
    });
    receiver.always({ status: 200 });
    const done = await worker().tick();
    expect(done).toHaveLength(1);
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
  }, 30000);

  it('two workers against the same database do not do the same work twice', async () => {
    receiver.always({ status: 200 });
    // A second backend, its own worker, same database.
    const second = await bootstrap();
    try {
      const events: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const dispatch = await deliveredByProvider();
        events.push((await eventOf(dispatch.id)).id);
      }
      // Both drain at once. Every event must be handed over exactly once between them.
      await Promise.all([
        worker().tick(),
        second.get(B2bWebhooksService).tick(),
        worker().tick(),
      ]);
      for (const eventId of events) {
        const rows = await prisma.b2bWebhookDeliveryAttempt.findMany({
          where: { eventId },
        });
        expect([eventId, rows.length]).toEqual([eventId, 1]);
        expect((await deliveryOf(eventId)).state).toBe('DELIVERED');
      }
      expect(
        await prisma.b2bWebhookDelivery.count({
          where: { eventId: { in: events } },
        }),
      ).toBe(4);
    } finally {
      await second.close();
    }
  });
});

describe('V1.12-D the secret and its rotation', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(() => receiver.reset());

  it('is shown once and never again', async () => {
    const issued = await api()
      .post(`/api/v1/admin/integrations/${ids.b2bClient}/webhook/secret`)
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    secrets[ids.b2bClient] = issued.body.secret as string;
    expect(issued.body.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(issued.body.algorithm).toBe('HMAC-SHA256');
    const read = await api()
      .get(`/api/v1/admin/integrations/${ids.b2bClient}/webhook`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(read.body.secretConfigured).toBe(true);
    expect(JSON.stringify(read.body)).not.toContain(issued.body.secret);
    expect(read.body.secret).toBeUndefined();
    expect(read.body.secretCiphertext).toBeUndefined();
  }, 30000);

  it('is stored encrypted, never in plain text, and never leaks anywhere else', async () => {
    const secret = await issueSecret(ids.b2bClient);
    secrets[ids.b2bClient] = secret;
    const row = await prisma.b2bWebhookEndpoint.findUniqueOrThrow({
      where: { integrationClientId: ids.b2bClient },
    });
    expect(row.secretCiphertext).not.toContain(secret);
    expect(row.secretCiphertext).toMatch(/^v1:/);
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // Not in the event, not in the attempt, not in what travelled, not in the logs.
    const scan = JSON.stringify([
      await eventOf(dispatch.id),
      await prisma.b2bWebhookDeliveryAttempt.findMany({
        where: { eventId: event.id },
      }),
      receiver.received,
      logs.slice(-400),
    ]);
    expect(scan).not.toContain(secret);
    expect(scan).not.toContain(process.env.B2B_WEBHOOK_SECRET_KEY);
  }, 30000);

  it('rotating changes what new attempts sign, and rewrites no history', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const first = receiver.received.find(
      (r) => r.headers['x-mandaria-event-id'] === event.id,
    )!;
    const oldSecret = secrets[ids.b2bClient];
    expect(verifySignature(first, oldSecret)).toBe(true);
    const newSecret = await issueSecret(ids.b2bClient);
    secrets[ids.b2bClient] = newSecret;
    expect(newSecret).not.toBe(oldSecret);

    receiver.always({ status: 200 });
    await makeDue(event.id);
    await worker().tick();
    const sent = receiver.received.filter(
      (r) => r.headers['x-mandaria-event-id'] === event.id,
    );
    expect(sent).toHaveLength(2);
    // Each attempt is signed with the secret active at the time; the old one is not regenerated.
    expect(verifySignature(sent[1], newSecret)).toBe(true);
    expect(verifySignature(sent[1], oldSecret)).toBe(false);
    expect(verifySignature(sent[0], oldSecret)).toBe(true);
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
  }, 30000);

  it('without a secret nothing is sent, and it resumes once there is one', async () => {
    await prisma.b2bWebhookEndpoint.update({
      where: { integrationClientId: ids.b2bClient },
      data: { secretCiphertext: null, secretSetAt: null },
    });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(await worker().tick()).toEqual([]);
    expect(
      receiver.received.map((r) => r.headers['x-mandaria-event-id']),
    ).not.toContain(event.id);
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toEqual({
      kind: 'skipped',
      reason: 'NO_SECRET',
      outcome: 'SKIPPED',
    });
    // Nothing was lost: with a secret the work is found again.
    secrets[ids.b2bClient] = await issueSecret(ids.b2bClient);
    receiver.always({ status: 200 });
    await worker().tick();
    await waitForAttempts(event.id);
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
  });
});

describe('V1.12-D the boundary and the admin view', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(() => receiver.reset());

  it('an event older than the boundary is never taken by the worker', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // Reproduce a pre-V1.12-D event: the boundary moves past it, and its state is cleared.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.b2bWebhookDelivery.deleteMany({ where: { eventId: event.id } }),
    ]);
    await prisma.b2bWebhookEndpoint.update({
      where: { integrationClientId: ids.b2bClient },
      data: { deliverFrom: new Date(event.occurredAt.getTime() + 1000) },
    });
    receiver.reset();
    expect(await worker().tick()).toEqual([]);
    expect(receiver.received).toHaveLength(0);
    expect(
      await prisma.b2bWebhookDelivery.count({ where: { eventId: event.id } }),
    ).toBe(0);

    // An administrator can still hand it over, and doing so does not enrol it in the retry loop.
    const manual = await deliverEvent(event.id).expect(200);
    expect(manual.body).toMatchObject({
      kind: 'attempted',
      result: 'SUCCEEDED',
      state: 'UNTRACKED',
    });
    expect(
      await prisma.b2bWebhookDelivery.count({ where: { eventId: event.id } }),
    ).toBe(0);
    expect(await worker().tick()).toEqual([]);
    await prisma.b2bWebhookEndpoint.update({
      where: { integrationClientId: ids.b2bClient },
      data: { deliverFrom: new Date() },
    });
  }, 30000);

  it('a disabled endpoint pauses the work and re-enabling resumes it, losing nothing', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: false,
    }).expect(200);
    await makeDue(event.id);
    // Disabled: no attempt made, no state invented, and the work is still owed.
    expect(await worker().tick()).toEqual([]);
    expect(await deliveryOf(event.id)).toMatchObject({
      state: 'PENDING',
      attemptCount: 1,
    });
    receiver.always({ status: 200 });
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    }).expect(200);
    await worker().tick();
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
  }, 30000);

  it('changing the endpoint sends the retry to the new URL without rewriting history', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const [first] = await waitForAttempts(event.id);
    expect(first.endpointUrl).toBe(receiver.url);

    otherReceiver.reset();
    await otherReceiver.start();
    try {
      await setEndpoint(ids.b2bClient, { url: otherReceiver.url }).expect(200);
      otherReceiver.always({ status: 200 });
      await makeDue(event.id);
      await worker().tick();
      const attempts = await prisma.b2bWebhookDeliveryAttempt.findMany({
        where: { eventId: event.id },
        orderBy: { attemptedAt: 'asc' },
      });
      expect(attempts.map((a) => a.endpointUrl)).toEqual([
        receiver.url,
        otherReceiver.url,
      ]);
      // The historical attempt still records where it actually went.
      expect(
        await prisma.b2bWebhookDeliveryAttempt.findUniqueOrThrow({
          where: { id: first.id },
        }),
      ).toEqual(first);
    } finally {
      await otherReceiver.stop();
      await setEndpoint(ids.b2bClient, { url: receiver.url }).expect(200);
    }
  }, 30000);

  it('an administrator can see what is owed without ever seeing a secret', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const view = await api()
      .get(`/api/v1/admin/integrations/${ids.b2bClient}/webhook/deliveries`)
      .auth(t.sa, bearer)
      .expect(200);
    const row = (view.body as Record<string, unknown>[]).find(
      (r) => r.eventId === event.id,
    )!;
    expect(row).toMatchObject({
      state: 'PENDING',
      attemptCount: 1,
      lastResult: 'FAILED',
      lastHttpStatus: 500,
      lastFailureKind: 'HTTP_STATUS',
    });
    expect(row.nextAttemptAt).not.toBeNull();
    expect(JSON.stringify(view.body)).not.toContain(secrets[ids.b2bClient]);
    receiver.always({ status: 200 });
  }, 30000);

  it('only SUPER_ADMIN may issue a secret or read the delivery state', async () => {
    const secretPath = `/api/v1/admin/integrations/${ids.b2bClient}/webhook/secret`;
    const viewPath = `/api/v1/admin/integrations/${ids.b2bClient}/webhook/deliveries`;
    expect({
      secretProvider: (await api().post(secretPath).auth(t.A, bearer).send({}))
        .status,
      secretDriver: (await api().post(secretPath).auth(t.indy, bearer).send({}))
        .status,
      secretB2b: (await api().post(secretPath).auth(t.b2b, bearer).send({}))
        .status,
      secretAnon: (await api().post(secretPath).send({})).status,
      viewProvider: (await api().get(viewPath).auth(t.A, bearer)).status,
      viewB2b: (await api().get(viewPath).auth(t.b2b, bearer)).status,
      viewAnon: (await api().get(viewPath)).status,
    }).toEqual({
      secretProvider: 403,
      secretDriver: 403,
      secretB2b: 401,
      secretAnon: 401,
      viewProvider: 403,
      viewB2b: 401,
      viewAnon: 401,
    });
  });
});

const listEvents = (query: Record<string, string | number> = {}) =>
  api().get('/api/v1/admin/b2b-events').auth(t.sa, bearer).query(query);
const eventDetail = (eventId: string) =>
  api().get(`/api/v1/admin/b2b-events/${eventId}`).auth(t.sa, bearer);
const rescueEvent = (eventId: string) =>
  api()
    .post(`/api/v1/admin/b2b-events/${eventId}/rescue`)
    .auth(t.sa, bearer)
    .send({});
const eventIds = (body: { items: { eventId: string }[] }) =>
  body.items.map((i) => i.eventId);
/**
 * Earlier blocks leave handovers pending against receivers that no longer listen. Once their
 * backoff lapses they are due again, and a worker pass — which takes due work before it enrols a
 * new event — spends itself on them. Parking them keeps each case about its own event; it asserts
 * nothing and changes nothing these cases are about.
 */
const parkEarlierWork = () =>
  prisma.b2bWebhookDelivery.updateMany({
    where: { state: 'PENDING' },
    data: { nextAttemptAt: new Date(Date.now() + 3_600_000) },
  });
const freshBlock = async () => {
  receiver.reset();
  await parkEarlierWork();
  // The boundary is set to this instant: every event these cases create comes after it, and the
  // ones whose transport state an earlier case removed stay behind it. Reaching further back would
  // offer the worker an event that already has attempts, and enrolling it collides on the attempt
  // number and takes the whole pass down with it.
  await prisma.b2bWebhookEndpoint.updateMany({
    where: { integrationClientId: ids.b2bClient },
    data: { deliverFrom: new Date() },
  });
};

/**
 * Stops and resumes automatic delivery for the fixture client. Pausing is how these cases keep a
 * worker pass out of the way while they assert what an administrative action did by itself.
 */
const pauseEndpoint = () =>
  setEndpoint(ids.b2bClient, { url: receiver.url, enabled: false }).expect(200);
const resumeEndpoint = () =>
  setEndpoint(ids.b2bClient, { url: receiver.url, enabled: true }).expect(200);

/** Spends the whole schedule against a receiver that keeps failing. */
async function exhaust(eventId: string) {
  await waitForAttempts(eventId);
  for (let i = 0; i < 4; i += 1) {
    await makeDue(eventId);
    await worker().tick();
  }
  expect((await deliveryOf(eventId)).state).toBe('EXHAUSTED');
}

describe('V1.12-E answering «what happened with my order»', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(freshBlock);

  it('the reference the client already has is enough to find the event and read its transport', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const page = await listEvents({
      externalReference: dispatch.reference,
    }).expect(200);
    expect(page.body).toMatchObject({ total: 1, page: 1, totalPages: 1 });
    expect(page.body.items[0]).toMatchObject({
      eventId: event.id,
      // The public name of the fact, never the internal enum.
      type: 'delivery.completed',
      integrationClientId: ids.b2bClient,
      deliveryRequestPublicId: dispatch.requestPublicId,
      externalReference: dispatch.reference,
      transportState: 'DELIVERED',
      noDeliveryReason: null,
      attemptCount: 1,
      inFlight: false,
    });
    expect(page.body.items[0].deliveredAt).not.toBeNull();
    // The same order found by its Mandaria identifier, lowercase included.
    const byPublicId = await listEvents({
      deliveryRequestPublicId: dispatch.requestPublicId.toLowerCase(),
    }).expect(200);
    expect(eventIds(byPublicId.body)).toEqual([event.id]);
  }, 30000);

  it('the detail gathers the envelope, the frozen payload, the destination and every attempt', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    await makeDue(event.id);
    await worker().tick();
    const detail = (await eventDetail(event.id).expect(200)).body;
    expect(detail).toMatchObject({
      eventId: event.id,
      type: 'delivery.completed',
      transportState: 'PENDING',
      attemptCount: 2,
    });
    // The very snapshot V1.12-B froze, not a reconstruction.
    expect(detail.payload).toEqual(event.payload);
    expect(detail.endpoint).toMatchObject({
      url: receiver.url,
      enabled: true,
      secretConfigured: true,
    });
    expect(detail.attempts).toHaveLength(2);
    expect(
      detail.attempts.map((a: { attemptNumber: number }) => a.attemptNumber),
    ).toEqual([1, 2]);
    expect(detail.attempts[1]).toMatchObject({
      result: 'FAILED',
      httpStatus: 500,
      failureKind: 'HTTP_STATUS',
      endpointUrl: receiver.url,
    });
    receiver.always({ status: 200 });
  }, 30000);

  it('an event outside reliable delivery is NO_DELIVERY with a reason, and no reason is a fault', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // Reproduce a V1.12-B/C era event: the fact exists, its transport state does not.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.b2bWebhookDelivery.deleteMany({ where: { eventId: event.id } }),
    ]);
    await prisma.b2bWebhookEndpoint.update({
      where: { integrationClientId: ids.b2bClient },
      data: { deliverFrom: new Date(event.occurredAt.getTime() + 1000) },
    });
    const older = (await eventDetail(event.id).expect(200)).body;
    expect(older).toMatchObject({
      transportState: 'NO_DELIVERY',
      noDeliveryReason: 'BEFORE_BOUNDARY',
      attemptCount: 0,
      nextAttemptAt: null,
    });
    // The attempts it did make are history and are still there: NO_DELIVERY is about state.
    expect(older.attempts.length).toBeGreaterThan(0);
    // With no secret there is nothing to sign with, so the reason changes; the event does not.
    await prisma.b2bWebhookEndpoint.update({
      where: { integrationClientId: ids.b2bClient },
      data: { secretCiphertext: null, secretSetAt: null },
    });
    expect((await eventDetail(event.id).expect(200)).body.noDeliveryReason).toBe(
      'NO_ENDPOINT',
    );
    // And it is findable as such, which is how an operator sweeps for gaps.
    const swept = await listEvents({
      transportState: 'NO_DELIVERY',
      externalReference: dispatch.reference,
    }).expect(200);
    expect(eventIds(swept.body)).toEqual([event.id]);
    expect(await eventOf(dispatch.id)).toEqual(event);
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  }, 30000);

  it('filters and pages agree with each other, without repeating or skipping a row', async () => {
    receiver.always({ status: 200 });
    const references: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const dispatch = await deliveredByProvider();
      await waitForAttempts((await eventOf(dispatch.id)).id);
      references.push(dispatch.reference);
      await freeFixtureResources();
    }
    const all = await listEvents({
      integrationClientId: ids.b2bClient,
      pageSize: 100,
    }).expect(200);
    const ordered = eventIds(all.body);
    // Newest first, with the id as a stable tiebreak.
    const occurred = all.body.items.map(
      (i: { occurredAt: string }) => i.occurredAt,
    );
    expect([...occurred].sort().reverse()).toEqual(occurred);
    // Walked one row at a time, the pages reconstruct exactly the same list.
    const walked: string[] = [];
    for (let page = 1; page <= Math.min(all.body.total, 5); page += 1) {
      const step = await listEvents({
        integrationClientId: ids.b2bClient,
        page,
        pageSize: 1,
      }).expect(200);
      expect(step.body).toMatchObject({ total: all.body.total, pageSize: 1 });
      walked.push(step.body.items[0].eventId);
    }
    expect(walked).toEqual(ordered.slice(0, walked.length));
    expect(new Set(walked).size).toBe(walked.length);
    // A filter narrows that same list rather than producing a different one.
    for (const reference of references) {
      const one = await listEvents({ externalReference: reference }).expect(200);
      expect(one.body.total).toBe(1);
      expect(ordered).toContain(one.body.items[0].eventId);
    }
    // Another client's events are not this client's.
    const empty = await listEvents({
      integrationClientId: randomUUID(),
    }).expect(200);
    expect(empty.body).toMatchObject({ items: [], total: 0, totalPages: 0 });
    // A range that cannot contain anything is refused rather than silently answered with nothing.
    await listEvents({
      occurredFrom: new Date().toISOString(),
      occurredTo: new Date(Date.now() - 86_400_000).toISOString(),
    }).expect(400);
  }, 90000);
});

describe('V1.12-E acting on a handover that is stuck', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(freshBlock);

  it('a rescue queues work and says so; it never claims the event was delivered', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await exhaust(event.id);
    const before = await prisma.b2bWebhookDeliveryAttempt.count({
      where: { eventId: event.id },
    });
    // Paused, so the hint the rescue gives the worker cannot act on it: what is asserted here is
    // that the rescue itself schedules work and sends nothing.
    await pauseEndpoint();
    receiver.reset();
    const rescued = await rescueEvent(event.id).expect(200);
    expect(rescued.body).toEqual({ outcome: 'RESCHEDULED', eventId: event.id });
    const delivery = await deliveryOf(event.id);
    expect(delivery).toMatchObject({
      state: 'PENDING',
      // Nothing is erased and the counter does not go back: a rescue buys one more attempt.
      attemptCount: 5,
      exhaustedAt: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(delivery.nextAttemptAt).not.toBeNull();
    expect(
      await prisma.b2bWebhookDeliveryAttempt.count({
        where: { eventId: event.id },
      }),
    ).toBe(before);
    // The rescue attempted nothing itself; the worker is what picks it up.
    expect(receiver.received).toHaveLength(0);
    receiver.always({ status: 200 });
    await resumeEndpoint();
    await worker().tick();
    expect((await deliveryOf(event.id)).state).toBe('DELIVERED');
    expect(await eventOf(dispatch.id)).toEqual(event);
  }, 60000);

  it('a handover that fails again returns to EXHAUSTED and can be rescued once more', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await exhaust(event.id);
    await pauseEndpoint();
    await rescueEvent(event.id).expect(200);
    await resumeEndpoint();
    await worker().tick();
    expect(await deliveryOf(event.id)).toMatchObject({
      state: 'EXHAUSTED',
      attemptCount: 6,
    });
    // Out of attempts again, and rescuable again: the counter never goes backwards, so each
    // rescue buys exactly one more.
    await pauseEndpoint();
    expect((await rescueEvent(event.id).expect(200)).body.outcome).toBe(
      'RESCHEDULED',
    );
    await resumeEndpoint();
    receiver.always({ status: 200 });
  }, 60000);

  it('two simultaneous rescues do not queue the same work twice', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await exhaust(event.id);
    await pauseEndpoint();
    const [first, second] = await Promise.all([
      rescueEvent(event.id),
      rescueEvent(event.id),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect([first.body.outcome, second.body.outcome].sort()).toEqual([
      'ALREADY_PENDING',
      'RESCHEDULED',
    ]);
    expect((await deliveryOf(event.id)).attemptCount).toBe(5);
    await resumeEndpoint();
    receiver.always({ status: 200 });
  }, 60000);

  it('a rescue refuses what it has no business touching, and says which is which', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // Already handed over: what is being asked for is a redelivery, not a rescue.
    const delivered = await rescueEvent(event.id).expect(409);
    expect(delivered.body.code).toBe('WEBHOOK_ALREADY_DELIVERED');
    // Outside reliable delivery there is no queue to put it back into.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.b2bWebhookDelivery.deleteMany({ where: { eventId: event.id } }),
    ]);
    const untracked = await rescueEvent(event.id).expect(409);
    expect(untracked.body.code).toBe('WEBHOOK_DELIVERY_NOT_TRACKED');
    await rescueEvent(randomUUID()).expect(409);
  }, 30000);

  it('a manual redelivery reports what actually happened, not that the call returned 200', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    // It failed on the wire and there are attempts left: rescheduled, never «delivered».
    const retried = await deliverEvent(event.id).expect(200);
    expect(retried.body).toMatchObject({
      result: 'FAILED',
      state: 'PENDING',
      outcome: 'RESCHEDULED',
    });
    expect(retried.body.nextAttemptAt).toBeDefined();
    receiver.always({ status: 200 });
    const done = await deliverEvent(event.id).expect(200);
    expect(done.body).toMatchObject({
      result: 'SUCCEEDED',
      state: 'DELIVERED',
      outcome: 'DELIVERED',
    });
    const closed = await deliveryOf(event.id);
    // A redelivery of something already delivered is deliberate and audited, and moves nothing.
    const again = await deliverEvent(event.id).expect(200);
    expect(again.body).toMatchObject({
      state: 'DELIVERED',
      outcome: 'DELIVERED',
    });
    const after = await deliveryOf(event.id);
    expect(after.deliveredAt).toEqual(closed.deliveredAt);
    expect(after.state).toBe('DELIVERED');
  }, 30000);

  it('a manual redelivery with nowhere to send says SKIPPED instead of pretending', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: false,
    }).expect(200);
    const skipped = await deliverEvent(event.id).expect(200);
    expect(skipped.body).toEqual({
      kind: 'skipped',
      reason: 'ENDPOINT_DISABLED',
      outcome: 'SKIPPED',
    });
    await setEndpoint(ids.b2bClient, {
      url: receiver.url,
      enabled: true,
    }).expect(200);
  }, 30000);

  it('two simultaneous redeliveries never put the same event on the wire twice', async () => {
    // It fails once, so the handover is still pending and still owed — a delivered one cannot be
    // reopened, and nothing here tries to.
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    expect((await deliveryOf(event.id)).state).toBe('PENDING');
    receiver.reset();
    receiver.always({ status: 200, delayMs: 700 });
    const [first, second] = await Promise.all([
      deliverEvent(event.id),
      deliverEvent(event.id),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const refused = first.status === 409 ? first : second;
    expect(refused.body.code).toBe('WEBHOOK_DELIVERY_IN_PROGRESS');
    // Exactly one of them reached the client.
    expect(receiver.received).toHaveLength(1);
    receiver.always({ status: 200 });
  }, 30000);

  it('a redelivery while a worker holds the lease is refused rather than run alongside it', async () => {
    receiver.always({ status: 503 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    await prisma.b2bWebhookDelivery.update({
      where: { eventId: event.id },
      data: {
        leaseOwner: 'worker-holding-it',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    receiver.reset();
    const busy = await deliverEvent(event.id).expect(409);
    expect(busy.body.code).toBe('WEBHOOK_DELIVERY_IN_PROGRESS');
    expect(receiver.received).toHaveLength(0);
    // And the operational view explains the silence instead of leaving it unexplained.
    expect((await eventDetail(event.id).expect(200)).body.inFlight).toBe(true);
    await prisma.b2bWebhookDelivery.update({
      where: { eventId: event.id },
      data: { leaseOwner: null, leaseExpiresAt: null },
    });
    receiver.always({ status: 200 });
  }, 30000);
});

describe('V1.12-E the operational surface is administrative, and keeps its secrets', () => {
  withApp();
  beforeAll(async () => {
    await receiver.start();
    await configureEndpoint(ids.b2bClient, { url: receiver.url });
  });
  afterAll(async () => {
    await receiver.stop();
  });
  beforeEach(freshBlock);

  it('separates what the database knows from what only the answering instance knows', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const health = (
      await api()
        .get('/api/v1/admin/webhooks/health')
        .auth(t.sa, bearer)
        .expect(200)
    ).body;
    expect(health.pending).toBeGreaterThan(0);
    expect(health.oldestPendingDueAt).not.toBeNull();
    // Configuration and memory of this backend, not a claim about the fleet. The suite drives the
    // worker by hand, and health reports that honestly instead of a loop that is switched off.
    expect(health.thisInstance).toMatchObject({
      workerEnabled: false,
      pollSeconds: 0,
      leaseSeconds: 5,
    });
    expect(health.thisInstance.lastPollAt).not.toBeNull();
    const summary = (
      await api()
        .get(`/api/v1/admin/integrations/${ids.b2bClient}/webhook/summary`)
        .auth(t.sa, bearer)
        .expect(200)
    ).body;
    expect(summary.events).toBeGreaterThan(0);
    expect(summary.pending + summary.delivered + summary.exhausted).toBe(
      await prisma.b2bWebhookDelivery.count({
        where: { integrationClientId: ids.b2bClient },
      }),
    );
    receiver.always({ status: 200 });
  }, 30000);

  it('no secret reaches any of it, in any form', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const ciphertext = (
      await prisma.b2bWebhookEndpoint.findUniqueOrThrow({
        where: { integrationClientId: ids.b2bClient },
        select: { secretCiphertext: true },
      })
    ).secretCiphertext!;
    const bodies = JSON.stringify([
      (await listEvents({ externalReference: dispatch.reference }).expect(200))
        .body,
      (await eventDetail(event.id).expect(200)).body,
      (
        await api()
          .get('/api/v1/admin/webhooks/health')
          .auth(t.sa, bearer)
          .expect(200)
      ).body,
      (
        await api()
          .get(`/api/v1/admin/integrations/${ids.b2bClient}/webhook/summary`)
          .auth(t.sa, bearer)
          .expect(200)
      ).body,
    ]);
    expect(bodies).not.toContain(secrets[ids.b2bClient]);
    expect(bodies).not.toContain(ciphertext);
    expect(bodies).not.toContain('secretCiphertext');
    // What it does say is whether one exists, which is what an operator actually needs.
    expect((await eventDetail(event.id).expect(200)).body.endpoint).toMatchObject(
      { secretConfigured: true },
    );
  }, 30000);

  it('reading or acting on it requires SUPER_ADMIN', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    const list = '/api/v1/admin/b2b-events';
    const detail = `${list}/${event.id}`;
    const rescue = `${detail}/rescue`;
    const health = '/api/v1/admin/webhooks/health';
    expect({
      listProvider: (await api().get(list).auth(t.A, bearer)).status,
      listDriver: (await api().get(list).auth(t.ana, bearer)).status,
      // A B2B token is not a human session: it is not recognised on this surface at all.
      listB2b: (await api().get(list).auth(t.b2b, bearer)).status,
      listAnon: (await api().get(list)).status,
      detailProvider: (await api().get(detail).auth(t.A, bearer)).status,
      detailB2b: (await api().get(detail).auth(t.b2b, bearer)).status,
      rescueProvider: (await api().post(rescue).auth(t.A, bearer).send({}))
        .status,
      rescueDriver: (await api().post(rescue).auth(t.indy, bearer).send({}))
        .status,
      rescueAnon: (await api().post(rescue).send({})).status,
      healthProvider: (await api().get(health).auth(t.A, bearer)).status,
      healthAnon: (await api().get(health)).status,
    }).toEqual({
      listProvider: 403,
      listDriver: 403,
      listB2b: 401,
      listAnon: 401,
      detailProvider: 403,
      detailB2b: 401,
      rescueProvider: 403,
      rescueDriver: 403,
      rescueAnon: 401,
      healthProvider: 403,
      healthAnon: 401,
    });
    expect(await eventOf(dispatch.id)).toBeTruthy();
  }, 30000);

  it('reading the operational view changes nothing: not the event, not the credits', async () => {
    receiver.always({ status: 500 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    const beforeEvent = await eventOf(dispatch.id);
    const beforeEconomy = await economy();
    const beforeDispatch = await dispatchRow(dispatch.id);
    const beforeAttempts = await prisma.b2bWebhookDeliveryAttempt.count();
    const beforeDelivery = await deliveryOf(event.id);
    await listEvents({ externalReference: dispatch.reference }).expect(200);
    await eventDetail(event.id).expect(200);
    await api()
      .get('/api/v1/admin/webhooks/health')
      .auth(t.sa, bearer)
      .expect(200);
    await api()
      .get(`/api/v1/admin/integrations/${ids.b2bClient}/webhook/summary`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(await eventOf(dispatch.id)).toEqual(beforeEvent);
    expect(await economy()).toEqual(beforeEconomy);
    expect(await dispatchRow(dispatch.id)).toEqual(beforeDispatch);
    expect(await prisma.b2bWebhookDeliveryAttempt.count()).toBe(beforeAttempts);
    expect(await deliveryOf(event.id)).toEqual(beforeDelivery);
    receiver.always({ status: 200 });
  }, 30000);

  it('SQL cannot rewrite the outbox to make the operational view lie', async () => {
    receiver.always({ status: 200 });
    const dispatch = await deliveredByProvider();
    const event = await eventOf(dispatch.id);
    await waitForAttempts(event.id);
    for (const sql of [
      `UPDATE "B2bOutboxEvent" SET "occurredAt" = "occurredAt" - interval '1 day' WHERE "id" = '${event.id}'`,
      `UPDATE "B2bOutboxEvent" SET "payload" = '{}'::jsonb WHERE "id" = '${event.id}'`,
      `DELETE FROM "B2bOutboxEvent" WHERE "id" = '${event.id}'`,
      `UPDATE "B2bWebhookDeliveryAttempt" SET "result" = 'FAILED' WHERE "eventId" = '${event.id}'`,
    ])
      await expect(prisma.$executeRawUnsafe(sql)).rejects.toThrow();
    expect(await eventOf(dispatch.id)).toEqual(event);
    expect((await eventDetail(event.id).expect(200)).body.transportState).toBe(
      'DELIVERED',
    );
  }, 30000);
});
