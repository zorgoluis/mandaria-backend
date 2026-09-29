import 'reflect-metadata';
import { hash } from 'argon2';
import { randomBytes, randomUUID, createHash, randomInt } from 'node:crypto';
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { DurablePrequoteConsumption } from '../src/delivery-prequotes/durable-prequote-consumption.js';
import { writeFileSync } from 'node:fs';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import { fundProvider } from './support/credits.js';
const url = process.env.TEST_DATABASE_URL;
if (
  !url ||
  !['localhost', '127.0.0.1'].includes(new URL(url).hostname) ||
  !new URL(url).pathname.endsWith('_test')
)
  throw Error('Local test DB required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.PREQUOTE_ENABLED = 'true';
process.env.PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS = '1000000';
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';
for (const key of [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'INTEGRATION_JWT_SECRET',
])
  process.env[key] = randomBytes(48).toString('hex');
const p = new PrismaClient({ datasourceUrl: url });
const apps: INestApplication[] = [];
const services: DurablePrequoteConsumption[] = [];
const configs: ConfigService[] = [];
const route = () => ({
  distanceMeters: 1200,
  durationSeconds: 60,
  routingProvider: 'a6-controlled',
  calculatedAt: new Date(),
});
const routings = [
  { name: 'a6-control-a', calculateRoute: vi.fn(async () => route()) },
  { name: 'a6-control-b', calculateRoute: vi.fn(async () => route()) },
];
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
const defaults = {
  minute: 1000,
  day: 100000,
  concurrent: 100,
  globalUnits: 1000000,
  reserveMs: 1000,
  retries: 0,
  timeoutMs: 1000,
};
let limits = { ...defaults };
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const clients = [randomUUID(), randomUUID()];
const credentials = [randomUUID(), randomUUID()];
const tokens: string[] = [];
const lat = 25 + randomInt(0, 100000) / 10000;
const n = (v: number) => Number((lat + v).toFixed(6));
const body = {
  conditionsVersion: 1,
  serviceType: 'LOCAL_DELIVERY',
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      latitude: n(0.000002),
      longitude: 80.000002,
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      latitude: n(0.000008),
      longitude: 80.000008,
    },
  ],
  packages: [{ category: 'FOOD', quantity: 1 }],
};
let zoneId: string;
let baseline: number[];
let preserved: Record<string, { count: number; hash: string }>;
let config: ConfigService;
let planId: string;
const routing = routings[0];
const secrets = [
  randomBytes(32).toString('base64url'),
  randomBytes(32).toString('base64url'),
];
const scopes = [
  'prequotes:create',
  'prequotes:read',
  'deliveries:create',
  'quotes:create',
  'quotes:accept',
];
const counts = () =>
  Promise.all([
    p.deliveryRequest.count(),
    p.deliveryQuote.count(),
    p.dispatch.count(),
    p.creditLedgerEntry.count(),
    p.deliveryAssignment.count(),
  ]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `a6-${randomUUID()}`;
const rows = (id: string) =>
  p.prequoteConsumptionPermit.findMany({
    where: { integrationClientId: id },
    orderBy: { reservedAt: 'asc' },
  });
async function client() {
  return (
    await p.integrationClient.create({
      data: {
        code: `A6_${randomUUID().replaceAll('-', '')}`,
        name: 'A6 fixture',
      },
    })
  ).id;
}
async function admit(i: number, id: string) {
  const r = await services[i].admit(id);
  expect(r.admitted).toBe(true);
  if (!r.admitted) throw Error('Admission denied');
  return r.permit;
}
async function configure(overrides: Partial<typeof defaults> = {}) {
  limits = { ...defaults, ...overrides };
  const keys = {
    minute: 'PREQUOTE_PER_MINUTE',
    day: 'PREQUOTE_PER_DAY',
    concurrent: 'PREQUOTE_MAX_CONCURRENT',
    globalUnits: 'PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS',
    reserveMs: 'PREQUOTE_PERMIT_RESERVE_MS',
    retries: 'GOOGLE_ROUTES_MAX_RETRIES',
    timeoutMs: 'GOOGLE_ROUTES_TIMEOUT_MS',
  };
  for (const config of configs) {
    config.set('PREQUOTE_ENABLED', true);
    for (const [k, v] of Object.entries(limits))
      config.set(keys[k as keyof typeof keys], v);
  }
  // Test-only coordinated policy replacement; no usage rows/counters are reset or deleted.
  await p.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
    await tx.prequoteConsumptionPolicy.upsert({
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
  });
}
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const { PREQUOTE_CONSUMPTION } =
    await import('../dist/delivery-prequotes/prequote-consumption.js');
  for (let i = 0; i < 2; i++) {
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routings[i])
      .setLogger(logger)
      .compile();
    const app = ref.createNestApplication({ logger, bodyParser: false });
    setup(app);
    await app.init();
    apps.push(app);
    services.push(app.get(PREQUOTE_CONSUMPTION));
    configs.push(app.get(ConfigService));
  }
  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `A6_${run}_${i}`,
      name: 'A6 HTTP fixture',
    })),
  });
  const hashes = secrets.map((s) =>
    createHash('sha256').update(s).digest('hex'),
  );
  await p.integrationCredential.createMany({
    data: credentials.map((id, i) => ({
      id,
      clientId: clients[i],
      secretHash: hashes[i],
      scopes,
    })),
  });
  for (let i = 0; i < 2; i++) {
    const response = await request(apps[i].getHttpServer())
      .post('/api/v1/integrations/token')
      .send({ clientId: credentials[i], clientSecret: secrets[i] })
      .expect(200);
    tokens.push(response.body.accessToken);
  }
  config = configs[0];
  const z = await p.serviceZone.create({
    data: {
      code: `A6_${run}`,
      name: 'A6 zone',
      status: 'ACTIVE',
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [80, lat],
            [80.00001, lat],
            [80.00001, n(0.00001)],
            [80, n(0.00001)],
            [80, lat],
          ],
        ],
      },
      minLatitude: lat,
      maxLatitude: n(0.00001),
      minLongitude: 80,
      maxLongitude: 80.00001,
    },
  });
  zoneId = z.id;
  const plan = await p.ratePlan.create({
    data: {
      serviceZoneId: z.id,
      serviceType: 'LOCAL_DELIVERY',
      version: 1,
      status: 'DRAFT',
      quoteValidityMinutes: 15,
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
  await p.ratePlan.update({
    where: { id: plan.id },
    data: { status: 'ACTIVE', activatedAt: new Date() },
  });
  planId = plan.id;
  await ensureTestCreditPolicies(p);
  const legacyBody = {
    serviceType: 'LOCAL_DELIVERY',
    stops: body.stops.map((x) => ({
      ...x,
      address: 'Synthetic A6',
      contactName: 'Fixture',
      contactPhone: '0000000000',
    })),
    packages: [{ category: 'FOOD', quantity: 1, description: 'Synthetic' }],
    financialContext: {
      goodsPaymentMode: 'PREPAID',
      goodsValue: '450.00',
      currency: 'MXN',
    },
  };
  const req = await request(apps[0].getHttpServer())
    .post('/api/v1/delivery-requests')
    .auth(tokens[0], { type: 'bearer' })
    .set('Idempotency-Key', key())
    .send(legacyBody)
    .expect(201);
  const quote = await request(apps[0].getHttpServer())
    .post('/api/v1/delivery-requests/' + req.body.publicId + '/quotes')
    .auth(tokens[0], { type: 'bearer' })
    .send({})
    .expect(201);
  await request(apps[0].getHttpServer())
    .post('/api/v1/delivery-quotes/' + quote.body.publicId + '/accept')
    .auth(tokens[0], { type: 'bearer' })
    .send({})
    .expect(200);
  const provider = await p.deliveryProvider.create({
    data: {
      name: 'A6 preservation',
      code: 'A6_' + run,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 1,
      maxVehicles: 1,
    },
  });
  await p.providerServiceCoverage.create({
    data: {
      providerId: provider.id,
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
    },
  });
  await fundProvider(p, provider.id, 20);
  const user = await p.user.create({
    data: {
      email: 'a6-driver-' + run + '@fixture.test',
      role: 'DRIVER',
      active: true,
      passwordHash: await hash(randomBytes(32).toString('hex')),
    },
  });
  const driver = await p.driver.create({
    data: {
      providerId: provider.id,
      userId: user.id,
      name: 'Synthetic',
      status: 'ACTIVE',
      availability: 'AVAILABLE',
    },
  });
  const vehicle = await p.vehicle.create({
    data: {
      providerId: provider.id,
      identifier: 'A6-' + run,
      type: 'MOTORCYCLE',
    },
  });
  const q = await p.deliveryQuote.findUniqueOrThrow({
    where: { publicId: quote.body.publicId },
  });
  const dispatch = await p.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: q.id },
  });
  await p.dispatchCandidate.create({
    data: {
      dispatchId: dispatch.id,
      providerId: provider.id,
      offeredAt: new Date(),
    },
  });
  const { DispatchService } =
    await import('../dist/dispatch/dispatch.service.js');
  const { DeliveryAssignmentsService } =
    await import('../dist/delivery-assignments/delivery-assignments.service.js');
  await apps[0].get(DispatchService).claim(dispatch.id, provider.id, user.id);
  await apps[0]
    .get(DeliveryAssignmentsService)
    .create(
      dispatch.id,
      { driverId: driver.id, vehicleId: vehicle.id },
      { providerId: provider.id, userId: user.id },
    );
  await apps[0]
    .get(DispatchService)
    .complete(dispatch.id, provider.id, user.id);
  baseline = await counts();
  preserved = await digest();
  for (const name of [
    'DeliveryRequest',
    'DeliveryQuote',
    'Dispatch',
    'CreditAccount',
    'CreditLedgerEntry',
    'B2bOutboxEvent',
  ])
    expect(preserved[name].count).toBeGreaterThan(0);
}, 30000);
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const r of routings)
    r.calculateRoute.mockReset().mockImplementation(async () => route());
  await configure();
  config.set('PREQUOTE_VALIDITY_MS', 900000);
});
afterAll(async () => {
  if (zoneId)
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  await p.integrationCredential.updateMany({
    where: { id: { in: credentials } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  for (const app of apps) await app.close();
  await p.$disconnect();
});

const post = (
  k = key(),
  data: unknown = body,
  token = tokens[0],
  instance = 0,
) =>
  request(apps[instance].getHttpServer())
    .post('/api/v1/delivery-prequotes')
    .auth(token, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(data);
const api = () => request(apps[0].getHttpServer());
const get = (id: string, token = tokens[0]) =>
  api()
    .get('/api/v1/delivery-prequotes/' + id)
    .auth(token, { type: 'bearer' });
const execution = (k: string) =>
  p.apiIdempotencyRecord.findUnique({
    where: {
      integrationClientId_key: { integrationClientId: clients[0], key: k },
    },
    include: { execution: true },
  });
async function sign(
  i: number,
  scopes = ['prequotes:create', 'prequotes:read'],
) {
  return new JwtService().signAsync(
    {
      sub: clients[i],
      credentialId: credentials[i],
      principalType: 'integration',
      type: 'integration_access',
      scopes,
    },
    {
      secret: process.env.INTEGRATION_JWT_SECRET,
      expiresIn: 3600,
      issuer: 'mandaria',
      audience: 'mandaria-integrations',
      algorithm: 'HS256',
    },
  );
}
async function digest() {
  const output: Record<string, { count: number; hash: string }> = {};
  for (const table of [
    'DeliveryRequest',
    'DeliveryQuote',
    'DeliveryStop',
    'DeliveryPackage',
    'DeliveryFinancialContext',
    'Dispatch',
    'DeliveryAssignment',
    'CreditAccount',
    'CreditLedgerEntry',
    'B2bOutboxEvent',
  ]) {
    const [r] = await p.$queryRawUnsafe<{ rows: unknown[] }[]>(
      `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]'::jsonb) AS rows FROM "${table}" t`,
    );
    output[table] = {
      count: r.rows.length,
      hash: createHash('sha256').update(JSON.stringify(r.rows)).digest('hex'),
    };
  }
  return output;
}
describe.sequential(
  'CHECK A6 integral with real auth, persistence, idempotency and consumption',
  () => {
    it('exhausted global MPQ budget does not restrict a new legacy Quote', async () => {
      const id = await client();
      const permit = await admit(0, id);
      await permit.start();
      await permit.finish({ routingStarted: false, published: false });
      await configure({ globalUnits: 1 });
      const before = await digest();
      await post().expect(429);
      expect(await digest()).toEqual(before);
      const permits = await p.prequoteConsumptionPermit.count();
      const legacy = {
        serviceType: 'LOCAL_DELIVERY',
        stops: body.stops.map((x) => ({
          ...x,
          address: 'Synthetic A6',
          contactName: 'Fixture',
          contactPhone: '0000000000',
        })),
        packages: [{ category: 'FOOD', quantity: 1, description: 'Synthetic' }],
        financialContext: {
          goodsPaymentMode: 'PREPAID',
          goodsValue: '450.00',
          currency: 'MXN',
        },
      };
      const legacyKey = key();
      const req = await api()
        .post('/api/v1/delivery-requests')
        .auth(tokens[0], { type: 'bearer' })
        .set('Idempotency-Key', legacyKey)
        .send(legacy)
        .expect(201);
      await api()
        .post('/api/v1/delivery-requests/' + req.body.publicId + '/quotes')
        .auth(tokens[0], { type: 'bearer' })
        .send({})
        .expect(201);
      await post(legacyKey).expect(409);
      expect(await p.prequoteConsumptionPermit.count()).toBe(permits);
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
      // Explicit legacy fixture expansion before the MPQ preservation series, never part of MPQ emission.
      baseline = await counts();
      preserved = await digest();
    });
    it('normalizes order and nullable measures without changing the key', async () => {
      const k = key();
      await post(k).expect(201);
      const b = structuredClone(body);
      b.stops.reverse();
      await post(k, {
        ...b,
        packages: [{ ...b.packages[0], weightKg: null, isFragile: false }],
      }).expect(200);
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
    });
    it('rejects missing/invalid key before reservation', async () => {
      await post('short').expect(400);
      await api()
        .post('/api/v1/delivery-prequotes')
        .auth(tokens[0], { type: 'bearer' })
        .send(body)
        .expect(400);
      expect(routing.calculateRoute).not.toHaveBeenCalled();
    });
    it('conflicting body and legacy operation reject before routing', async () => {
      const k = key();
      await post(k).expect(201);
      await post(k, {
        ...body,
        packages: [{ category: 'FOOD', quantity: 2 }],
      }).expect(409);
      const legacy = key();
      await p.apiIdempotencyRecord.create({
        data: {
          integrationClientId: clients[0],
          key: legacy,
          operation: 'delivery_requests.create',
          resourceType: 'DeliveryRequest',
          resourceId: randomUUID(),
          requestHash: '0'.repeat(64),
        },
      });
      await post(legacy).expect(409);
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
    });
    it('scope and ownership: foreign and missing both 404; human token rejected', async () => {
      const r = await post().expect(201);
      await get(r.body.publicId, tokens[1]).expect(404);
      await get('MPQ-999999999999').expect(404);
      const none = await sign(0, []);
      await post(key(), body, none).expect(403);
      await get(r.body.publicId, none).expect(403);
      const human = await new JwtService().signAsync(
        { sub: randomUUID(), type: 'access' },
        { secret: process.env.JWT_ACCESS_SECRET },
      );
      await post(key(), body, human).expect(401);
    });
    it('suspended integration and revoked credential reject even replay', async () => {
      const k = key();
      await post(k).expect(201);
      await p.integrationClient.update({
        where: { id: clients[0] },
        data: { status: 'SUSPENDED' },
      });
      await post(k).expect(401);
      await p.integrationClient.update({
        where: { id: clients[0] },
        data: { status: 'ACTIVE' },
      });
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'REVOKED' },
      });
      await post(k).expect(401);
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'ACTIVE' },
      });
    });
    it('disabled flag creates no reservation; GET/replay still work and expired replay never renews', async () => {
      config.set('PREQUOTE_VALIDITY_MS', 1);
      const k = key();
      const r = await post(k).expect(201);
      await new Promise((r) => setTimeout(r, 150));
      config.set('PREQUOTE_ENABLED', false);
      const newKey = key();
      expect((await post(newKey).expect(503)).body.code).toBe(
        'PREQUOTE_DISABLED',
      );
      expect(await execution(newKey)).toBeNull();
      const again = await post(k).expect(200);
      expect(again.body.status).toBe('EXPIRED');
      expect(again.body.expiresAt).toBe(r.body.expiresAt);
      await get(r.body.publicId).expect(200);
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
    });
    it('routing runs outside locks and receives only canonical points', async () => {
      const k = key();
      routing.calculateRoute.mockImplementationOnce(async () => {
        await p.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM "ApiIdempotencyRecord" WHERE key=${k} FOR UPDATE NOWAIT`;
          await tx.$queryRaw`SELECT id FROM "ServiceZone" WHERE id=${zoneId}::uuid FOR UPDATE NOWAIT`;
        });
        return route();
      });
      await post(k).expect(201);
      expect(routing.calculateRoute.mock.calls[0]).toEqual(
        body.stops.map(({ latitude, longitude }) => ({ latitude, longitude })),
      );
    });
    it('routing timeout recovers under same key with bounded attempts', async () => {
      const { RoutingError } = await import('../dist/routing/routing.types.js');
      const k = key();
      routing.calculateRoute.mockRejectedValueOnce(
        new RoutingError('ROUTING_UNAVAILABLE', 'TIMEOUT'),
      );
      expect((await post(k).expect(503)).body.code).toBe('ROUTING_UNAVAILABLE');
      expect((await execution(k))?.execution?.state).toBe('RETRYABLE_FAILED');
      await post(k).expect(201);
      expect((await execution(k))?.execution?.attempts).toBe(2);
    });
    it('route not found is terminal and never invokes routing on retry', async () => {
      const { RoutingError } = await import('../dist/routing/routing.types.js');
      const k = key();
      routing.calculateRoute.mockRejectedValueOnce(
        new RoutingError('ROUTE_NOT_FOUND', 'NO_ROUTES'),
      );
      await post(k).expect(422);
      const r = await post(k).expect(422);
      expect(r.headers['retry-after']).toBeUndefined();
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
      expect((await execution(k))?.execution?.state).toBe('FAILED');
    });
    it('exhaustion stops further routing and preserves stored attempt budget', async () => {
      const { RoutingError } = await import('../dist/routing/routing.types.js');
      const k = key();
      routing.calculateRoute.mockRejectedValue(
        new RoutingError('ROUTING_UNAVAILABLE', 'TIMEOUT'),
      );
      for (let i = 0; i < 2; i++) await post(k).expect(503);
      for (let i = 0; i < 2; i++)
        expect((await post(k).expect(409)).body.code).toBe('PREQUOTE_FAILED');
      expect(routing.calculateRoute).toHaveBeenCalledTimes(3);
      expect((await execution(k))?.execution?.attempts).toBe(3);
    });
    it('revocation during routing prevents publication', async () => {
      const k = key();
      routing.calculateRoute.mockImplementationOnce(async () => {
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { status: 'REVOKED' },
        });
        return route();
      });
      await post(k).expect(401);
      const record = await execution(k);
      expect(
        await p.deliveryPrequote.count({ where: { id: record!.resourceId } }),
      ).toBe(0);
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'ACTIVE' },
      });
    });
    it('administrative change during routing cannot publish incompatible configuration', async () => {
      const k = key();
      routing.calculateRoute.mockImplementationOnce(async () => {
        await p.serviceZone.update({
          where: { id: zoneId },
          data: { status: 'INACTIVE' },
        });
        return route();
      });
      expect((await post(k).expect(409)).body.code).toBe(
        'PREQUOTE_CONFIGURATION_CHANGED',
      );
      expect(
        await p.deliveryPrequote.count({
          where: { id: (await execution(k))!.resourceId },
        }),
      ).toBe(0);
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { status: 'ACTIVE' },
      });
      await post(k).expect(201);
    });
    it('administrative changes after publication do not alter price/zone evidence', async () => {
      const k = key();
      const r = await post(k).expect(201);
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { name: 'Changed A4 zone' },
      });
      expect((await get(r.body.publicId).expect(200)).body).toEqual(r.body);
      expect((await post(k).expect(200)).body).toEqual(r.body);
    });
    it('same key is isolated by integration', async () => {
      const k = key();
      const a = await post(k).expect(201);
      const b = await post(k, body, tokens[1]).expect(201);
      expect(a.body.publicId).not.toBe(b.body.publicId);
      await get(a.body.publicId, tokens[1]).expect(404);
    });
    it('GET and replay expire at exact expiresAt with no routing or renewed deadline', async () => {
      const k = key();
      const r = await post(k).expect(201);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(new Date(r.body.expiresAt));
        const read = await get(r.body.publicId).expect(200);
        const replay = await post(k).expect(200);
        expect(read.body.status).toBe('EXPIRED');
        expect(replay.body).toEqual(read.body);
        expect(replay.body.expiresAt).toBe(r.body.expiresAt);
        expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });
    it('publishes after routing, not before; snapshot matches SQL band and independent validity', async () => {
      config.set('PREQUOTE_VALIDITY_MS', 12345);
      let returnedAt = 0;
      routing.calculateRoute.mockImplementationOnce(async () => {
        await wait(120);
        returnedAt = Date.now();
        return route();
      });
      const k = key();
      const r = await post(k).expect(201);
      expect(Date.parse(r.body.createdAt)).toBeGreaterThanOrEqual(returnedAt);
      expect(Date.parse(r.body.expiresAt) - Date.parse(r.body.createdAt)).toBe(
        12345,
      );
      const q = await p.deliveryPrequote.findUniqueOrThrow({
        where: { publicId: r.body.publicId },
      });
      const band = await p.rateBand.findUniqueOrThrow({
        where: { id: q.rateBandId },
      });
      expect(q.amount.toFixed(2)).toBe(band.amount.toFixed(2));
      expect(q.ratePlanId).toBe(planId);
      expect(q.distanceMeters).toBe(1200);
      expect(q.currency).toBe('MXN');
      expect(r.body.availabilityGuaranteed).toBe(false);
      expect(JSON.stringify(r.body)).not.toMatch(
        /ownerHash|secretHash|credentialId|routingProvider|ratePlanId/,
      );
    });
    it.each([
      'creditCost',
      'clientSecret',
      'deliveryRequestId',
      'amount',
      'scheduledAt',
      'recipientContact',
    ])('rejects unknown sensitive field %s before admission', async (field) => {
      const before = await rows(clients[0]);
      await post(key(), { ...body, [field]: 'synthetic' }).expect(400);
      expect(await rows(clients[0])).toEqual(before);
      expect(routing.calculateRoute).not.toHaveBeenCalled();
    });
    it('expired credential and removed current scope deny existing tokens without routing', async () => {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      try {
        await post().expect(401);
      } finally {
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { expiresAt: null },
        });
      }
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { scopes: ['prequotes:read'] },
      });
      try {
        await post().expect(403);
      } finally {
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { scopes },
        });
      }
      expect(routing.calculateRoute).not.toHaveBeenCalled();
    });
    it('two applications compete on one intent and only one start and resource persist', async () => {
      expect(services[0]).not.toBe(services[1]);
      const k = key();
      const before = await rows(clients[0]);
      const rs = await Promise.all([
        post(k, body, tokens[0], 0),
        post(k, body, tokens[0], 1),
      ]);
      expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
      expect(rs.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
      const fresh = (await rows(clients[0])).filter(
        (r) => !before.some((b) => b.id === r.id),
      );
      expect(fresh.filter((r) => r.startedAt)).toHaveLength(1);
      expect(
        await p.deliveryPrequote.count({
          where: { idempotencyRecordId: (await execution(k))!.id },
        }),
      ).toBe(1);
      expect(
        routings.reduce((n, r) => n + r.calculateRoute.mock.calls.length, 0),
      ).toBe(1);
    });
    it('two applications compete on last minute capacity with actual HTTP Retry-After', async () => {
      // Fresh integration avoids consumed units from other cases.
      const id = await client();
      await configure({ minute: 1 });
      const rs = await Promise.all([
        services[0].admit(id),
        services[1].admit(id),
      ]);
      expect(rs.filter((r) => r.admitted)).toHaveLength(1);
      expect(await rows(id)).toHaveLength(1);
      const winner = rs.find((r) => r.admitted)!;
      if (!winner.admitted) throw Error();
      await winner.permit.start();
      const denied = await services[1].admit(id);
      expect(denied.admitted).toBe(false);
      if (!denied.admitted)
        expect(denied.retryAt!.getTime() - Date.now()).toBeGreaterThan(50000);
      await winner.permit.finish({ routingStarted: false, published: false });
      await configure({ minute: 1 });
      const r = await post().expect(429);
      expect(r.body.code).toBe('PREQUOTE_CONSUMPTION_LIMIT');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.headers['x-request-id']).toBeTruthy();
    });
    it('SQL rejects a committed snapshot update/delete and terminal consumption changes', async () => {
      const r = await post().expect(201);
      const q = await p.deliveryPrequote.findUniqueOrThrow({
        where: { publicId: r.body.publicId },
      });
      for (const data of [
        { amount: '1.00' },
        { currency: 'USD' },
        { integrationClientId: clients[1] },
        { expiresAt: new Date(Date.now() + 9000000) },
      ])
        await expect(
          p.deliveryPrequote.update({ where: { id: q.id }, data }),
        ).rejects.toThrow();
      await expect(
        p.deliveryPrequote.delete({ where: { id: q.id } }),
      ).rejects.toThrow();
      const permit = (await rows(clients[0])).at(-1)!;
      await expect(
        p.prequoteConsumptionPermit.update({
          where: { id: permit.id },
          data: { units: 2 },
        }),
      ).rejects.toThrow();
      await expect(
        p.prequoteConsumptionPermit.update({
          where: { id: permit.id },
          data: { state: 'RESERVED' },
        }),
      ).rejects.toThrow();
      expect(
        await p.deliveryPrequote.findUnique({ where: { id: q.id } }),
      ).toEqual(q);
    });
    it('publication SQL failure rolls back success and snapshot but retains consumed units', async () => {
      await p.$executeRawUnsafe(
        `CREATE FUNCTION a6_reject_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='SUCCEEDED' THEN RAISE EXCEPTION 'A6_CONTROLLED_PUBLICATION_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await p.$executeRawUnsafe(
        `CREATE TRIGGER a6_reject_publication BEFORE UPDATE ON "ApiIdempotencyExecution" FOR EACH ROW EXECUTE FUNCTION a6_reject_publication()`,
      );
      const k = key();
      try {
        await post(k).expect(503);
        const record = (await execution(k))!;
        expect(record.execution!.state).toBe('RETRYABLE_FAILED');
        expect(
          await p.deliveryPrequote.count({
            where: { idempotencyRecordId: record.id },
          }),
        ).toBe(0);
        expect((await rows(clients[0])).at(-1)).toMatchObject({
          state: 'FINISHED',
          units: 1,
          routingReported: true,
          publishedReported: false,
        });
      } finally {
        await p.$executeRawUnsafe(
          'DROP TRIGGER a6_reject_publication ON "ApiIdempotencyExecution"',
        );
        await p.$executeRawUnsafe('DROP FUNCTION a6_reject_publication()');
      }
      await post(k).expect(201);
      expect((await execution(k))!.execution!.attempts).toBe(2);
    });
    it('no conversion or authorized accept routes exist', async () => {
      const r = await post().expect(201);
      for (const action of ['convert', 'accept', 'accept-authorized'])
        await api()
          .post('/api/v1/delivery-prequotes/' + r.body.publicId + '/' + action)
          .auth(tokens[0], { type: 'bearer' })
          .send({})
          .expect(404);
    });
    it('revocation while admission waits is revalidated before start with real controls', async () => {
      let release!: () => void;
      let ready!: () => void;
      const entered = new Promise<void>((r) => {
        ready = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const held = p.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
          ready();
          await gate;
        },
        { timeout: 10000 },
      );
      await entered;
      const before = await rows(clients[0]);
      const k = key();
      const pending = post(k).then((r) => r);
      try {
        await wait(200);
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { scopes: ['prequotes:read'] },
        });
      } finally {
        release();
        await held;
      }
      try {
        expect((await pending).status).toBe(401);
        expect(routing.calculateRoute).not.toHaveBeenCalled();
        const fresh = (await rows(clients[0])).filter(
          (r) => !before.some((b) => b.id === r.id),
        );
        expect(fresh).toHaveLength(1);
        expect(fresh[0].state).toBe('CANCELLED');
      } finally {
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { scopes },
        });
      }
    });
    it('lost HTTP response after committed publication replays once without a second start', async () => {
      let release!: () => void;
      let held: Promise<unknown> | undefined;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      routing.calculateRoute.mockImplementationOnce(async () => {
        let ready!: () => void;
        const entered = new Promise<void>((r) => {
          ready = r;
        });
        held = p.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
            ready();
            await gate;
          },
          { timeout: 10000 },
        );
        await entered;
        return route();
      });
      const k = key();
      const req = post(k);
      const response = req.then(
        (r) => r.status,
        () => 0,
      );
      let published = false;
      try {
        for (let i = 0; i < 80; i++) {
          const r = await execution(k);
          if (r?.execution?.state === 'SUCCEEDED') {
            published = true;
            break;
          }
          await wait(25);
        }
        expect(published).toBe(true);
        req.abort();
      } finally {
        release();
        await held;
      }
      await response;
      const before = await rows(clients[0]);
      await post(k, body, tokens[0], 1).expect(200);
      const record = (await execution(k))!;
      expect(
        await p.deliveryPrequote.count({
          where: { idempotencyRecordId: record.id },
        }),
      ).toBe(1);
      expect((await rows(clients[0])).map((r) => r.id)).toEqual(
        before.map((r) => r.id),
      );
      expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
    });
    it('independent persistence instances recover one expired lease and fence old publication and failure', async () => {
      const { PrequotePersistenceService } =
        await import('../dist/delivery-prequotes/prequote-persistence.service.js');
      const a = apps[0].get(PrequotePersistenceService);
      const b = apps[1].get(PrequotePersistenceService);
      expect(a).not.toBe(b);
      const k = key();
      const old = await a.reserve(clients[0], k, body, {
        leaseMs: 100,
        maxAttempts: 3,
      });
      if (old.kind !== 'acquired') throw Error();
      await wait(160);
      const rs = await Promise.all([
        a.reserve(clients[0], k, body, { leaseMs: 90000, maxAttempts: 3 }),
        b.reserve(clients[0], k, body, { leaseMs: 90000, maxAttempts: 3 }),
      ]);
      expect(rs.map((r) => r.kind).sort()).toEqual(['acquired', 'in_progress']);
      await expect(
        a.fail(old.lease, 'OLD_EXECUTOR', false),
      ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
      await expect(
        a.publish(
          old.lease,
          body,
          { serviceZoneId: zoneId, ratePlanId: planId, route: route() },
          900000,
        ),
      ).rejects.toMatchObject({ code: 'PREQUOTE_LEASE_LOST' });
      const current = rs.find((r) => r.kind === 'acquired')!;
      if (current.kind !== 'acquired') throw Error();
      await b.fail(current.lease, 'CHECK_TERMINAL', false);
      expect(
        (
          await a.reserve(clients[0], k, body, {
            leaseMs: 90000,
            maxAttempts: 3,
          })
        ).kind,
      ).toBe('failed');
    });
    it('coordinated reduction preserves prior use; changed retries cannot rewrite consumed units', async () => {
      const id = await client();
      await configure({ retries: 2 });
      const permit = await admit(0, id);
      await permit.start();
      await permit.finish({ routingStarted: false, published: false });
      const before = await rows(id);
      expect(before[0].units).toBe(3);
      // Stop local admissions and replace only policy identity: no usage reset.
      for (const c of configs) c.set('PREQUOTE_ENABLED', false);
      await configure({ globalUnits: 1, retries: 0 });
      const denied = await services[1].admit(id);
      expect(denied.admitted).toBe(false);
      expect(await rows(id)).toEqual(before);
    });
    it('expired reservations beyond lazy batch do not consume capacity', async () => {
      const id = await client();
      await configure({ minute: 1, day: 1, concurrent: 1 });
      const now = Date.now();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify(limits))
        .digest('hex');
      await p.prequoteConsumptionPermit.createMany({
        data: Array.from({ length: 105 }, () => ({
          id: randomUUID(),
          integrationClientId: id,
          ownerHash: '0'.repeat(64),
          policyFingerprint: fingerprint,
          state: 'RESERVED',
          units: 1,
          routingBudgetMs: 16000,
          reservedAt: new Date(now - 2000),
          reserveExpiresAt: new Date(now - 1000),
        })),
      });
      const first = await services[0].admit(id);
      expect(first.admitted).toBe(true);
      const all = await rows(id);
      expect(all.filter((r) => r.state === 'EXPIRED')).toHaveLength(100);
      expect(
        all.filter(
          (r) => r.state === 'RESERVED' && r.reserveExpiresAt < new Date(),
        ),
      ).toHaveLength(5);
      if (first.admitted)
        await first.permit.finish({ routingStarted: false, published: false });
      const second = await services[1].admit(id);
      expect(second.admitted).toBe(true);
      if (second.admitted)
        await second.permit.finish({ routingStarted: false, published: false });
    });
    it('real database lock timeout in control fails closed without routing or partial permit', async () => {
      let release!: () => void;
      let ready!: () => void;
      const entered = new Promise<void>((r) => {
        ready = r;
      });
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const held = p.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(1313,5)::text`;
          ready();
          await gate;
        },
        { timeout: 15000 },
      );
      await entered;
      const before = await rows(clients[0]);
      const k = key();
      const pending = post(k).then((r) => r);
      try {
        await wait(5600);
      } finally {
        release();
        await held;
      }
      const result = await pending;
      expect(result.status).toBe(503);
      expect(result.body.code).toBe('PREQUOTE_CONSUMPTION_UNAVAILABLE');
      expect(await rows(clients[0])).toEqual(before);
      expect(await execution(k)).toBeNull();
      expect(routing.calculateRoute).not.toHaveBeenCalled();
    }, 15000);

    it('preserves nonempty logistics, ledger and outbox exactly and keeps logs sanitized', async () => {
      expect(await counts()).toEqual(baseline);
      const after = await digest();
      expect(after).toEqual(preserved);
      writeFileSync(
        '.tmp/a6/preservation.json',
        JSON.stringify({ before: preserved, after, equal: true }, null, 2),
      );
      for (const secret of [...tokens, ...secrets])
        expect(logs.join('\n')).not.toContain(secret);
      expect(logs.join('\n')).not.toContain('"clientSecret":');
    });
  },
);
