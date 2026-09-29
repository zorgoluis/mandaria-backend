import 'reflect-metadata';
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
import { consumptionRetryAt } from '../src/delivery-prequotes/consumption-policy.js';
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
  routingProvider: 'a5-controlled',
  calculatedAt: new Date(),
});
const routings = [
  { name: 'a5-control-a', calculateRoute: vi.fn(async () => route()) },
  { name: 'a5-control-b', calculateRoute: vi.fn(async () => route()) },
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
const counts = () =>
  Promise.all([
    p.deliveryRequest.count(),
    p.deliveryQuote.count(),
    p.dispatch.count(),
    p.creditLedgerEntry.count(),
    p.deliveryAssignment.count(),
  ]);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = () => `a5-${randomUUID()}`;
const post = (i = 0, k = key(), data: object = body) =>
  request(apps[i].getHttpServer())
    .post('/api/v1/delivery-prequotes')
    .auth(tokens[0], { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(data);
const rows = (id: string) =>
  p.prequoteConsumptionPermit.findMany({
    where: { integrationClientId: id },
    orderBy: { reservedAt: 'asc' },
  });
async function client() {
  return (
    await p.integrationClient.create({
      data: {
        code: `A5_${randomUUID().replaceAll('-', '')}`,
        name: 'A5 fixture',
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
      code: `A5_${run}_${i}`,
      name: 'A5 HTTP fixture',
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
  for (let i = 0; i < 2; i++)
    tokens.push(
      await new JwtService().signAsync(
        {
          sub: clients[i],
          credentialId: credentials[i],
          principalType: 'integration',
          type: 'integration_access',
          scopes: ['prequotes:create', 'prequotes:read'],
        },
        {
          secret: process.env.INTEGRATION_JWT_SECRET,
          issuer: 'mandaria',
          audience: 'mandaria-integrations',
          expiresIn: 3600,
          algorithm: 'HS256',
        },
      ),
    );
  const z = await p.serviceZone.create({
    data: {
      code: `A5_${run}`,
      name: 'A5 zone',
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
  baseline = await counts();
}, 30000);
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const r of routings)
    r.calculateRoute.mockReset().mockImplementation(async () => route());
  await configure();
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
describe('A5 real durable consumption: two Nest applications, shared PostgreSQL', () => {
  it('uses separate real service and Prisma instances, publishes and replays without more permits', async () => {
    const { PrismaService } = await import('../dist/prisma/prisma.service.js');
    expect(services[0]).not.toBe(services[1]);
    expect(apps[0].get(PrismaService)).not.toBe(apps[1].get(PrismaService));
    const k = key();
    const a = await post(0, k).expect(201);
    const before = await rows(clients[0]);
    expect(before.at(-1)).toMatchObject({
      state: 'FINISHED',
      units: 1,
      routingReported: true,
      publishedReported: true,
    });
    const b = await post(1, k).expect(200);
    expect(b.body).toEqual(a.body);
    expect(await rows(clients[0])).toEqual(before);
    expect(routings[1].calculateRoute).not.toHaveBeenCalled();
  });
  it('last minute quota slot is atomic across two instances', async () => {
    await configure({ minute: 1 });
    const id = await client();
    const replies = await Promise.all(
      Array.from({ length: 10 }, (_, i) => services[i % 2].admit(id)),
    );
    expect(replies.filter((r) => r.admitted)).toHaveLength(1);
    expect(await rows(id)).toHaveLength(1);
    expect(
      replies
        .filter((r) => !r.admitted)
        .every(
          (r) =>
            !r.admitted && r.code === 'PREQUOTE_CONSUMPTION_LIMIT' && r.retryAt,
        ),
    ).toBe(true);
  });
  it('daily quota counts started failures, never merely successful publication', async () => {
    await configure({ day: 1 });
    const id = await client();
    const permit = await admit(0, id);
    await permit.start();
    await permit.finish({ routingStarted: true, published: false });
    const denial = await services[1].admit(id);
    expect(denial.admitted).toBe(false);
    if (!denial.admitted)
      expect(denial.retryAt!.getTime()).toBe(
        (await rows(id))[0].startedAt!.getTime() + 86400000,
      );
  });
  it('two slots per integration, isolated from another integration', async () => {
    await configure({ concurrent: 2 });
    const id = await client();
    await admit(0, id);
    await admit(1, id);
    expect((await services[1].admit(id)).admitted).toBe(false);
    await admit(1, await client());
    expect(await rows(id)).toHaveLength(2);
  });
  it('global final units serialize all integrations and denial leaves no partial reservation', async () => {
    const now = new Date();
    const current = await p.prequoteConsumptionPermit.findMany({
      where: {
        OR: [
          { state: 'RESERVED', reserveExpiresAt: { gt: now } },
          { startedAt: { gt: new Date(now.getTime() - 86400000) } },
        ],
      },
    });
    const used = current.reduce((n, r) => n + r.units, 0);
    await configure({ globalUnits: used + 2, retries: 1 });
    const a = await client(),
      b = await client();
    const replies = await Promise.all([
      services[0].admit(a),
      services[1].admit(b),
    ]);
    expect(replies.filter((r) => r.admitted)).toHaveLength(1);
    expect((await rows(a)).length + (await rows(b)).length).toBe(1);
  });
  it('reserves three potential calls when adapter has two retries, without refunds', async () => {
    await configure({ retries: 2 });
    const id = await client();
    const permit = await admit(0, id);
    expect((await rows(id))[0].units).toBe(3);
    await permit.start();
    await permit.finish({ routingStarted: false, published: false });
    expect((await rows(id))[0]).toMatchObject({
      units: 3,
      state: 'FINISHED',
      routingReported: false,
    });
  });
  it('same idempotency key races across real instances produce one start and one MPQ', async () => {
    const k = key();
    const before = await rows(clients[0]);
    const results = await Promise.all([post(0, k), post(1, k)]);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.every((r) => [200, 201, 409].includes(r.status))).toBe(true);
    const added = (await rows(clients[0])).filter(
      (r) => !before.some((b) => b.id === r.id),
    );
    expect(added.filter((r) => r.startedAt)).toHaveLength(1);
    expect(
      added.filter((r) => !r.startedAt).every((r) => r.state === 'CANCELLED'),
    ).toBe(true);
    expect(
      routings.reduce((n, r) => n + r.calculateRoute.mock.calls.length, 0),
    ).toBe(1);
  });
  it('conflicting body does not consume extra routing or permits', async () => {
    const k = key();
    await post(0, k).expect(201);
    const before = await rows(clients[0]);
    await post(1, k, {
      ...body,
      packages: [{ category: 'FOOD', quantity: 2 }],
    }).expect(409);
    expect(await rows(clients[0])).toEqual(before);
  });
  it('HTTP quota denial is 429 with Retry-After and requestId, no reserve/key mutation', async () => {
    const before = await rows(clients[0]);
    await configure({ minute: 1 });
    const k = key();
    const r = await post(1, k).expect(429);
    expect(r.body.code).toBe('PREQUOTE_CONSUMPTION_LIMIT');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(r.headers['x-request-id']).toBeTruthy();
    expect(await rows(clients[0])).toEqual(before);
    expect(
      await p.apiIdempotencyRecord.count({
        where: { key: k, integrationClientId: clients[0] },
      }),
    ).toBe(0);
  });
  it('routing failure and same-key recovery both retain consumed units', async () => {
    const { RoutingError } = await import('../dist/routing/routing.types.js');
    routings[0].calculateRoute.mockRejectedValueOnce(
      new RoutingError('ROUTING_UNAVAILABLE', 'TIMEOUT'),
    );
    const k = key();
    const before = (await rows(clients[0])).length;
    await post(0, k).expect(503);
    await post(1, k).expect(201);
    const added = (await rows(clients[0])).slice(before);
    expect(added).toHaveLength(2);
    expect(added.every((r) => r.startedAt && r.state === 'FINISHED')).toBe(
      true,
    );
  });
  it('crash before start: expired reservation recovers concurrently without retaining consumption', async () => {
    await configure({ concurrent: 1 });
    const id = await client();
    const old = await admit(0, id);
    await wait(1100);
    const replies = await Promise.all([
      services[0].admit(id),
      services[1].admit(id),
    ]);
    expect(replies.filter((r) => r.admitted)).toHaveLength(1);
    await expect(old.start()).rejects.toMatchObject({
      code: 'PREQUOTE_PERMIT_INVALID',
    });
    await old.finish({ routingStarted: false, published: false });
    expect((await rows(id))[0]).toMatchObject({
      state: 'EXPIRED',
      startedAt: null,
    });
  });
  it('crash after start/before network and lost start response remain consumed', async () => {
    const id = await client();
    const permit = await admit(0, id);
    const original = services[0].startPermit.bind(services[0]);
    vi.spyOn(services[0], 'startPermit').mockImplementationOnce(
      async (...args) => {
        await original(...args);
        throw Error('lost start response');
      },
    );
    await expect(permit.start()).rejects.toThrow('lost start');
    await permit.finish({ routingStarted: false, published: false });
    expect((await rows(id))[0]).toMatchObject({
      state: 'FINISHED',
      units: 1,
      routingReported: false,
    });
    await expect(permit.start()).rejects.toMatchObject({
      code: 'PREQUOTE_PERMIT_INVALID',
    });
  });
  it('finish response lost and repeated finish preserve immutable consumption', async () => {
    const id = await client();
    const permit = await admit(0, id);
    await permit.start();
    const original = services[0].finishPermit.bind(services[0]);
    vi.spyOn(services[0], 'finishPermit').mockImplementationOnce(
      async (...args) => {
        await original(...args);
        throw Error('lost finish response');
      },
    );
    await expect(
      permit.finish({ routingStarted: true, published: false }),
    ).rejects.toThrow('lost finish');
    const before = await rows(id);
    await permit.finish({ routingStarted: false, published: true });
    expect(await rows(id)).toEqual(before);
  });
  it('old owner cannot start or finish another permit; start is single use', async () => {
    const id = await client();
    const permit = await admit(0, id);
    const row = (await rows(id))[0];
    await expect(
      services[1].startPermit(row.id, 'forged'),
    ).rejects.toMatchObject({ code: 'PREQUOTE_PERMIT_INVALID' });
    await expect(
      services[1].finishPermit(row.id, 'forged', {
        routingStarted: false,
        published: false,
      }),
    ).rejects.toMatchObject({ code: 'PREQUOTE_PERMIT_INVALID' });
    await permit.start();
    await expect(permit.start()).rejects.toMatchObject({
      code: 'PREQUOTE_PERMIT_INVALID',
    });
    await permit.assertReady();
  });
  it('crash during/after routing protects slot beyond publication ownership; concurrent recovery cannot reuse STARTED', async () => {
    await configure({ concurrent: 1 });
    const id = await client();
    const old = await admit(0, id);
    await old.start();
    const row = (await rows(id))[0];
    await wait(5200);
    await expect(old.assertReady()).rejects.toMatchObject({
      code: 'PREQUOTE_PERMIT_INVALID',
    });
    expect((await services[1].admit(id)).admitted).toBe(false);
    await wait(Math.max(0, row.protectedUntil!.getTime() - Date.now() + 100));
    const results = await Promise.all([
      services[0].admit(id),
      services[1].admit(id),
    ]);
    expect(results.filter((r) => r.admitted)).toHaveLength(1);
    await old.finish({ routingStarted: true, published: false });
    await expect(old.start()).rejects.toMatchObject({
      code: 'PREQUOTE_PERMIT_INVALID',
    });
    expect((await rows(id))[0].state).toBe('ABANDONED');
    expect((await rows(id)).filter((r) => r.state === 'RESERVED')).toHaveLength(
      1,
    );
  }, 25000);
  it('real ledger projection validates minute/day exact boundaries without mutating history', async () => {
    const id = await client();
    const permit = await admit(0, id);
    await permit.start();
    await permit.finish({ routingStarted: true, published: false });
    const ledger = await rows(id);
    const start = ledger[0].startedAt!.getTime();
    expect(
      consumptionRetryAt(
        ledger,
        id,
        { ...limits, minute: 1 },
        new Date(start + 59999),
      ),
    ).toEqual(new Date(start + 60000));
    expect(
      consumptionRetryAt(
        ledger,
        id,
        { ...limits, minute: 1 },
        new Date(start + 60000),
      ),
    ).toBeUndefined();
    expect(
      consumptionRetryAt(
        ledger,
        id,
        { ...limits, day: 1 },
        new Date(start + 86400000),
      ),
    ).toBeUndefined();
  });
  it('configuration invalid/divergent and infrastructure failure fail closed', async () => {
    const id = await client();
    configs[0].set('PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS', null);
    await expect(services[0].admit(id)).rejects.toMatchObject({
      code: 'PREQUOTE_CONSUMPTION_UNAVAILABLE',
    });
    configs[0].set('PREQUOTE_GLOBAL_DAILY_ROUTING_UNITS', 999999);
    await expect(services[0].admit(id)).rejects.toMatchObject({
      code: 'PREQUOTE_CONSUMPTION_UNAVAILABLE',
    });
    expect(await rows(id)).toHaveLength(0);
    await configure();
    const { PrismaService } = await import('../dist/prisma/prisma.service.js');
    const db = apps[1].get(PrismaService);
    const original = db.$transaction.bind(db);
    // Let A3 inspect complete; fail the following consumption admission transaction.
    const outage = vi
      .spyOn(db, '$transaction')
      .mockImplementationOnce(original)
      .mockRejectedValueOnce(Error('controlled storage outage'));
    const r = await post(1).expect(503);
    expect(r.body.code).toBe('PREQUOTE_CONSUMPTION_UNAVAILABLE');
    expect(outage).toHaveBeenCalledTimes(2);
    expect(routings[1].calculateRoute).not.toHaveBeenCalled();
  });
  it('disable before start safely cancels; disable during routing permits publication; GET/replay still work', async () => {
    const id = await client();
    const permit = await admit(0, id);
    configs[0].set('PREQUOTE_ENABLED', false);
    await expect(permit.start()).rejects.toMatchObject({
      code: 'PREQUOTE_DISABLED',
    });
    await permit.finish({ routingStarted: false, published: false });
    expect((await rows(id))[0]).toMatchObject({
      state: 'CANCELLED',
      startedAt: null,
    });
    configs[0].set('PREQUOTE_ENABLED', true);
    routings[0].calculateRoute.mockImplementationOnce(async () => {
      configs[0].set('PREQUOTE_ENABLED', false);
      return route();
    });
    const k = key();
    const r = await post(0, k).expect(201);
    await post(0, k).expect(200);
    await request(apps[0].getHttpServer())
      .get(`/api/v1/delivery-prequotes/${r.body.publicId}`)
      .auth(tokens[0], { type: 'bearer' })
      .expect(200);
    await post(0).expect(503);
    expect(routings[0].calculateRoute).toHaveBeenCalledTimes(1);
  });
  it('SQL rejects evidence deletion, unit mutation and repeated state transition', async () => {
    const id = await client();
    const permit = await admit(0, id);
    await permit.start();
    const row = (await rows(id))[0];
    await expect(
      p.prequoteConsumptionPermit.delete({ where: { id: row.id } }),
    ).rejects.toThrow();
    await expect(
      p.prequoteConsumptionPermit.update({
        where: { id: row.id },
        data: { units: 2 },
      }),
    ).rejects.toThrow();
    await permit.finish({ routingStarted: true, published: false });
    await expect(
      p.prequoteConsumptionPermit.update({
        where: { id: row.id },
        data: { state: 'STARTED', finishedAt: null },
      }),
    ).rejects.toThrow();
  });
  it('lost start acknowledgement over HTTP never invokes routing but retains units', async () => {
    const original = services[0].startPermit.bind(services[0]);
    vi.spyOn(services[0], 'startPermit').mockImplementationOnce(
      async (...args) => {
        await original(...args);
        throw Error('controlled lost start acknowledgement');
      },
    );
    const before = (await rows(clients[0])).length;
    await post(0).expect(503);
    expect(routings[0].calculateRoute).not.toHaveBeenCalled();
    const added = (await rows(clients[0])).slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      state: 'FINISHED',
      units: 1,
      routingReported: false,
    });
    expect(added[0].startedAt).not.toBeNull();
  });
  it('new flow has no logistics/financial effects and safe event logs', async () => {
    expect(await counts()).toEqual(baseline);
    const all = logs.join('\n');
    for (const token of tokens) expect(all).not.toContain(token);
    for (const forbidden of [
      'latitude',
      'longitude',
      'ownerHash',
      'clientSecret',
      'secretHash',
    ])
      expect(all).not.toContain(forbidden);
    for (const event of [
      'PREQUOTE_ADMISSION_DENIED',
      'PREQUOTE_CONSUMPTION_STARTED',
      'PREQUOTE_CONSUMPTION_FINISHED',
      'PREQUOTE_PERMIT_RECOVERED',
    ])
      expect(all).toContain(event);
  });
});
