import 'reflect-metadata';
import { randomBytes, randomUUID, randomInt } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
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
const key = () => `a4-${randomUUID()}`;
const route = () => ({
  distanceMeters: 1200,
  durationSeconds: 60,
  routingProvider: 'a4-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'a4-controlled',
  calculateRoute: vi.fn(async (...args: unknown[]) => {
    void args;
    return route();
  }),
};
const permit = {
  assertReady: vi.fn(async () => {}),
  start: vi.fn(async () => {}),
  finish: vi.fn(async (outcome: unknown) => {
    void outcome;
  }),
};
const consumption = {
  admit: vi.fn(async (id: string) => {
    void id;
    return { admitted: true, permit };
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
let config: ConfigService;
let zoneId: string;
let planId: string;
let persistence: import('../src/delivery-prequotes/prequote-persistence.service.js').PrequotePersistenceService;
let baseline: number[];
const tokens: string[] = [];
const api = () => request(app.getHttpServer());
const post = (k = key(), b: object = body, t = tokens[0]) =>
  api()
    .post('/api/v1/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
const get = (id: string, t = tokens[0]) =>
  api().get(`/api/v1/delivery-prequotes/${id}`).auth(t, { type: 'bearer' });
const counts = () =>
  Promise.all([
    p.deliveryRequest.count(),
    p.deliveryQuote.count(),
    p.dispatch.count(),
    p.deliveryAssignment.count(),
    p.creditLedgerEntry.count(),
  ]);
async function execution(k: string) {
  return p.apiIdempotencyRecord.findUnique({
    where: {
      integrationClientId_key: { integrationClientId: clients[0], key: k },
    },
    include: { execution: true },
  });
}
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
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER } = await import('../dist/routing/routing.types.js');
  const { PREQUOTE_CONSUMPTION } =
    await import('../dist/delivery-prequotes/prequote-consumption.js');
  const { PrequotePersistenceService } =
    await import('../dist/delivery-prequotes/prequote-persistence.service.js');
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue(routing)
    .overrideProvider(PREQUOTE_CONSUMPTION)
    .useValue(consumption)
    .setLogger(logger)
    .compile();
  app = ref.createNestApplication({ logger, bodyParser: false });
  setup(app);
  await app.init();
  config = app.get(ConfigService);
  persistence = app.get(PrequotePersistenceService);
  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `A4_${run}_${i}`,
      name: 'A4 fixture',
    })),
  });
  await p.integrationCredential.createMany({
    data: credentials.map((id, i) => ({
      id,
      clientId: clients[i],
      secretHash: randomBytes(32).toString('hex'),
      scopes: ['prequotes:create', 'prequotes:read'],
    })),
  });
  tokens.push(await sign(0), await sign(1));
  const zone = await p.serviceZone.create({
    data: {
      code: `A4_${run}`,
      name: 'A4 zone',
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
  baseline = await counts();
}, 30000);
beforeEach(() => {
  vi.restoreAllMocks();
  routing.calculateRoute.mockReset().mockImplementation(async () => route());
  consumption.admit.mockReset().mockResolvedValue({ admitted: true, permit });
  permit.start.mockReset().mockResolvedValue();
  permit.finish.mockReset().mockResolvedValue();
  config.set('PREQUOTE_ENABLED', true);
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
  await app?.close();
  await p.$disconnect();
});
describe('A4 HTTP prequotes with PostgreSQL and controlled routing', () => {
  it('201, complete safe representation, canonical conditions, GET and sequential replay without routing', async () => {
    const k = key();
    const r = await post(k).expect(201);
    expect(r.headers['idempotent-replayed']).toBe('false');
    expect(r.headers['x-request-id']).toBeTruthy();
    expect(Object.keys(r.body).sort()).toEqual(
      [
        'publicId',
        'status',
        'conditionsVersion',
        'conditions',
        'serviceZone',
        'distanceMeters',
        'durationSeconds',
        'amount',
        'currency',
        'createdAt',
        'expiresAt',
        'convertedAt',
        'deliveryRequestPublicId',
        'deliveryQuotePublicId',
        'availabilityGuaranteed',
      ].sort(),
    );
    expect(r.body).toMatchObject({
      status: 'OFFERED',
      amount: '25.10',
      currency: 'MXN',
      availabilityGuaranteed: false,
      convertedAt: null,
      deliveryRequestPublicId: null,
      deliveryQuotePublicId: null,
      conditions: {
        conditionsVersion: 1,
        packages: [{ quantity: 1, weightKg: null, isFragile: false }],
      },
    });
    expect(Date.parse(r.body.expiresAt) - Date.parse(r.body.createdAt)).toBe(
      900000,
    );
    const again = await post(k).expect(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(again.body).toEqual(r.body);
    expect((await get(r.body.publicId).expect(200)).body).toEqual(r.body);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
  });
  it('concurrent duplicate observes in progress and Retry-After, then replay', async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    routing.calculateRoute.mockImplementationOnce(async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return route();
    });
    const k = key();
    const first = post(k).then((r) => r);
    await started;
    try {
      const r = await post(k).expect(409);
      expect(r.body.code).toBe('PREQUOTE_IN_PROGRESS');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      release();
    }
    expect((await first).status).toBe(201);
    await post(k).expect(200);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
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
  it.each([
    { ...body, conditionsVersion: undefined },
    { ...body, financialContext: {} },
    { ...body, integrationClientId: clients[1] },
    {
      ...body,
      stops: [{ ...body.stops[0], address: 'private' }, body.stops[1]],
    },
    {
      ...body,
      stops: [{ ...body.stops[0], latitude: 40.1234567 }, body.stops[1]],
    },
    { ...body, packages: [{ category: 'DOCUMENT', quantity: 1 }] },
    { ...body, packages: [{ category: 'FOOD', quantity: 1, isFragile: null }] },
    {
      ...body,
      packages: [{ category: 'FOOD', quantity: 1, weightKg: 1.0001 }],
    },
  ])('rejects invalid/unknown conditions before reservation', async (b) => {
    const k = key();
    await post(k, b).expect(400);
    expect(await execution(k)).toBeNull();
    expect(routing.calculateRoute).not.toHaveBeenCalled();
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
  it('production admission denies despite enabled flag and creates no reservation', async () => {
    const { UnavailablePrequoteConsumption } =
      await import('../dist/delivery-prequotes/prequote-consumption.js');
    consumption.admit.mockImplementationOnce(
      async () => new UnavailablePrequoteConsumption().admit() as never,
    );
    const k = key();
    const r = await post(k).expect(503);
    expect(r.body.code).toBe('PREQUOTE_CONSUMPTION_UNAVAILABLE');
    expect(r.headers['retry-after']).toBeUndefined();
    expect(await execution(k)).toBeNull();
    expect(routing.calculateRoute).not.toHaveBeenCalled();
  });
  it('denial with justified retry propagates Retry-After without reserve', async () => {
    consumption.admit.mockResolvedValueOnce({
      admitted: false,
      retryAt: new Date(Date.now() + 10000),
    } as never);
    const k = key();
    const r = await post(k).expect(503);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(await execution(k)).toBeNull();
  });
  it('disabling while admission waits does not reserve or consume attempts', async () => {
    consumption.admit.mockImplementationOnce(async () => {
      config.set('PREQUOTE_ENABLED', false);
      return { admitted: true, permit };
    });
    const k = key();
    await post(k).expect(503);
    expect(await execution(k)).toBeNull();
    expect(permit.finish).toHaveBeenCalledWith({
      routingStarted: false,
      published: false,
    });
  });
  it('disabling before routing blocks; disabling during routing allows only that publication', async () => {
    permit.start.mockImplementationOnce(async () => {
      config.set('PREQUOTE_ENABLED', false);
    });
    await post().expect(503);
    expect(routing.calculateRoute).not.toHaveBeenCalled();
    config.set('PREQUOTE_ENABLED', true);
    routing.calculateRoute.mockImplementationOnce(async () => {
      config.set('PREQUOTE_ENABLED', false);
      return route();
    });
    await post().expect(201);
    const k = key();
    await post(k).expect(503);
    expect(await execution(k)).toBeNull();
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
  it('expired abandoned last lease maps attempts exhausted without routing', async () => {
    const k = key();
    await persistence.reserve(clients[0], k, body, {
      leaseMs: 100,
      maxAttempts: 1,
    });
    await new Promise((r) => setTimeout(r, 150));
    const r = await post(k).expect(409);
    expect(r.body.code).toBe('ATTEMPTS_EXHAUSTED');
    expect(routing.calculateRoute).not.toHaveBeenCalled();
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
  it('scope revocation during admission rechecked before external work', async () => {
    consumption.admit.mockImplementationOnce(async () => {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { scopes: ['prequotes:read'] },
      });
      return { admitted: true, permit };
    });
    await post().expect(401);
    expect(routing.calculateRoute).not.toHaveBeenCalled();
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { scopes: ['prequotes:read', 'prequotes:create'] },
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
  it('lost COMMIT response returns success only after verifying committed evidence', async () => {
    const original = persistence.publish.bind(persistence);
    vi.spyOn(persistence, 'publish').mockImplementationOnce(async (...args) => {
      await original(...args);
      throw Error('simulated lost response');
    });
    const k = key();
    const r = await post(k).expect(200);
    expect(r.headers['idempotent-replayed']).toBe('true');
    await get(r.body.publicId).expect(200);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
  });
  it('late executor cannot publish and same key can recover', async () => {
    const reserve = persistence.reserve.bind(persistence);
    vi.spyOn(persistence, 'reserve').mockImplementationOnce((id, k, b) =>
      reserve(id, k, b, { leaseMs: 20, maxAttempts: 3 }),
    );
    vi.spyOn(persistence, 'requireRoutingBudget').mockResolvedValueOnce();
    routing.calculateRoute.mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return route();
    });
    const k = key();
    const r = await post(k).expect(409);
    expect(r.body.code).toBe('PREQUOTE_LEASE_LOST');
    await post(k).expect(201);
    expect((await execution(k))?.execution?.attempts).toBe(2);
  });
  it('publication failure rolls back snapshot and permits bounded recovery', async () => {
    vi.spyOn(persistence, 'publish').mockRejectedValueOnce(
      Error('controlled failure'),
    );
    const k = key();
    await post(k).expect(503);
    expect(
      await p.deliveryPrequote.count({
        where: { id: (await execution(k))!.resourceId },
      }),
    ).toBe(0);
    await post(k).expect(201);
  });
  it('same key is isolated by integration', async () => {
    const k = key();
    const a = await post(k).expect(201);
    const b = await post(k, body, tokens[1]).expect(201);
    expect(a.body.publicId).not.toBe(b.body.publicId);
    await get(a.body.publicId, tokens[1]).expect(404);
  });
  it('admission race still reserves one attempt and finalizes the unused permit', async () => {
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    consumption.admit.mockImplementation(async () => {
      if (++arrived === 2) release();
      await gate;
      return { admitted: true, permit };
    });
    const k = key();
    const replies = await Promise.all([post(k), post(k)]);
    expect(replies.filter((r) => r.status === 201)).toHaveLength(1);
    expect(replies.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
    expect((await execution(k))?.execution?.attempts).toBe(1);
    expect(permit.finish).toHaveBeenCalledWith({
      routingStarted: false,
      published: false,
    });
  });
  it('insufficient remaining lease budget blocks routing without stealing a new attempt', async () => {
    const reserve = persistence.reserve.bind(persistence);
    vi.spyOn(persistence, 'reserve').mockImplementationOnce((id, k, b) =>
      reserve(id, k, b, { leaseMs: 5000, maxAttempts: 3 }),
    );
    const k = key();
    const r = await post(k).expect(409);
    expect(r.body.code).toBe('PREQUOTE_LEASE_BUDGET_INSUFFICIENT');
    expect(routing.calculateRoute).not.toHaveBeenCalled();
    await post(k).expect(201);
  });
  it('rate plan replacement during routing rejects old evidence and retry uses new version', async () => {
    const k = key();
    const previous = planId;
    routing.calculateRoute.mockImplementationOnce(async () => {
      await p.ratePlan.update({
        where: { id: previous },
        data: { status: 'INACTIVE', deactivatedAt: new Date() },
      });
      const replacement = await p.ratePlan.create({
        data: {
          serviceZoneId: zoneId,
          serviceType: 'LOCAL_DELIVERY',
          version: 2,
          status: 'DRAFT',
          currency: 'MXN',
          quoteValidityMinutes: 1,
          bands: {
            create: {
              minDistanceMeters: 0,
              maxDistanceMeters: 10000,
              amount: '31.00',
              currency: 'MXN',
            },
          },
        },
      });
      await p.ratePlan.update({
        where: { id: replacement.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      });
      planId = replacement.id;
      return route();
    });
    expect((await post(k).expect(409)).body.code).toBe(
      'PREQUOTE_CONFIGURATION_CHANGED',
    );
    const r = await post(k).expect(201);
    expect(r.body.amount).toBe('31.00');
    expect(Date.parse(r.body.expiresAt) - Date.parse(r.body.createdAt)).toBe(
      900000,
    );
  });
  it('permit finalization failure cannot turn a committed snapshot into failure', async () => {
    permit.finish.mockRejectedValueOnce(
      Error('test-only finalization failure'),
    );
    const k = key();
    const r = await post(k).expect(201);
    expect((await post(k).expect(200)).body).toEqual(r.body);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(1);
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
  it('admission infrastructure failure fails closed without key or routing', async () => {
    consumption.admit.mockRejectedValueOnce(
      Error('controlled admission failure'),
    );
    const k = key();
    expect((await post(k).expect(503)).body.code).toBe(
      'PREQUOTE_CONSUMPTION_UNAVAILABLE',
    );
    expect(await execution(k)).toBeNull();
    expect(routing.calculateRoute).not.toHaveBeenCalled();
  });
  it('no emission side effects; A-only scopes cannot convert and MPQ accept stays absent; safe logs', async () => {
    expect(await counts()).toEqual(baseline);
    await api()
      .post('/api/v1/delivery-prequotes/MPQ-000001/convert')
      .auth(tokens[0], { type: 'bearer' })
      .send({})
      .expect(403);
    await api()
      .post('/api/v1/delivery-prequotes/MPQ-000001/accept')
      .auth(tokens[0], { type: 'bearer' })
      .send({})
      .expect(404);
    const all = logs.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    expect(all).not.toContain('latitude');
    expect(all).not.toContain('clientSecret');
    expect(all).not.toContain('secretHash');
  });
});
