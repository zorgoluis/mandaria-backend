import 'reflect-metadata';
import { createHash, randomBytes, randomUUID, randomInt } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ThrottlerGuard } from '@nestjs/throttler';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith('_test')
)
  throw Error('Local test database required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.PREQUOTE_ENABLED = 'true';
process.env.DISPATCH_SEARCH_POLL_SECONDS = '0';
process.env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS = '100000';
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';
for (const key of [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'INTEGRATION_JWT_SECRET',
])
  process.env[key] = randomBytes(48).toString('hex');
const p = new PrismaClient({ datasourceUrl: url });
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const clients = [randomUUID(), randomUUID()];
const credentials = [randomUUID(), randomUUID()];
const secrets = [
  randomBytes(32).toString('base64url'),
  randomBytes(32).toString('base64url'),
];
const lat = 40 + randomInt(0, 100000) / 10000;
const n = (offset: number) => Number((lat + offset).toFixed(6));
const body = {
  conditionsVersion: 1,
  serviceType: 'LOCAL_DELIVERY',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      latitude: n(0.000002),
      longitude: 75.000002,
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      latitude: n(0.000008),
      longitude: 75.000008,
    },
  ],
  packages: [{ category: 'FOOD', quantity: 1 }],
};
const key = () => `b2-${randomUUID()}`;
const route = () => ({
  distanceMeters: 1200,
  durationSeconds: 60,
  routingProvider: 'c3-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'c3-controlled',
  calculateRoute: vi.fn(async (...args: unknown[]) => {
    void args;
    return route();
  }),
};
const logs: string[] = [];
const capture = (...args: unknown[]) => {
  logs.push(JSON.stringify(args));
};
const logger = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};
let app: INestApplication;
let app2: INestApplication;
let config2: ConfigService;
let apiIndex = 0;
let config: ConfigService;
let zoneId: string;
let planId: string;

const tokens: string[] = [];
const api = () => request((apiIndex++ % 2 ? app2 : app).getHttpServer());
const post = (k = key(), b: object = body, t = tokens[0]) =>
  api()
    .post('/api/v1/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue(routing)
    .setLogger(logger)
    .compile();
  app = ref.createNestApplication({ logger, bodyParser: false });
  setup(app);
  await app.init();
  config = app.get(ConfigService);
  const ref2 = await Test.createTestingModule({ imports: [AppModule] })
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue(routing)
    .setLogger(logger)
    .compile();
  app2 = ref2.createNestApplication({ logger, bodyParser: false });
  setup(app2);
  await app2.init();
  config2 = app2.get(ConfigService);
  const limits = {
    minute: 1000,
    day: 100000,
    concurrent: 100,
    globalUnits: 100000,
    reserveMs: 1000,
    retries: 0,
    timeoutMs: 1000,
  };
  const keys = [
    'PREQUOTE_PER_MINUTE',
    'PREQUOTE_PER_DAY',
    'PREQUOTE_MAX_CONCURRENT',
    'PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS',
    'PREQUOTE_PERMIT_RESERVE_MS',
    'GOOGLE_ROUTES_MAX_RETRIES',
    'GOOGLE_ROUTES_TIMEOUT_MS',
  ];
  for (const cfg of [config, config2])
    Object.values(limits).forEach((v, i) => cfg.set(keys[i], v));
  await p.prequoteConsumptionPolicy.upsert({
    where: { id: 1 },
    create: {
      id: 1,
      fingerprint: createHash('sha256')
        .update(JSON.stringify(limits))
        .digest('hex'),
    },
    update: {
      fingerprint: createHash('sha256')
        .update(JSON.stringify(limits))
        .digest('hex'),
    },
  });

  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `SEARCH_${run}_${i}`,
      name: 'Search fixture',
    })),
  });
  await p.integrationCredential.createMany({
    data: credentials.map((id, i) => ({
      id,
      clientId: clients[i],
      secretHash: createHash('sha256').update(secrets[i]).digest('hex'),
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
    })),
  });
  for (let i = 0; i < 2; i++) {
    const res = await api()
      .post('/api/v1/integrations/token')
      .send({ clientId: credentials[i], clientSecret: secrets[i] })
      .expect(200);
    tokens.push(res.body.accessToken);
  }
  await ensureTestCreditPolicies(p);
  const zone = await p.serviceZone.create({
    data: {
      code: `SEARCH_${run}`,
      name: 'B2 zone',
      status: 'ACTIVE',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [75, lat],
            [75.00001, lat],
            [75.00001, n(0.00001)],
            [75, n(0.00001)],
            [75, lat],
          ],
        ],
      },
      minLatitude: lat,
      maxLatitude: n(0.00001),
      minLongitude: 75,
      maxLongitude: 75.00001,
    },
  });
  zoneId = zone.id;
  const plan = await p.ratePlan.create({
    data: {
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      status: 'DRAFT',
      quoteValidityMinutes: 2,
      currency: 'MXN',
      bands: {
        create: {
          minDistanceMeters: 0,
          maxDistanceMeters: 10000,
          amount: '25.10',
          currency: 'MXN',
        },
      },
    },
  });
  planId = plan.id;
  await p.ratePlan.update({
    where: { id: planId },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
}, 30000);
function setConfig(k: string, v: unknown) {
  config.set(k, v);
  config2.set(k, v);
}
beforeEach(async () => {
  vi.useRealTimers();
  await p.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION dispatch_search_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() AT TIME ZONE 'UTC' $$`,
  );
  await p.integrationClient.update({
    where: { id: clients[0] },
    data: { automaticDispatchSearch: true, status: 'ACTIVE' },
  });
  setConfig('AUTOMATIC_DISPATCH_SEARCH_ENABLED', true);
  vi.restoreAllMocks();
  routing.calculateRoute.mockReset().mockImplementation(async () => route());
  setConfig('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', true);
  setConfig('PREQUOTE_CONVERSION_ENABLED', true);
  setConfig('PREQUOTE_ENABLED', true);
  setConfig('PREQUOTE_VALIDITY_MS', 900000);
});
afterAll(async () => {
  vi.useRealTimers();
  await p.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION dispatch_search_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT clock_timestamp() AT TIME ZONE 'UTC' $$`,
  );
  if (zoneId)
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  await p.integrationCredential.updateMany({
    where: { id: { in: credentials } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await app?.close();
  await app2?.close();
  await p.$disconnect();
});
const conversionBody = () => ({
  conditionsVersion: 1,
  deliveryRequest: {
    serviceType: 'LOCAL_DELIVERY',
    externalReference: 'b2-order',
    stops: body.stops.map((s) => ({
      ...s,
      address: 'Synthetic location',
      contactName: 'Fixture',
      contactPhone: '0000000000',
    })),
    packages: [{ category: 'FOOD', description: 'Food package', quantity: 1 }],
    financialContext: {
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
      goodsValue: '150.00',
    },
  },
  merchantConfirmation: {
    goodsPaymentStatus: 'CONFIRMED_BY_MERCHANT',
    goodsPaymentReference: 'receipt-demo',
    goodsPaymentConfirmedAt: '2026-01-01T00:00:00.000Z',
    orderAcceptanceStatus: 'ACCEPTED_BY_MERCHANT',
    orderAcceptanceReference: 'order-demo',
    orderAcceptedAt: '2026-01-01T00:00:00.000Z',
  },
  deliveryCollectionInstruction: {
    payer: 'RECIPIENT',
    method: 'CASH',
    dueAt: 'DELIVERY',
    components: ['DELIVERY_FEE'],
  },
});
const convert = (
  id: string,
  k = key(),
  b: object = conversionBody(),
  t = tokens[0],
) =>
  api()
    .post(`/api/v1/delivery-prequotes/${id}/convert`)
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
async function emit() {
  const r = await post();
  expect(r.status).toBe(201);
  return r.body.publicId as string;
}
async function converted() {
  const id = await emit();
  const k = key();
  const r = await convert(id, k);
  expect(r.status).toBe(201);
  const c = await p.prequoteConversion.findFirstOrThrow({
    where: { prequote: { publicId: id } },
    include: {
      prequote: true,
      deliveryQuote: true,
      deliveryRequest: {
        include: { stops: true, packages: true, financialContext: true },
      },
    },
  });
  return { id, k, r, c };
}
const attestation = (q: {
  publicId: string;
  amount: string;
  currency: string;
  expiresAt: string;
}) => ({
  customerAuthorization: {
    version: 1,
    status: 'AUTHORIZED_BY_CUSTOMER',
    reference: 'private-consent-fixture',
    authorizedAt: new Date().toISOString(),
    quotePublicId: q.publicId,
    amount: q.amount,
    currency: q.currency,
    expiresAt: q.expiresAt,
  },
});
const accept = (id: string, b: object, k = key(), t = tokens[0]) =>
  api()
    .post(`/api/v1/delivery-quotes/${id}/accept`)
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
const cancel = (id: string) =>
  api()
    .post(`/api/v1/delivery-requests/${id}/cancel`)
    .auth(tokens[0], { type: 'bearer' })
    .send({ reason: 'Expired quote recovery' });
const status = (id: string) =>
  api()
    .get(`/api/v1/delivery-requests/${id}/status`)
    .auth(tokens[0], { type: 'bearer' });

async function opened() {
  const item = await converted();
  const authorization = attestation(item.r.body.quote),
    acceptKey = key();
  await accept(item.r.body.quote.publicId, authorization, acceptKey).expect(
    200,
  );
  const d = await p.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: item.c.deliveryQuoteId },
    include: { creditSnapshots: true },
  });
  return { ...item, d, authorization, acceptKey };
}
async function expire(d: { expiresAt: Date }, delay = 1) {
  const time = new Date(d.expiresAt.getTime() + delay);
  // Isolated test database only; replace the clock, never disable business guards.
  await p.$executeRawUnsafe(
    `CREATE OR REPLACE FUNCTION dispatch_search_now() RETURNS timestamp(3) LANGUAGE sql VOLATILE AS $$ SELECT TIMESTAMP '${time.toISOString().replace('T', ' ').replace('Z', '')}' $$`,
  );
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(time);
}
async function workers() {
  const { DispatchSearchWorker } =
    await import('../dist/dispatch/dispatch-search.worker.js');
  return [app.get(DispatchSearchWorker), app2.get(DispatchSearchWorker)];
}
async function current(id: string) {
  return p.dispatch.findUniqueOrThrow({ where: { id } });
}
async function provider() {
  const row = await p.deliveryProvider.create({
    data: {
      name: 'Search provider',
      code: `SEARCH_${randomUUID()}`,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 2,
      maxVehicles: 2,
    },
  });
  await p.providerServiceCoverage.create({
    data: {
      providerId: row.id,
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
    },
  });
  return row;
}
async function claim(
  d: Awaited<ReturnType<typeof opened>>['d'],
  providerId: string,
  prepareOnly = false,
) {
  const { fundProvider } = await import('./support/credits.js');
  const { DispatchService } =
    await import('../dist/dispatch/dispatch.service.js');
  const { hash } = await import('argon2');
  const actor = await p.user.create({
    data: {
      email: `${randomUUID()}@fixture.test`,
      role: 'PROVIDER_ADMIN',
      active: true,
      passwordHash: await hash(randomBytes(24).toString('hex')),
    },
  });
  await fundProvider(
    p,
    providerId,
    d.creditSnapshots.find((s) => s.actorType === 'PROVIDER')!.credits,
  );
  if (!prepareOnly)
    await app.get(DispatchService).claim(d.id, providerId, actor.id);
  return actor;
}
describe('Automatic dispatch search, real database and two applications', () => {
  it('five durable windows, pending never EXPIRED, exact financial identity and exhausted terminal', async () => {
    const x = await opened();
    const [a, b] = await workers();
    const snapshots = x.d.creditSnapshots;
    const evidence = await p.authorizedQuoteAcceptance.findUniqueOrThrow({
      where: { dispatchId: x.d.id },
    });
    expect(x.d.searchMaxAttempts).toBe(5);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const d = await current(x.d.id);
      expect(d.searchAttempt).toBe(attempt);
      await expire(d);
      const before = await status(x.c.deliveryRequest.publicId).expect(200);
      expect(before.body.status).toBe(attempt < 5 ? 'OPEN' : 'EXPIRED');
      expect(before.body.search.state).toBe(
        attempt < 5 ? 'RETRY_PENDING' : 'EXHAUSTED',
      );
      await Promise.all([
        a.advance(d.id, d.deliveryRequestId),
        b.advance(d.id, d.deliveryRequestId),
      ]);
      const { DispatchSearchWorker } =
        await import('../dist/dispatch/dispatch-search.worker.js');
      const restarted = new DispatchSearchWorker(p as never, config);
      await restarted.advance(d.id, d.deliveryRequestId);
    }
    const end = await current(x.d.id);
    expect(end.status).toBe('EXPIRED');
    expect(end.searchAttempt).toBe(5);
    expect(
      await p.creditLedgerEntry.count({
        where: { referenceType: 'DISPATCH', referenceId: end.id },
      }),
    ).toBe(0);
    expect(
      await p.authorizedQuoteAcceptance.findUniqueOrThrow({
        where: { dispatchId: end.id },
      }),
    ).toEqual(evidence);
    expect(
      await p.dispatchSearchRound.count({ where: { dispatchId: end.id } }),
    ).toBe(5);
    expect(
      await p.dispatch.count({
        where: { deliveryRequestId: end.deliveryRequestId },
      }),
    ).toBe(1);
    expect(
      await p.dispatchCreditSnapshot.findMany({
        where: { dispatchId: end.id },
        orderBy: { id: 'asc' },
      }),
    ).toEqual([...snapshots].sort((a, b) => a.id.localeCompare(b.id)));
    const quote = await p.deliveryQuote.findUniqueOrThrow({
      where: { id: end.deliveryQuoteId },
    });
    expect(quote.amount.toString()).toBe(x.c.deliveryQuote.amount.toString());
    expect(quote.expiresAt).toEqual(x.c.deliveryQuote.expiresAt);
    await accept(x.r.body.quote.publicId, x.authorization, x.acceptKey).expect(
      200,
    );
    expect((await current(end.id)).status).toBe('EXPIRED');
  });
  it('delayed worker opens one full window now, not catch-up windows; recaptures providers', async () => {
    const x = await opened();
    const newcomer = await provider();
    await expire(x.d, 3600000);
    const [a] = await workers();
    await a.advance(x.d.id, x.d.deliveryRequestId);
    const d = await current(x.d.id);
    expect(d.searchAttempt).toBe(2);
    expect(d.expiresAt.getTime() - Date.now()).toBe(600000);
    expect(
      await p.dispatchCandidate.findUnique({
        where: {
          dispatchId_providerId: { dispatchId: d.id, providerId: newcomer.id },
        },
      }),
    ).not.toBeNull();
    const round = await p.dispatchSearchRound.findUniqueOrThrow({
      where: { dispatchId_attempt: { dispatchId: d.id, attempt: 2 } },
    });
    expect(round.providerIds).toContain(newcomer.id);
  });
  it('cancellation while pending stops forever and retains round history', async () => {
    const x = await opened();
    await expire(x.d);
    await cancel(x.c.deliveryRequest.publicId).expect(200);
    const [a, b] = await workers();
    await Promise.all([a.runOnce(), b.runOnce()]);
    const d = await current(x.d.id);
    expect(d.searchAttempt).toBe(1);
    expect(d.searchStoppedReason).toBe('REQUEST_CANCELLED');
    expect((await status(x.c.deliveryRequest.publicId)).body.search.state).toBe(
      'CANCELLED',
    );
  });
  it.each([1, 2, 3, 4, 5])(
    'claim at round %i stops retries permanently, including after release',
    async (round) => {
      const owner = await provider();
      const x = await opened();
      const [a, b] = await workers();
      for (let i = 1; i < round; i++) {
        await expire(await current(x.d.id));
        await a.advance(x.d.id, x.d.deliveryRequestId);
      }
      const actor = await claim(x.d, owner.id);
      expect((await current(x.d.id)).searchStoppedReason).toBe(
        'EXECUTOR_FOUND',
      );
      const { DispatchService } =
        await import('../dist/dispatch/dispatch.service.js');
      await app
        .get(DispatchService)
        .release(x.d.id, owner.id, 'Fixture release', actor.id);
      await expire(await current(x.d.id));
      await Promise.all([a.runOnce(), b.runOnce()]);
      expect((await current(x.d.id)).searchAttempt).toBe(round);
    },
  );
  it('flag or integration opt-out keeps one window; changing opt-in does not change running policy', async () => {
    setConfig('AUTOMATIC_DISPATCH_SEARCH_ENABLED', false);
    const legacy = await opened();
    expect(legacy.d.searchMaxAttempts).toBe(1);
    expect(
      (await status(legacy.c.deliveryRequest.publicId)).body.search,
    ).toBeUndefined();
    setConfig('AUTOMATIC_DISPATCH_SEARCH_ENABLED', true);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { automaticDispatchSearch: false },
    });
    expect((await opened()).d.searchMaxAttempts).toBe(1);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { automaticDispatchSearch: true },
    });
    const x = await opened();
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { automaticDispatchSearch: false },
    });
    setConfig('AUTOMATIC_DISPATCH_SEARCH_ENABLED', false);
    await expire(x.d);
    await (await workers())[0].advance(x.d.id, x.d.deliveryRequestId);
    expect((await current(x.d.id)).searchAttempt).toBe(2);
  });
  it('unavailable zone stops with explicit reason and no new window', async () => {
    const x = await opened();
    await expire(x.d);
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
    try {
      await (await workers())[0].advance(x.d.id, x.d.deliveryRequestId);
      expect((await current(x.d.id)).searchStoppedReason).toBe(
        'SERVICE_UNAVAILABLE',
      );
    } finally {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { status: 'ACTIVE' },
      });
    }
  });
  it('SQL rejects premature retry, mutable policy, changed window and rewritten history', async () => {
    const x = await opened();
    await expect(
      p.dispatch.update({ where: { id: x.d.id }, data: { searchAttempt: 2 } }),
    ).rejects.toThrow('DISPATCH_SEARCH_RETRY_INVALID');
    await expect(
      p.dispatch.update({
        where: { id: x.d.id },
        data: { searchMaxAttempts: 1 },
      }),
    ).rejects.toThrow('DISPATCH_SEARCH_POLICY_IMMUTABLE');
    await expect(
      p.dispatch.update({
        where: { id: x.d.id },
        data: { expiresAt: new Date(x.d.expiresAt.getTime() + 1000) },
      }),
    ).rejects.toThrow('DISPATCH_SEARCH_WINDOW_IMMUTABLE');
    await expect(
      p.dispatchSearchRound.delete({
        where: { dispatchId_attempt: { dispatchId: x.d.id, attempt: 1 } },
      }),
    ).rejects.toThrow('DISPATCH_SEARCH_HISTORY_IMMUTABLE');
  });
  it('technical failure rolls back round and window; a retry consumes exactly one attempt', async () => {
    const x = await opened();
    const newcomer = await provider();
    await expire(x.d);
    const [a] = await workers();
    await p.$executeRawUnsafe(
      `CREATE FUNCTION search_fixture_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."providerId"='${newcomer.id}'::uuid THEN RAISE EXCEPTION 'SEARCH_FIXTURE_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await p.$executeRawUnsafe(
      'CREATE TRIGGER search_fixture_failure BEFORE INSERT ON "DispatchCandidate" FOR EACH ROW EXECUTE FUNCTION search_fixture_failure()',
    );
    try {
      await expect(a.advance(x.d.id, x.d.deliveryRequestId)).rejects.toThrow(
        'SEARCH_FIXTURE_FAILURE',
      );
      expect((await current(x.d.id)).searchAttempt).toBe(1);
      expect((await current(x.d.id)).expiresAt).toEqual(x.d.expiresAt);
      expect(
        await p.dispatchSearchRound.count({ where: { dispatchId: x.d.id } }),
      ).toBe(1);
    } finally {
      await p.$executeRawUnsafe(
        'DROP TRIGGER search_fixture_failure ON "DispatchCandidate"',
      );
      await p.$executeRawUnsafe('DROP FUNCTION search_fixture_failure()');
    }
    await a.advance(x.d.id, x.d.deliveryRequestId);
    expect((await current(x.d.id)).searchAttempt).toBe(2);
  });
  it('claim races a retry under real row locks: no lost claim, duplicate round or debit', async () => {
    const owner = await provider();
    const x = await opened();
    const actor = await claim(x.d, owner.id, true);
    await expire(x.d);
    const [a, b] = await workers();
    const { DispatchService } =
      await import('../dist/dispatch/dispatch.service.js');
    const service = app.get(DispatchService);
    const outcomes = await Promise.allSettled([
      service.claim(x.d.id, owner.id, actor.id),
      a.advance(x.d.id, x.d.deliveryRequestId),
      b.advance(x.d.id, x.d.deliveryRequestId),
    ]);
    expect(outcomes.slice(1).every((r) => r.status === 'fulfilled')).toBe(true);
    if (outcomes[0].status === 'rejected')
      expect(outcomes[0].reason).toMatchObject({
        code: 'DISPATCH_RETRY_PENDING',
      });
    await service.claim(x.d.id, owner.id, actor.id);
    await service.claim(x.d.id, owner.id, actor.id);
    expect((await current(x.d.id)).searchAttempt).toBe(2);
    expect((await current(x.d.id)).status).toBe('CLAIMED');
    expect(
      await p.creditLedgerEntry.count({
        where: {
          referenceType: 'DISPATCH',
          referenceId: x.d.id,
          type: 'SERVICE_AWARD',
        },
      }),
    ).toBe(1);
    await expire(await current(x.d.id));
    await b.runOnce();
    expect((await current(x.d.id)).searchAttempt).toBe(2);
  });
  it('cancel races renewal: terminal request, no subsequent round', async () => {
    const x = await opened();
    await expire(x.d);
    const [a, b] = await workers();
    const [response] = await Promise.all([
      cancel(x.c.deliveryRequest.publicId),
      a.advance(x.d.id, x.d.deliveryRequestId),
      b.advance(x.d.id, x.d.deliveryRequestId),
    ]);
    expect(response.status).toBe(200);
    const terminal = await current(x.d.id);
    expect(terminal.searchStoppedReason).toBe('REQUEST_CANCELLED');
    expect([1, 2]).toContain(terminal.searchAttempt);
    await expire(terminal);
    await a.runOnce();
    expect((await current(x.d.id)).searchAttempt).toBe(terminal.searchAttempt);
    expect(
      await p.creditLedgerEntry.count({
        where: { referenceType: 'DISPATCH', referenceId: x.d.id },
      }),
    ).toBe(0);
  });
  it('integration policy requires human SUPER_ADMIN and a boolean; public profile exposes opt-in', async () => {
    const path =
      '/api/v1/admin/integrations/' + clients[0] + '/dispatch-search-policy';
    await api()
      .patch(path)
      .send({ automaticDispatchSearch: false })
      .expect(401);
    for (const role of ['PROVIDER_ADMIN', 'SUPER_ADMIN'] as const) {
      const { hash } = await import('argon2');
      const user = await p.user.create({
        data: {
          email: randomUUID() + '@fixture.test',
          role,
          active: true,
          passwordHash: await hash(randomBytes(24).toString('hex')),
        },
      });
      const token = await app.get(JwtService).signAsync(
        { sub: user.id, type: 'access' },
        {
          secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
          issuer: 'mandaria',
          audience: 'mandaria-users',
          algorithm: 'HS256',
          expiresIn: 3600,
        },
      );
      if (role === 'PROVIDER_ADMIN')
        await api()
          .patch(path)
          .auth(token, { type: 'bearer' })
          .send({ automaticDispatchSearch: false })
          .expect(403);
      else {
        await api()
          .patch(path)
          .auth(token, { type: 'bearer' })
          .send({ automaticDispatchSearch: 'false' })
          .expect(400);
        const response = await api()
          .patch(path)
          .auth(token, { type: 'bearer' })
          .send({ automaticDispatchSearch: false })
          .expect(200);
        expect(response.body.automaticDispatchSearch).toBe(false);
      }
    }
    const response = await api()
      .get('/api/v1/integrations/me')
      .auth(tokens[0], { type: 'bearer' })
      .expect(200);
    expect(response.body.automaticDispatchSearch).toBe(false);
  });
  it('expired claim cannot persist terminal expiration before worker retries', async () => {
    const owner = await provider();
    const x = await opened();
    await expire(x.d);
    const { DispatchService } =
      await import('../dist/dispatch/dispatch.service.js');
    await expect(
      app.get(DispatchService).claim(x.d.id, owner.id, randomUUID()),
    ).rejects.toMatchObject({ code: 'DISPATCH_RETRY_PENDING' });
    expect((await current(x.d.id)).status).toBe('OPEN');
  });
});
