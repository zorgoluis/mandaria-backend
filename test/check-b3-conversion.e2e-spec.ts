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
import { PrismaClient, Prisma } from '@prisma/client';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import { fundProvider } from './support/credits.js';
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
const key = () => `b3-${randomUUID()}`;
const route = () => ({
  distanceMeters: 1200,
  durationSeconds: 60,
  routingProvider: 'b3-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'b3-controlled',
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
let second: INestApplication;
let old: INestApplication;
let oldToken: string;
const evidence: Record<string, unknown> = {};
let zoneId: string;
let planId: string;

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
  scopes = [
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

  await p.integrationClient.createMany({
    data: clients.map((id, i) => ({
      id,
      code: `B3_${run}_${i}`,
      name: 'B3 fixture',
    })),
  });
  await p.integrationCredential.createMany({
    data: credentials.map((id, i) => ({
      id,
      clientId: clients[i],
      secretHash: randomBytes(32).toString('hex'),
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
  tokens.push(await sign(0), await sign(1));
  const zone = await p.serviceZone.create({
    data: {
      code: `B3_${run}`,
      name: 'B3 zone',
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
beforeEach(() => {
  vi.restoreAllMocks();
  routing.calculateRoute.mockReset().mockImplementation(async () => route());
  consumption.admit.mockReset().mockResolvedValue({ admitted: true, permit });
  permit.start.mockReset().mockResolvedValue();
  permit.finish.mockReset().mockResolvedValue();
  config.set('PREQUOTE_CONVERSION_ENABLED', true);
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
  const finalLogText = logs.join('\n');
  for (const value of [
    ...tokens,
    oldToken,
    'receipt-demo',
    'order-demo',
    '0000000000',
    'merchantConfirmation',
    'synthetic-bank',
  ])
    if (value) expect(finalLogText).not.toContain(value);
  evidence.finalLogs = {
    entries: logs.length,
    privacyAssertions: true,
    includesOldToken: true,
  };
  mkdirSync('.tmp/b3', { recursive: true });
  writeFileSync(
    '.tmp/b3/focused-evidence.json',
    JSON.stringify(evidence, null, 2),
  );
  await second?.close();
  await old?.close();
  await app?.close();
  await p.$disconnect();
});
const conversionBody = () => ({
  conditionsVersion: 1,
  deliveryRequest: {
    serviceType: 'LOCAL_DELIVERY',
    externalReference: 'b3-order',
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
const noKey = async (k: string) => expect(await execution(k)).toBeNull();
// Two independent Nest dependency graphs (each owns its Prisma pool), plus compiled B1.
async function boot(directory: string) {
  const load = (file: string) =>
    import(/* @vite-ignore */ pathToFileURL(resolve(directory, file)).href);
  const { AppModule } = await load('app.module.js');
  const { setup } = await load('setup.js');
  const { ROUTING_PROVIDER } = await load('routing/routing.types.js');
  const { PREQUOTE_CONSUMPTION } = await load(
    'delivery-prequotes/prequote-consumption.js',
  );
  const ref = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ROUTING_PROVIDER)
    .useValue(routing)
    .overrideProvider(PREQUOTE_CONSUMPTION)
    .useValue(consumption)
    .setLogger(logger)
    .compile();
  const result = ref.createNestApplication({ logger, bodyParser: false });
  setup(result);
  await result.init();
  result.get(ConfigService).set('PREQUOTE_CONVERSION_ENABLED', true);
  return result;
}
beforeAll(async () => {
  second = await boot('dist');
  if (!process.env.B3_OLD_DIST)
    execFileSync(process.execPath, ['scripts/prepare-prequote-b3-legacy.mjs'], {
      stdio: 'pipe',
    });
  old = await boot(process.env.B3_OLD_DIST ?? '.tmp/b3/old/dist');
  oldToken = await sign(0, [
    'deliveries:create',
    'deliveries:read',
    'deliveries:cancel',
    'quotes:create',
    'quotes:read',
    'quotes:accept',
  ]);
}, 60000);
const other = (
  id: string,
  k: string,
  b: object = conversionBody(),
  t = tokens[0],
) =>
  request(second.getHttpServer())
    .post(`/api/v1/delivery-prequotes/${id}/convert`)
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
async function assertWinner(id: string, expected = 1) {
  const cs = await p.prequoteConversion.findMany({
    where: { prequote: { publicId: id } },
  });
  expect(cs).toHaveLength(expected);
  for (const c of cs) {
    expect(
      await p.deliveryRequest.count({ where: { id: c.deliveryRequestId } }),
    ).toBe(1);
    expect(
      await p.deliveryQuote.count({
        where: { deliveryRequestId: c.deliveryRequestId },
      }),
    ).toBe(1);
    expect(
      await p.apiIdempotencyRecord.count({
        where: { id: c.idempotencyRecordId, resourceId: c.id },
      }),
    ).toBe(1);
    expect(
      await p.apiIdempotencyExecution.count({
        where: { recordId: c.idempotencyRecordId },
      }),
    ).toBe(0);
    expect(
      await p.dispatch.count({
        where: {
          OR: [
            { deliveryRequestId: c.deliveryRequestId },
            { deliveryQuoteId: c.deliveryQuoteId },
          ],
        },
      }),
    ).toBe(0);
  }
  return cs[0];
}
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function blocked(id: string, ms: number, action: () => Promise<void>) {
  let ready!: () => void;
  const locked = new Promise<void>((r) => {
    ready = r;
  });
  const hold = p.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DeliveryPrequote" WHERE "publicId"=${id} FOR UPDATE`;
      ready();
      await pause(ms);
    },
    { timeout: ms + 5000 },
  );
  await locked;
  try {
    await action();
  } finally {
    await hold;
  }
}
describe('B3 independent instances and durable winners', () => {
  it('same key/body, changed body and competing keys have one durable winner', async () => {
    for (const mode of ['same', 'different-body', 'different-keys']) {
      const id = await emit(),
        k = key(),
        k2 = mode === 'different-keys' ? key() : k;
      const b = conversionBody();
      if (mode === 'different-body')
        b.deliveryRequest.externalReference = 'different';
      let responses: Awaited<ReturnType<typeof convert>>[] = [];
      await blocked(id, 200, async () => {
        responses = await Promise.all([convert(id, k), other(id, k2, b)]);
      });
      expect(responses.map((r) => r.status).sort()).toEqual(
        mode === 'same' ? [200, 201] : [201, 409],
      );
      const c = await assertWinner(id);
      if (mode === 'different-keys')
        expect(
          await p.apiIdempotencyRecord.count({
            where: { integrationClientId: clients[0], key: { in: [k, k2] } },
          }),
        ).toBe(1);
      evidence[mode] = {
        statuses: responses.map((r) => r.status),
        winner: !!c,
      };
    }
  });
  it('namespace prevents another MPQ or operation; same text in different owners is independent', async () => {
    const id = await emit(),
      id2 = await emit(),
      k = key();
    expect((await convert(id, k)).status).toBe(201);
    expect((await other(id2, k)).status).toBe(409);
    await assertWinner(id2, 0);
    expect((await post(k)).status).toBe(409);
    const emitted = await post(key(), body, tokens[1]);
    expect(emitted.status).toBe(201);
    expect(
      (await other(emitted.body.publicId, k, conversionBody(), tokens[1]))
        .status,
    ).toBe(201);
    await assertWinner(emitted.body.publicId);
    expect(await p.apiIdempotencyRecord.count({ where: { key: k } })).toBe(2);
  });
  it('real transaction timeout rolls back; another instance retries same intent', async () => {
    const id = await emit(),
      k = key(),
      before = await counts();
    await blocked(id, 6200, async () => {
      const r = await convert(id, k);
      expect(r.status).toBe(503);
      expect(r.body.code).toBe('PREQUOTE_CONVERSION_UNAVAILABLE');
    });
    await noKey(k);
    await assertWinner(id, 0);
    expect(await counts()).toEqual(before);
    expect((await other(id, k)).status).toBe(201);
    await assertWinner(id);
  }, 20000);
  it('lost response is recovered from the other instance without a second result', async () => {
    const id = await emit(),
      k = key();
    const { PrequoteConversionService } =
      await import('../dist/delivery-prequotes/prequote-conversion.service.js');
    const service = app.get(PrequoteConversionService);
    const spy = vi
      .spyOn(
        service as unknown as {
          load: (...args: unknown[]) => Promise<unknown>;
        },
        'load',
      )
      .mockRejectedValueOnce(Error('B3 response transport loss'));
    try {
      expect((await convert(id, k)).status).toBe(500);
    } finally {
      spy.mockRestore();
    }
    const c = await assertWinner(id);
    const r = await other(id, k);
    expect(r.status).toBe(200);
    expect(
      (
        await p.deliveryRequest.findUniqueOrThrow({
          where: { id: c.deliveryRequestId },
        })
      ).publicId,
    ).toBe(r.body.deliveryRequestPublicId);
  });
  it('bounded contention: 16 keys on one MPQ and 8 independent MPQs', async () => {
    const id = await emit(),
      keys = Array.from({ length: 16 }, () => key()),
      start = performance.now();
    const rs = await Promise.all(
      keys.map((k, i) => (i % 2 ? other(id, k) : convert(id, k))),
    );
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(15);
    await assertWinner(id);
    expect(
      await p.apiIdempotencyRecord.count({ where: { key: { in: keys } } }),
    ).toBe(1);
    const competingMs = performance.now() - start;
    const ids = [];
    for (let i = 0; i < 8; i++) ids.push(await emit());
    const start2 = performance.now();
    const separate = await Promise.all(
      ids.map((v, i) => (i % 2 ? other(v, key()) : convert(v))),
    );
    expect(separate.every((r) => r.status === 201)).toBe(true);
    for (const v of ids) await assertWinner(v);
    evidence.contention = {
      competitors: 16,
      winners: 1,
      conflicts: 15,
      competingMs,
      independent: 8,
      independentMs: performance.now() - start2,
    };
  }, 30000);
});

type Source = Prisma.DeliveryPrequoteGetPayload<Record<string, never>>;
type SqlOptions = {
  manifest?: {
    stopIds?: string[];
    packageIds?: string[];
    financialContextId?: string;
  };
  omitPackage?: boolean;
  omitStop?: boolean;
  wrongContext?: boolean;
  extraChild?: boolean;
  after?: (
    tx: Prisma.TransactionClient,
    c: Prisma.PrequoteConversionGetPayload<Record<string, never>>,
  ) => Promise<void>;
  before?: (tx: Prisma.TransactionClient) => Promise<void>;
};
async function source() {
  return p.deliveryPrequote.findUniqueOrThrow({
    where: { publicId: await emit() },
  });
}
async function construct(q: Source, k: string, options: SqlOptions = {}) {
  return p.$transaction(
    async (tx) => {
      if (options.before) await options.before(tx);
      const id = randomUUID(),
        rid = randomUUID(),
        qid = randomUUID(),
        stops = [randomUUID(), randomUUID()],
        packages = [randomUUID()],
        fid = randomUUID();
      const record = await tx.apiIdempotencyRecord.create({
        data: {
          integrationClientId: clients[0],
          key: k,
          operation: 'delivery_prequotes.convert',
          resourceType: 'PrequoteConversion',
          resourceId: id,
          requestHash: 'a'.repeat(64),
        },
      });
      const b = conversionBody();
      const c = await tx.prequoteConversion.create({
        data: {
          id,
          prequoteId: q.id,
          integrationClientId: clients[0],
          deliveryRequestId: rid,
          deliveryQuoteId: qid,
          idempotencyRecordId: record.id,
          ...b.merchantConfirmation,
          collectionPayer: 'RECIPIENT',
          collectionMethod: 'CASH',
          collectionDueAt: 'DELIVERY',
          collectionComponent: 'DELIVERY_FEE',
          stopIds: stops,
          packageIds: packages,
          financialContextId: fid,
          ...options.manifest,
        },
      });
      const { normalizeDeliveryRequest } =
        await import('../dist/delivery-requests/delivery-requests.service.js');
      const { nextPublicId } = await import('../dist/common/public-id.js');
      const normalized = normalizeDeliveryRequest(
        b.deliveryRequest as Parameters<typeof normalizeDeliveryRequest>[0],
      );
      await tx.deliveryRequest.create({
        data: {
          id: rid,
          publicId: await nextPublicId(tx, 'MDR'),
          integrationClientId: clients[0],
          serviceType: q.serviceType,
          createdAt: c.convertedAt,
          requestedAt: c.convertedAt,
          externalReference: 'b3-direct',
          stops: {
            create: normalized.stops
              .slice(0, options.omitStop ? 1 : 2)
              .map((s, i) => ({ ...s, id: stops[i] })),
          },
          packages: {
            create: options.omitPackage
              ? []
              : normalized.packages.map((v, i) => ({ ...v, id: packages[i] })),
          },
          financialContext: {
            create: {
              ...normalized.financialContext,
              id: options.wrongContext ? randomUUID() : fid,
            },
          },
        },
      });
      if (options.extraChild)
        await tx.deliveryPackage.create({
          data: {
            id: randomUUID(),
            deliveryRequestId: rid,
            category: 'FOOD',
            quantity: 1,
            description: 'extra',
          },
        });
      await tx.deliveryQuote.create({
        data: {
          id: qid,
          publicId: await nextPublicId(tx, 'MQ'),
          deliveryRequestId: rid,
          serviceType: q.serviceType,
          serviceZoneId: q.serviceZoneId,
          ratePlanId: q.ratePlanId,
          rateBandId: q.rateBandId,
          distanceMeters: q.distanceMeters,
          durationSeconds: q.durationSeconds,
          amount: q.amount,
          currency: q.currency,
          routingProvider: q.routingProvider,
          routeCalculatedAt: q.routeCalculatedAt,
          expiresAt: q.expiresAt,
          createdAt: c.convertedAt,
        },
      });
      if (options.after) await options.after(tx, c);
      return c;
    },
    { timeout: 10000 },
  );
}
describe('B3 manifest SQL and temporal constraints', () => {
  it.each([
    'duplicate-stops',
    'duplicate-packages',
    'empty-stops',
    'empty-packages',
    'missing-stop',
    'missing-package',
    'extra-child',
    'wrong-context',
    'foreign-child',
  ])('%s cannot commit', async (attack) => {
    const q = await source(),
      k = key(),
      before = await counts(),
      x = randomUUID();
    const options: SqlOptions = {};
    if (attack === 'duplicate-stops') options.manifest = { stopIds: [x, x] };
    if (attack === 'duplicate-packages')
      options.manifest = { packageIds: [x, x] };
    if (attack === 'empty-stops') options.manifest = { stopIds: [] };
    if (attack === 'empty-packages') options.manifest = { packageIds: [] };
    if (attack === 'missing-stop') options.omitStop = true;
    if (attack === 'missing-package') options.omitPackage = true;
    if (attack === 'extra-child') options.extraChild = true;
    if (attack === 'wrong-context') options.wrongContext = true;
    if (attack === 'foreign-child')
      options.manifest = { packageIds: [(await converted()).c.packageIds[0]] };
    const beforeAttempt = attack === 'foreign-child' ? await counts() : before;
    await expect(construct(q, k, options)).rejects.toThrow();
    await noKey(k);
    await assertWinner(q.publicId, 0);
    expect(await counts()).toEqual(beforeAttempt);
  });
  it('complete direct SQL construction with savepoint and constraints immediate commits', async () => {
    const q = await source(),
      k = key();
    await construct(q, k, {
      after: async (tx, c) => {
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$executeRawUnsafe('SAVEPOINT b3_valid');
        await expect(
          tx.deliveryPackage.create({
            data: {
              id: randomUUID(),
              deliveryRequestId: c.deliveryRequestId,
              category: 'FOOD',
              quantity: 1,
              description: 'later',
            },
          }),
        ).rejects.toThrow();
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT b3_valid');
      },
    });
    await assertWinner(q.publicId);
  });
  it('constraints immediate before construction fail closed without orphan key', async () => {
    const q = await source(),
      k = key();
    await expect(
      construct(q, k, {
        before: async (tx) => {
          await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        },
      }),
    ).rejects.toThrow();
    await noKey(k);
    await assertWinner(q.publicId, 0);
  });
  it('direct SQL early validation can cross expiry; no renewal, reuse or dispatch', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1600);
    const q = await source(),
      k = key();
    const c = await construct(q, k, {
      after: async (tx) => {
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await tx.$queryRaw`SELECT 1 FROM pg_sleep(GREATEST(0,(SELECT extract(epoch FROM ("expiresAt"-(clock_timestamp() AT TIME ZONE 'UTC'))) FROM "DeliveryPrequote" WHERE id=${q.id}::uuid))+0.15)`;
      },
    });
    const [clock] = await p.$queryRaw<
      { now: Date }[]
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
    expect(clock.now >= q.expiresAt).toBe(true);
    expect(
      (
        await p.deliveryQuote.findUniqueOrThrow({
          where: { id: c.deliveryQuoteId },
        })
      ).expiresAt,
    ).toEqual(q.expiresAt);
    expect((await convert(q.publicId)).body.code).toBe(
      'PREQUOTE_ALREADY_CONVERTED',
    );
    await expect(
      p.$executeRaw`UPDATE "DeliveryQuote" SET status='ACCEPTED',"acceptedAt"=now() WHERE id=${c.deliveryQuoteId}::uuid`,
    ).rejects.toThrow();
    await assertWinner(q.publicId);
    evidence.immediateTemporal = {
      commitAfterExpiry: true,
      expiryUnchanged: true,
      dispatchBlocked: true,
      serviceUsesDeferred: true,
    };
  }, 10000);
});
async function legacyCreate(application: INestApplication) {
  const agent = request(application.getHttpServer());
  const r = await agent
    .post('/api/v1/delivery-requests')
    .auth(oldToken, { type: 'bearer' })
    .set('Idempotency-Key', key())
    .send(conversionBody().deliveryRequest);
  expect(r.status).toBe(201);
  const q = await agent
    .post(`/api/v1/delivery-requests/${r.body.publicId}/quotes`)
    .auth(oldToken, { type: 'bearer' })
    .send({});
  expect(q.status).toBe(201);
  return { agent, r, q };
}
let legacyDispatchId: string;
let legacyRequestId: string;
let legacyQuoteId: string;
describe('B3 previous compiled writer, economics and barrier mutations', () => {
  it('B1 binary creates/quotes/accepts ordinary legacy with B2 database guards', async () => {
    await ensureTestCreditPolicies(p);
    const { agent, r, q } = await legacyCreate(old);
    expect(
      (
        await agent
          .post(`/api/v1/delivery-quotes/${q.body.publicId}/accept`)
          .auth(oldToken, { type: 'bearer' })
          .send({})
      ).status,
    ).toBe(200);
    const requestRow = await p.deliveryRequest.findUniqueOrThrow({
      where: { publicId: r.body.publicId },
    });
    const quoteRow = await p.deliveryQuote.findUniqueOrThrow({
      where: { publicId: q.body.publicId },
    });
    const d = await p.dispatch.findUniqueOrThrow({
      where: { deliveryQuoteId: quoteRow.id },
    });
    legacyDispatchId = d.id;
    legacyRequestId = requestRow.id;
    legacyQuoteId = quoteRow.id;
    expect(
      await p.prequoteConversion.count({
        where: { deliveryRequestId: requestRow.id },
      }),
    ).toBe(0);
    evidence.oldBinary = {
      revision: '5978807270c038d9d7e555ad985ee7bfe35718a5',
      compiled: true,
      legacyCreateQuoteAccept: true,
    };
  });
  it('B1 accept cannot dispatch converted quote; expired requote also rolls back', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 2000);
    const { id, c } = await converted();
    const agent = request(old.getHttpServer());
    const accepted = await agent
      .post(`/api/v1/delivery-quotes/${c.deliveryQuote.publicId}/accept`)
      .auth(oldToken, { type: 'bearer' })
      .send({});
    expect([409, 500]).toContain(accepted.status);
    await assertWinner(id);
    expect(
      (
        await p.deliveryQuote.findUniqueOrThrow({
          where: { id: c.deliveryQuoteId },
        })
      ).status,
    ).toBe('OFFERED');
    await pause(2100);
    const before = await counts();
    const requote = await agent
      .post(`/api/v1/delivery-requests/${c.deliveryRequest.publicId}/quotes`)
      .auth(oldToken, { type: 'bearer' })
      .send({});
    expect([409, 500]).toContain(requote.status);
    expect(await counts()).toEqual(before);
    expect(
      (
        await p.deliveryQuote.findUniqueOrThrow({
          where: { id: c.deliveryQuoteId },
        })
      ).status,
    ).toBe('OFFERED');
    evidence.oldConverted = {
      acceptStatus: accepted.status,
      requoteStatus: requote.status,
      noDispatch: true,
      quoteRollback: true,
    };
  });
  it('SQL update dispatch by either FK and changing quote FK cannot escape origin', async () => {
    const { c } = await converted();
    for (const statement of [
      () =>
        p.$executeRaw`UPDATE "Dispatch" SET "deliveryRequestId"=${c.deliveryRequestId}::uuid WHERE id=${legacyDispatchId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "Dispatch" SET "deliveryQuoteId"=${c.deliveryQuoteId}::uuid WHERE id=${legacyDispatchId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "DeliveryQuote" SET "deliveryRequestId"=${legacyRequestId}::uuid WHERE id=${c.deliveryQuoteId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "DeliveryRequest" SET "integrationClientId"=${clients[1]}::uuid WHERE id=${c.deliveryRequestId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "DeliveryStop" SET "deliveryRequestId"=${legacyRequestId}::uuid WHERE id=${c.stopIds[0]}::uuid`,
      () =>
        p.$executeRaw`UPDATE "DeliveryPackage" SET "deliveryRequestId"=${legacyRequestId}::uuid WHERE id=${c.packageIds[0]}::uuid`,
      () =>
        p.$executeRaw`DELETE FROM "DeliveryStop" WHERE id=${c.stopIds[0]}::uuid`,
      () =>
        p.$executeRaw`DELETE FROM "DeliveryFinancialContext" WHERE id=${c.financialContextId}::uuid`,
    ])
      await expect(statement()).rejects.toThrow();
    expect(
      (await p.dispatch.findUniqueOrThrow({ where: { id: legacyDispatchId } }))
        .deliveryRequestId,
    ).toBe(legacyRequestId);
  });
  it.each([
    'stopIds',
    'packageIds',
    'goodsPaymentReference',
    'orderAcceptanceReference',
    'integrationClientId',
    'deliveryRequestId',
    'deliveryQuoteId',
    'prequoteId',
    'idempotencyRecordId',
  ])('conversion %s immutable', async (field) => {
    const { c } = await converted();
    const value = field.endsWith('Ids') ? [randomUUID()] : randomUUID();
    await expect(
      p.prequoteConversion.update({
        where: { id: c.id },
        data: { [field]: value },
      }),
    ).rejects.toThrow();
    await assertWinner(c.prequote.publicId);
  });
  it.each(['key', 'operation', 'requestHash', 'resourceId', 'resourceType'])(
    'idempotency %s immutable',
    async (field) => {
      const { c } = await converted();
      await expect(
        p.apiIdempotencyRecord.update({
          where: { id: c.idempotencyRecordId },
          data: {
            [field]: field === 'resourceId' ? randomUUID() : 'forged-value',
          },
        }),
      ).rejects.toThrow();
    },
  );
  it.each([
    'amount',
    'currency',
    'expiresAt',
    'distanceMeters',
    'ratePlanId',
    'routeCalculatedAt',
  ])('quote %s immutable after commit', async (field) => {
    const { c } = await converted();
    const value =
      field === 'amount'
        ? '1.00'
        : field === 'currency'
          ? 'USD'
          : field === 'distanceMeters'
            ? 1
            : field === 'ratePlanId'
              ? randomUUID()
              : new Date();
    await expect(
      p.deliveryQuote.update({
        where: { id: c.deliveryQuoteId },
        data: { [field]: value },
      }),
    ).rejects.toThrow();
  });
  it('nonempty credits ledger assignments dispatch outbox and legacy records preserved', async () => {
    const provider = await p.deliveryProvider.create({
      data: {
        name: 'B3 preservation',
        code: 'B3_' + run,
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
    const { hash } = await import('argon2');
    const user = await p.user.create({
      data: {
        email: 'b3-driver-' + run + '@fixture.test',
        role: 'DRIVER',
        active: true,
        passwordHash: await hash(randomBytes(32).toString('hex')),
      },
    });
    try {
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
          identifier: 'B3-' + run,
          type: 'MOTORCYCLE',
        },
      });
      await p.dispatchCandidate.create({
        data: {
          dispatchId: legacyDispatchId,
          providerId: provider.id,
          offeredAt: new Date(),
        },
      });
      const { DispatchService } =
        await import('../dist/dispatch/dispatch.service.js');
      const { DeliveryAssignmentsService } =
        await import('../dist/delivery-assignments/delivery-assignments.service.js');
      await app
        .get(DispatchService)
        .claim(legacyDispatchId, provider.id, user.id);
      await app
        .get(DeliveryAssignmentsService)
        .create(
          legacyDispatchId,
          { driverId: driver.id, vehicleId: vehicle.id },
          { providerId: provider.id, userId: user.id },
        );
      await app
        .get(DispatchService)
        .complete(legacyDispatchId, provider.id, user.id);
      const digest = async () => {
        const result: Record<string, { count: number; hash: string }> = {};
        for (const table of [
          'CreditAccount',
          'CreditLedgerEntry',
          'Dispatch',
          'DeliveryAssignment',
          'B2bOutboxEvent',
          'ApiIdempotencyExecution',
          'PrequoteConsumptionPermit',
        ]) {
          const rows = await p.$queryRawUnsafe<unknown[]>(
            `SELECT * FROM "${table}" ORDER BY 1`,
          );
          result[table] = {
            count: rows.length,
            hash: createHash('sha256')
              .update(
                JSON.stringify(rows, (_k, v) =>
                  typeof v === 'bigint' ? v.toString() : v,
                ),
              )
              .digest('hex'),
          };
        }
        for (const [table, id] of [
          ['DeliveryRequest', legacyRequestId],
          ['DeliveryQuote', legacyQuoteId],
        ]) {
          const rows = await p.$queryRawUnsafe<unknown[]>(
            `SELECT * FROM "${table}" WHERE id=$1::uuid`,
            id,
          );
          result[table] = {
            count: rows.length,
            hash: createHash('sha256')
              .update(JSON.stringify(rows))
              .digest('hex'),
          };
        }
        return result;
      };
      const ids = [];
      for (let i = 0; i < 3; i++) ids.push(await emit());
      const before = await digest();
      for (const table of [
        'CreditAccount',
        'CreditLedgerEntry',
        'Dispatch',
        'DeliveryAssignment',
        'B2bOutboxEvent',
        'DeliveryRequest',
        'DeliveryQuote',
      ])
        expect(before[table].count).toBeGreaterThan(0);
      const calls = [
        routing.calculateRoute.mock.calls.length,
        consumption.admit.mock.calls.length,
        permit.start.mock.calls.length,
        permit.finish.mock.calls.length,
      ];
      for (const id of ids) expect((await convert(id)).status).toBe(201);
      expect([
        routing.calculateRoute.mock.calls.length,
        consumption.admit.mock.calls.length,
        permit.start.mock.calls.length,
        permit.finish.mock.calls.length,
      ]).toEqual(calls);
      const after = await digest();
      expect(after).toEqual(before);
      evidence.preservation = { before, after, equal: true };
    } finally {
      await p.user.update({ where: { id: user.id }, data: { active: false } });
    }
  }, 30000);
});

describe('B3 reads cancellation authorization and metadata', () => {
  it('concurrent cancel and replay yield coherent pairs; source cannot be reused', async () => {
    const { id, k, r, c } = await converted();
    const reads = Array.from({ length: 8 }, (_, i) =>
      i % 2 ? other(id, k) : convert(id, k),
    );
    const cancel = api()
      .post(
        `/api/v1/delivery-requests/${r.body.deliveryRequestPublicId}/cancel`,
      )
      .auth(tokens[0], { type: 'bearer' })
      .send({ reason: 'B3 fixture cancellation' });
    const results = await Promise.all([...reads, cancel]);
    expect(results.at(-1)?.status).toBe(200);
    for (const read of results.slice(0, -1)) {
      expect(read.status).toBe(200);
      expect(['CREATED/OFFERED', 'CANCELLED/CANCELLED']).toContain(
        read.body.deliveryRequestStatus + '/' + read.body.quote.status,
      );
    }
    const replay = await other(id, k);
    expect(replay.body.deliveryRequestStatus).toBe('CANCELLED');
    expect(replay.body.quote.status).toBe('CANCELLED');
    expect((await get(id)).body.status).toBe('CONVERTED');
    expect((await convert(id)).body.code).toBe('PREQUOTE_ALREADY_CONVERTED');
    expect((await assertWinner(id)).id).toBe(c.id);
    await expect(
      p.prequoteConversion.delete({ where: { id: c.id } }),
    ).rejects.toThrow();
  });
  it('zone geometry and names change without repricing; inactive flag off still replays', async () => {
    const id = await emit(),
      k = key(),
      z = await p.serviceZone.findUniqueOrThrow({ where: { id: zoneId } });
    try {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: {
          name: 'B3 renamed',
          code: 'B3_CHANGED_' + run,
          boundary: {
            type: 'Polygon',
            coordinates: [
              [
                [1, 1],
                [2, 1],
                [2, 2],
                [1, 2],
                [1, 1],
              ],
            ],
          },
          minLatitude: 1,
          maxLatitude: 2,
          minLongitude: 1,
          maxLongitude: 2,
        },
      });
      const r = await convert(id, k);
      expect(r.status).toBe(201);
      expect(r.body.quote.serviceZone).toEqual({ code: z.code, name: z.name });
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { status: 'INACTIVE' },
      });
      config.set('PREQUOTE_CONVERSION_ENABLED', false);
      second.get(ConfigService).set('PREQUOTE_CONVERSION_ENABLED', false);
      expect((await other(id, k)).status).toBe(200);
      await assertWinner(id);
    } finally {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: {
          name: z.name,
          code: z.code,
          boundary: z.boundary as Prisma.InputJsonValue,
          minLatitude: z.minLatitude,
          maxLatitude: z.maxLatitude,
          minLongitude: z.minLongitude,
          maxLongitude: z.maxLongitude,
          status: 'ACTIVE',
        },
      });
      second.get(ConfigService).set('PREQUOTE_CONVERSION_ENABLED', true);
    }
  });
  it.each([
    'credential-expired',
    'credential-revoked',
    'client-suspended',
    'client-revoked',
  ])('replay denies %s', async (state) => {
    const { id, k } = await converted();
    try {
      if (state === 'credential-expired')
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { expiresAt: new Date(0) },
        });
      else if (state === 'credential-revoked')
        await p.integrationCredential.update({
          where: { id: credentials[0] },
          data: { status: 'REVOKED', revokedAt: new Date() },
        });
      else
        await p.integrationClient.update({
          where: { id: clients[0] },
          data: {
            status: state === 'client-suspended' ? 'SUSPENDED' : 'REVOKED',
          },
        });
      expect((await other(id, k)).status).toBe(401);
      await assertWinner(id);
    } finally {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { expiresAt: null, status: 'ACTIVE', revokedAt: null },
      });
      await p.integrationClient.update({
        where: { id: clients[0] },
        data: { status: 'ACTIVE' },
      });
    }
  });
  it('nested PII, arbitrary shipping amount and invalid references/dates reject before writes', async () => {
    const id = await emit();
    const variants = [
      {
        ...conversionBody(),
        merchantConfirmation: {
          ...conversionBody().merchantConfirmation,
          bankAccount: 'synthetic-bank',
        },
      },
      {
        ...conversionBody(),
        deliveryCollectionInstruction: {
          ...conversionBody().deliveryCollectionInstruction,
          amount: '1.00',
        },
      },
      {
        ...conversionBody(),
        merchantConfirmation: {
          ...conversionBody().merchantConfirmation,
          goodsPaymentReference: '  ',
        },
      },
      {
        ...conversionBody(),
        merchantConfirmation: {
          ...conversionBody().merchantConfirmation,
          orderAcceptedAt: '2026-01-01T00:00:00',
        },
      },
      {
        ...conversionBody(),
        merchantConfirmation: {
          ...conversionBody().merchantConfirmation,
          goodsPaymentConfirmedAt: '2099-01-01T00:00:00Z',
        },
      },
    ];
    for (const b of variants) {
      const k = key();
      expect((await convert(id, k, b)).status).toBe(400);
      await noKey(k);
    }
    await assertWinner(id, 0);
  });
  it('captured current and old logs contain no bodies contacts references or tokens', () => {
    const text = logs.join('\n');
    for (const value of [
      ...tokens,
      'receipt-demo',
      'order-demo',
      '0000000000',
      'merchantConfirmation',
      'synthetic-bank',
    ])
      expect(text).not.toContain(value);
    evidence.logs = { privacyAssertions: true, fullLogsPublished: false };
  });
});
describe('B3 visibility and construction attack extensions', () => {
  it('uncommitted winner is invisible to GET; concurrent reader sees complete links after commit', async () => {
    const id = await emit(),
      k = key();
    let result: Awaited<ReturnType<typeof convert>> | undefined;
    await blocked(id, 350, async () => {
      const pending = convert(id, k).then((r) => {
        result = r;
      });
      await pause(70);
      const view = await get(id);
      expect(view.body.status).toBe('OFFERED');
      expect(view.body.deliveryRequestPublicId).toBeNull();
      await assertWinner(id, 0);
      await pending;
    });
    expect(result?.status).toBe(201);
    const view = await get(id);
    expect(view.body.status).toBe('CONVERTED');
    expect(view.body.deliveryRequestPublicId).toBe(
      result?.body.deliveryRequestPublicId,
    );
  });
  it('building then forcing immediate validation does not permit later snapshot or manifest edits', async () => {
    const q = await source(),
      k = key();
    await construct(q, k, {
      after: async (tx, c) => {
        await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        for (const action of [
          () =>
            tx.$executeRaw`UPDATE "DeliveryQuote" SET amount=1 WHERE id=${c.deliveryQuoteId}::uuid`,
          () =>
            tx.$executeRaw`UPDATE "PrequoteConversion" SET "financialContextId"=${randomUUID()}::uuid WHERE id=${c.id}::uuid`,
          () =>
            tx.$executeRaw`DELETE FROM "DeliveryFinancialContext" WHERE id=${c.financialContextId}::uuid`,
        ]) {
          await tx.$executeRawUnsafe('SAVEPOINT b3_guard');
          await expect(action()).rejects.toThrow();
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT b3_guard');
        }
      },
    });
    await assertWinner(q.publicId);
  });
  it('legacy resources and their children created before origin cannot be adopted', async () => {
    const q = await source(),
      k = key(),
      before = await counts();
    await expect(
      p.$transaction(async (tx) => {
        const rid = randomUUID(),
          cid = randomUUID(),
          qid = randomUUID();
        const record = await tx.apiIdempotencyRecord.create({
          data: {
            integrationClientId: clients[0],
            key: k,
            operation: 'delivery_prequotes.convert',
            resourceType: 'PrequoteConversion',
            resourceId: cid,
            requestHash: 'a'.repeat(64),
          },
        });
        const { nextPublicId } = await import('../dist/common/public-id.js');
        await tx.deliveryRequest.create({
          data: {
            id: rid,
            publicId: await nextPublicId(tx, 'MDR'),
            integrationClientId: clients[0],
            stops: {
              create: conversionBody().deliveryRequest
                .stops as Prisma.DeliveryStopCreateWithoutDeliveryRequestInput[],
            },
          },
        });
        await tx.prequoteConversion.create({
          data: {
            id: cid,
            prequoteId: q.id,
            deliveryRequestId: rid,
            deliveryQuoteId: qid,
            integrationClientId: clients[0],
            idempotencyRecordId: record.id,
            ...conversionBody().merchantConfirmation,
            collectionPayer: 'RECIPIENT',
            collectionMethod: 'CASH',
            collectionDueAt: 'DELIVERY',
            collectionComponent: 'DELIVERY_FEE',
            stopIds: [randomUUID(), randomUUID()],
            packageIds: [randomUUID()],
            financialContextId: randomUUID(),
          },
        });
      }),
    ).rejects.toThrow();
    await noKey(k);
    expect(await counts()).toEqual(before);
  });
  it('all price/publish paths remain unused during conversion and replay', async () => {
    const id = await emit(),
      k = key();
    const pricing = await import('../dist/pricing/quote-pricing.js');
    const { PrequotePersistenceService } =
      await import('../dist/delivery-prequotes/prequote-persistence.service.js');
    const prepare = vi.spyOn(pricing, 'prepareQuotePricing'),
      evaluate = vi.spyOn(pricing, 'evaluateQuotePrice');
    const publish = vi.spyOn(app.get(PrequotePersistenceService), 'publish');
    const before = [
      routing.calculateRoute.mock.calls.length,
      consumption.admit.mock.calls.length,
    ];
    expect((await convert(id, k)).status).toBe(201);
    expect((await other(id, k)).status).toBe(200);
    expect(prepare).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect([
      routing.calculateRoute.mock.calls.length,
      consumption.admit.mock.calls.length,
    ]).toEqual(before);
  });
  it('scope removed from credential blocks previously authorized replay', async () => {
    const { id, k } = await converted();
    const original = await p.integrationCredential.findUniqueOrThrow({
      where: { id: credentials[0] },
    });
    try {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: {
          scopes: original.scopes.filter((s) => s !== 'prequotes:convert'),
        },
      });
      expect((await other(id, k)).status).toBe(403);
    } finally {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { scopes: original.scopes },
      });
    }
  });
});
describe('B3 cross-resource concurrency', () => {
  it('same key concurrently targeting different MPQs persists just one result', async () => {
    const ids = [await emit(), await emit()],
      k = key();
    const rs = await Promise.all([convert(ids[0], k), other(ids[1], k)]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    for (let i = 0; i < 2; i++)
      await assertWinner(ids[i], rs[i].status === 201 ? 1 : 0);
    expect(
      await p.apiIdempotencyRecord.count({
        where: { integrationClientId: clients[0], key: k },
      }),
    ).toBe(1);
  });
  it('same key concurrently in legacy create and conversion has one operation winner', async () => {
    const id = await emit(),
      k = key(),
      before = await p.deliveryRequest.count();
    const legacy = request(second.getHttpServer())
      .post('/api/v1/delivery-requests')
      .auth(tokens[0], { type: 'bearer' })
      .set('Idempotency-Key', k)
      .send(conversionBody().deliveryRequest);
    const rs = await Promise.all([convert(id, k), legacy]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    await assertWinner(id, rs[0].status === 201 ? 1 : 0);
    expect(await p.deliveryRequest.count()).toBe(before + 1);
    expect(
      await p.apiIdempotencyRecord.count({
        where: { integrationClientId: clients[0], key: k },
      }),
    ).toBe(1);
  });
  it('same key text across owners concurrently creates two independent winners', async () => {
    const id = await emit(),
      emitted = await post(key(), body, tokens[1]),
      k = key();
    expect(emitted.status).toBe(201);
    const rs = await Promise.all([
      convert(id, k),
      other(emitted.body.publicId, k, conversionBody(), tokens[1]),
    ]);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    await assertWinner(id);
    await assertWinner(emitted.body.publicId);
    expect(await p.apiIdempotencyRecord.count({ where: { key: k } })).toBe(2);
  });
  it('shared zone concurrent conversion and cancellation keep independent resources coherent', async () => {
    const done = await converted(),
      id = await emit();
    const rs = await Promise.all([
      other(id, key()),
      api()
        .post(
          `/api/v1/delivery-requests/${done.r.body.deliveryRequestPublicId}/cancel`,
        )
        .auth(tokens[0], { type: 'bearer' })
        .send({ reason: 'B3 concurrent cancel' }),
    ]);
    expect(rs.map((r) => r.status)).toEqual([201, 200]);
    await assertWinner(id);
    await assertWinner(done.id);
    expect((await other(done.id, done.k)).body.deliveryRequestStatus).toBe(
      'CANCELLED',
    );
  });
});
