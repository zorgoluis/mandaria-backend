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
const key = () => `b2-${randomUUID()}`;
const route = () => ({
  distanceMeters: 1200,
  durationSeconds: 60,
  routingProvider: 'b2-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'b2-controlled',
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

const tokens: string[] = [];
const api = () => request(app.getHttpServer());
const post = (k = key(), b: unknown = body, t = tokens[0]) =>
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
      code: `B2_${run}_${i}`,
      name: 'B2 fixture',
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
      code: `B2_${run}`,
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
  await app?.close();
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
  b: unknown = conversionBody(),
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
describe('B2 atomic conversion on real PostgreSQL', () => {
  it('HTTP contract, exact snapshot, no routing/consumption/dispatch/economic mutation', async () => {
    const id = await emit();
    const before = await counts();
    const starts = permit.start.mock.calls.length,
      routes = routing.calculateRoute.mock.calls.length,
      admissions = consumption.admit.mock.calls.length;
    const k = key();
    const r = await convert(id, k);
    expect(r.status).toBe(201);
    expect(r.headers['idempotent-replayed']).toBe('false');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['x-request-id']).toBeTruthy();
    expect(r.headers.location).toBe(
      '/api/v1/delivery-requests/' + r.body.deliveryRequestPublicId,
    );
    expect(Object.keys(r.body).sort()).toEqual(
      [
        'prequotePublicId',
        'convertedAt',
        'deliveryRequestPublicId',
        'externalReference',
        'deliveryRequestStatus',
        'deliveryCollectionInstruction',
        'quote',
        'availabilityGuaranteed',
      ].sort(),
    );
    expect(r.body.deliveryCollectionInstruction).toEqual(
      conversionBody().deliveryCollectionInstruction,
    );
    expect(r.body.quote.status).toBe('OFFERED');
    expect(r.body.availabilityGuaranteed).toBe(false);
    const c = await p.prequoteConversion.findFirstOrThrow({
      where: { prequote: { publicId: id } },
      include: { prequote: true, deliveryQuote: true, deliveryRequest: true },
    });
    for (const field of [
      'serviceType',
      'serviceZoneId',
      'ratePlanId',
      'rateBandId',
      'distanceMeters',
      'durationSeconds',
      'amount',
      'currency',
      'routingProvider',
      'routeCalculatedAt',
      'expiresAt',
    ] as const)
      expect(c.deliveryQuote[field]).toEqual(c.prequote[field]);
    expect(c.deliveryRequest.createdAt).toEqual(c.convertedAt);
    expect(c.deliveryRequest.requestedAt).toEqual(c.convertedAt);
    expect(c.deliveryQuote.createdAt).toEqual(c.convertedAt);
    expect(c.convertedAt >= c.prequote.issuedAt).toBe(true);
    expect(await counts()).toEqual([
      before[0] + 1,
      before[1] + 1,
      ...before.slice(2),
    ]);
    expect((await execution(k))?.execution).toBeNull();
    expect(routing.calculateRoute).toHaveBeenCalledTimes(routes);
    expect(consumption.admit).toHaveBeenCalledTimes(admissions);
    expect(permit.start).toHaveBeenCalledTimes(starts);
    const serialized = JSON.stringify(r.body);
    for (const field of [
      'merchantConfirmation',
      'goodsPaymentReference',
      'routingProvider',
      'ratePlanId',
      'integrationClientId',
      'stopIds',
      'secretHash',
    ])
      expect(serialized).not.toContain(field);
  });
  it('same-key concurrent replay and different-body conflict', async () => {
    const id = await emit(),
      k = key();
    const all = await Promise.all([
      convert(id, k),
      convert(id, k),
      convert(id, k),
    ]);
    expect(all.map((r) => r.status).sort()).toEqual([200, 200, 201]);
    expect(new Set(all.map((r) => r.body.deliveryRequestPublicId)).size).toBe(
      1,
    );
    const b = conversionBody();
    b.deliveryRequest.externalReference = 'changed';
    expect((await convert(id, k, b)).status).toBe(409);
  });
  it('many keys consume MPQ once with no orphan keys', async () => {
    const id = await emit();
    const keys = Array.from({ length: 5 }, key);
    const all = await Promise.all(keys.map((k) => convert(id, k)));
    expect(all.filter((r) => r.status === 201)).toHaveLength(1);
    for (let i = 0; i < all.length; i++)
      if (all[i].status !== 201) {
        expect(all[i].body.code).toBe('PREQUOTE_ALREADY_CONVERTED');
        await noKey(keys[i]);
      }
  });
  it('key includes source MPQ and shares namespace with emission and legacy', async () => {
    const { k } = await converted();
    const other = await emit();
    expect((await convert(other, k)).body.code).toBe('HTTP_409');
    const emissionKey = key();
    const emitted = await post(emissionKey);
    expect((await convert(emitted.body.publicId, emissionKey)).body.code).toBe(
      'HTTP_409',
    );
    const legacyKey = key();
    expect(
      (
        await api()
          .post('/api/v1/delivery-requests')
          .auth(tokens[0], { type: 'bearer' })
          .set('Idempotency-Key', legacyKey)
          .send(conversionBody().deliveryRequest)
      ).status,
    ).toBe(201);
    expect((await convert(other, legacyKey)).body.code).toBe('HTTP_409');
  });
  it('physical mismatch rejects without writes; defaults/omitted null are equivalent', async () => {
    const id = await emit();
    const b = conversionBody();
    b.deliveryRequest.packages[0].quantity = 2;
    const k = key();
    expect((await convert(id, k, b)).body.code).toBe(
      'PREQUOTE_CONDITIONS_MISMATCH',
    );
    await noKey(k);
    const equivalent = conversionBody();
    Object.assign(equivalent.deliveryRequest.packages[0], {
      weightKg: null,
      isFragile: false,
    });
    expect((await convert(id, key(), equivalent)).status).toBe(201);
  });
  it.each([
    'missing-confirmation',
    'pending',
    'future',
    'no-zone',
    'extra',
    'non-prepaid',
    'currency',
    'precision',
    'non-food',
    'wrong-components',
  ])('strict invalid body %s', async (kind) => {
    const id = await emit();
    const b = conversionBody() as ReturnType<typeof conversionBody> & {
      creditCost?: number;
    };
    if (kind === 'missing-confirmation')
      Reflect.deleteProperty(b, 'merchantConfirmation');
    if (kind === 'pending')
      b.merchantConfirmation.goodsPaymentStatus = 'PENDING';
    if (kind === 'future')
      b.merchantConfirmation.orderAcceptedAt = '2999-01-01T00:00:00Z';
    if (kind === 'no-zone')
      b.merchantConfirmation.orderAcceptedAt = '2026-01-01T00:00:00';
    if (kind === 'extra') b.creditCost = 1;
    if (kind === 'non-prepaid')
      b.deliveryRequest.financialContext.goodsPaymentMode = 'COURIER_ADVANCE';
    if (kind === 'currency')
      b.deliveryRequest.financialContext.currency = 'USD';
    if (kind === 'precision') b.deliveryRequest.stops[0].latitude = 10.1234567;
    if (kind === 'non-food') b.deliveryRequest.packages[0].category = 'OTHER';
    if (kind === 'wrong-components')
      b.deliveryCollectionInstruction.components = ['GOODS'];
    const k = key();
    expect((await convert(id, k, b)).status).toBe(400);
    await noKey(k);
  });
  it('ownership, scopes, suspension and revocation', async () => {
    const id = await emit();
    expect((await convert(id, key(), conversionBody(), tokens[1])).status).toBe(
      404,
    );
    expect(
      (
        await convert(
          id,
          key(),
          conversionBody(),
          await sign(0, ['prequotes:convert']),
        )
      ).status,
    ).toBe(403);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { status: 'SUSPENDED' },
    });
    expect((await convert(id)).status).toBe(401);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { status: 'ACTIVE' },
    });
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    expect((await convert(id)).status).toBe(401);
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { status: 'ACTIVE', revokedAt: null },
    });
  });
  it('flag off denies new, permits committed replay and permanent CONVERTED', async () => {
    const { id, k, r } = await converted();
    const unused = await emit();
    config.set('PREQUOTE_CONVERSION_ENABLED', false);
    expect((await convert(unused)).body.code).toBe(
      'PREQUOTE_CONVERSION_DISABLED',
    );
    const retry = await convert(id, k);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(r.body);
    const view = await get(id);
    expect(view.body.status).toBe('CONVERTED');
    expect(view.body.deliveryRequestPublicId).toBe(
      r.body.deliveryRequestPublicId,
    );
  });
  it('cancel does not free source; replay uses current statuses; emission replay also CONVERTED', async () => {
    const emissionKey = key();
    const emitted = await post(emissionKey);
    const id = emitted.body.publicId,
      k = key();
    const r = await convert(id, k);
    expect(r.status).toBe(201);
    const cancel = await api()
      .post(
        `/api/v1/delivery-requests/${r.body.deliveryRequestPublicId}/cancel`,
      )
      .auth(tokens[0], { type: 'bearer' })
      .send({ reason: 'Synthetic cancellation' });
    expect(cancel.status).toBeLessThan(300);
    const replay = await convert(id, k);
    expect(replay.status).toBe(200);
    expect(replay.body.deliveryRequestStatus).toBe('CANCELLED');
    expect(replay.body.quote.status).toBe('CANCELLED');
    expect((await convert(id)).body.code).toBe('PREQUOTE_ALREADY_CONVERTED');
    expect((await get(id)).body.status).toBe('CONVERTED');
    expect((await post(emissionKey)).body.status).toBe('CONVERTED');
  });
  it('legacy HTTP quote and accept are blocked, GET allowed', async () => {
    const { r } = await converted();
    const accept = await api()
      .post(`/api/v1/delivery-quotes/${r.body.quote.publicId}/accept`)
      .auth(tokens[0], { type: 'bearer' });
    expect(accept.status).toBe(409);
    expect(accept.body.code).toBe('AUTHORIZED_ACCEPT_REQUIRED');
    const quote = await api()
      .post(
        `/api/v1/delivery-requests/${r.body.deliveryRequestPublicId}/quotes`,
      )
      .auth(tokens[0], { type: 'bearer' });
    expect(quote.body.code).toBe('PREQUOTE_REQUOTE_NOT_ALLOWED');
    expect(
      (
        await api()
          .get(`/api/v1/delivery-quotes/${r.body.quote.publicId}`)
          .auth(tokens[0], { type: 'bearer' })
      ).status,
    ).toBe(200);
  });
  it('frozen zone metadata and inactive/replaced tariff do not reprice; inactive zone blocks only new', async () => {
    const id = await emit();
    await p.ratePlan.update({
      where: { id: planId },
      data: { status: 'INACTIVE', deactivatedAt: new Date() },
    });
    const oldZone = await p.serviceZone.findUniqueOrThrow({
      where: { id: zoneId },
    });
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { name: 'Changed live zone' },
    });
    const k = key(),
      r = await convert(id, k);
    expect(r.status).toBe(201);
    expect(r.body.quote.serviceZone.name).toBe(oldZone.name);
    const detail = await api()
      .get(`/api/v1/delivery-quotes/${r.body.quote.publicId}`)
      .auth(tokens[0], { type: 'bearer' });
    expect(detail.body.serviceZone.name).toBe(oldZone.name);
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
    expect((await convert(id, k)).status).toBe(200);
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'ACTIVE', name: oldZone.name },
    });
    const old = await p.ratePlan.findUniqueOrThrow({
      where: { id: planId },
      include: { bands: true },
    });
    const next = await p.ratePlan.create({
      data: {
        serviceZoneId: zoneId,
        serviceType: 'LOCAL_DELIVERY',
        version: old.version + 1,
        quoteValidityMinutes: 2,
        currency: 'MXN',
        bands: {
          create: {
            minDistanceMeters: 0,
            maxDistanceMeters: 10000,
            amount: '40.00',
            currency: 'MXN',
          },
        },
      },
    });
    planId = next.id;
    await p.ratePlan.update({
      where: { id: planId },
      data: { status: 'ACTIVE', activatedAt: new Date() },
    });
    const fresh = await emit();
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
    expect((await convert(fresh)).body.code).toBe(
      'PREQUOTE_SERVICE_UNAVAILABLE',
    );
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'ACTIVE' },
    });
  });
  it('expired MPQ fails; committed conversion survives expiry', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 500);
    const id = await emit();
    await new Promise((r) => setTimeout(r, 550));
    expect((await convert(id)).body.code).toBe('PREQUOTE_EXPIRED');
    config.set('PREQUOTE_VALIDITY_MS', 1500);
    const done = await converted();
    await new Promise((r) => setTimeout(r, 1550));
    const replay = await convert(done.id, done.k);
    expect(replay.status).toBe(200);
    expect(replay.body.quote.status).toBe('EXPIRED');
    expect((await get(done.id)).body.status).toBe('CONVERTED');
  });
  it('SQL rejects accepted quote, Dispatch, second quote and content/key/link mutations', async () => {
    const { c } = await converted();
    const statements = [
      () =>
        p.$executeRaw`UPDATE "DeliveryQuote" SET status='ACCEPTED',"acceptedAt"=now() WHERE id=${c.deliveryQuoteId}::uuid`,
      () =>
        p.$executeRaw`INSERT INTO "Dispatch" (id,"deliveryRequestId","deliveryQuoteId","openedAt","expiresAt","updatedAt") VALUES (${randomUUID()}::uuid,${c.deliveryRequestId}::uuid,${c.deliveryQuoteId}::uuid,now(),now()+interval '1 minute',now())`,
      () =>
        p.deliveryQuote.create({
          data: {
            ...c.deliveryQuote,
            id: randomUUID(),
            publicId: `MQ-${Date.now()}`,
          },
        }),
      () =>
        p.$executeRaw`UPDATE "DeliveryRequest" SET "externalReference"='forged' WHERE id=${c.deliveryRequestId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "DeliveryStop" SET address='forged' WHERE id=${c.stopIds[0]}::uuid`,
      () =>
        p.$executeRaw`DELETE FROM "DeliveryPackage" WHERE id=${c.packageIds[0]}::uuid`,
      () =>
        p.deliveryPackage.create({
          data: { ...c.deliveryRequest.packages[0], id: randomUUID() },
        }),
      () =>
        p.$executeRaw`UPDATE "DeliveryFinancialContext" SET "goodsValue"=1 WHERE id=${c.financialContextId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "ApiIdempotencyRecord" SET key='forged-key' WHERE id=${c.idempotencyRecordId}::uuid`,
      () =>
        p.$executeRaw`DELETE FROM "ApiIdempotencyRecord" WHERE id=${c.idempotencyRecordId}::uuid`,
      () =>
        p.$executeRaw`UPDATE "PrequoteConversion" SET "packageIds"=ARRAY[${randomUUID()}::uuid] WHERE id=${c.id}::uuid`,
      () =>
        p.$executeRaw`DELETE FROM "PrequoteConversion" WHERE id=${c.id}::uuid`,
    ];
    for (const attempt of statements) await expect(attempt()).rejects.toThrow();
    expect(
      await p.prequoteConversion.findUnique({ where: { id: c.id } }),
    ).not.toBeNull();
  });
  it('SQL rejects orphan conversion key at commit', async () => {
    const k = key();
    await expect(
      p.apiIdempotencyRecord.create({
        data: {
          integrationClientId: clients[0],
          key: k,
          operation: 'delivery_prequotes.convert',
          resourceType: 'PrequoteConversion',
          resourceId: randomUUID(),
          requestHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toThrow();
    await noKey(k);
  });
  it('openDispatch defense uses real origin before any operational work', async () => {
    const { c } = await converted();
    const { openDispatch } =
      await import('../dist/dispatch/dispatch-policy.js');
    await expect(
      p.$transaction((tx) => openDispatch(tx, c.deliveryQuote, 10, new Date())),
    ).rejects.toMatchObject({ code: 'AUTHORIZED_ACCEPT_REQUIRED' });
  });
});

// Faults are additive, fixture-scoped rejection/delay triggers; integrity triggers stay enabled.
async function withSqlFault(
  table: string,
  bodySql: string,
  run: () => Promise<void>,
  deferred = false,
) {
  const trigger = 'B2_fault_' + randomUUID().replaceAll('-', '');
  await p.$executeRawUnsafe(
    `CREATE FUNCTION "${trigger}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM "PrequoteConversion" c WHERE c."integrationClientId"='${clients[0]}'::uuid AND (c.id=NEW.id OR c."deliveryRequestId"=NEW.id OR c."deliveryQuoteId"=NEW.id)) THEN ${bodySql} END IF; RETURN NEW; END $$`,
  );
  try {
    await p.$executeRawUnsafe(
      `CREATE ${deferred ? 'CONSTRAINT ' : ''}TRIGGER "${trigger}" ${deferred ? 'AFTER' : 'BEFORE'} INSERT ON "${table}" ${deferred ? 'DEFERRABLE INITIALLY DEFERRED' : ''} FOR EACH ROW EXECUTE FUNCTION "${trigger}"()`,
    );
    await run();
  } finally {
    await p.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS "${trigger}" ON "${table}"`,
    );
    await p.$executeRawUnsafe(`DROP FUNCTION "${trigger}"()`);
  }
}
describe('B2 controlled failures and SQL construction', () => {
  it.each(['DeliveryRequest', 'DeliveryQuote'])(
    'failure at %s rolls back key, origin and all destinations',
    async (table) => {
      const id = await emit(),
        k = key(),
        before = await counts();
      await withSqlFault(
        table,
        "RAISE EXCEPTION 'B2_INJECTED_FAILURE';",
        async () => {
          expect((await convert(id, k)).status).toBe(500);
        },
      );
      expect(await counts()).toEqual(before);
      await noKey(k);
      expect(
        await p.prequoteConversion.count({
          where: { prequote: { publicId: id } },
        }),
      ).toBe(0);
      expect((await convert(id, k)).status).toBe(201);
    },
  );
  it('deferred failure after all inserts rolls back completely', async () => {
    const id = await emit(),
      k = key(),
      before = await counts();
    await withSqlFault(
      'PrequoteConversion',
      "RAISE EXCEPTION 'B2_DEFERRED_FAILURE';",
      async () => {
        expect((await convert(id, k)).status).toBe(500);
      },
      true,
    );
    expect(await counts()).toEqual(before);
    await noKey(k);
    expect((await convert(id, k)).status).toBe(201);
  });
  it('expiry while waiting for MPQ lock rejects without destination', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1200);
    const id = await emit(),
      k = key();
    let locked!: () => void;
    const ready = new Promise<void>((r) => {
      locked = r;
    });
    const blocker = p.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DeliveryPrequote" WHERE "publicId"=${id} FOR UPDATE`;
      locked();
      await new Promise((r) => setTimeout(r, 1300));
    });
    await ready;
    const response = await convert(id, k);
    await blocker;
    expect(response.body.code).toBe('PREQUOTE_EXPIRED');
    await noKey(k);
  });
  it('expiry during construction rejected by real deferred constraint', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1200);
    const id = await emit(),
      k = key(),
      before = await counts();
    await withSqlFault('DeliveryQuote', 'PERFORM pg_sleep(1.3);', async () => {
      const r = await convert(id, k);
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PREQUOTE_EXPIRED');
    });
    await noKey(k);
    expect(await counts()).toEqual(before);
  });
  it('lost response after commit recovers same committed resource', async () => {
    const id = await emit(),
      k = key();
    const { PrequoteConversionService } =
      await import('../dist/delivery-prequotes/prequote-conversion.service.js');
    const service = app.get(PrequoteConversionService);
    const load = vi
      .spyOn(
        service as unknown as {
          load: (...args: unknown[]) => Promise<unknown>;
        },
        'load',
      )
      .mockRejectedValueOnce(
        new Error('B2 controlled post-commit response loss'),
      );
    expect((await convert(id, k)).status).toBe(500);
    load.mockRestore();
    const stored = await p.prequoteConversion.findFirstOrThrow({
      where: { prequote: { publicId: id } },
    });
    const retry = await convert(id, k);
    expect(retry.status).toBe(200);
    expect(
      await p.prequoteConversion.count({
        where: { prequoteId: stored.prequoteId },
      }),
    ).toBe(1);
  });
  it('all three scopes required individually', async () => {
    const id = await emit();
    for (const missing of [
      'prequotes:convert',
      'deliveries:create',
      'quotes:create',
    ]) {
      const scopes = [
        'prequotes:convert',
        'deliveries:create',
        'quotes:create',
      ].filter((s) => s !== missing);
      expect(
        (await convert(id, key(), conversionBody(), await sign(0, scopes)))
          .status,
      ).toBe(403);
    }
  });
  it('deferred FK catalog and immutable manifest survive savepoints and later INSERT', async () => {
    const { c } = await converted();
    const rows = await p.$queryRaw<
      { condeferrable: boolean; condeferred: boolean }[]
    >`SELECT condeferrable,condeferred FROM pg_constraint WHERE conrelid='"PrequoteConversion"'::regclass AND conname IN ('PrequoteConversion_deliveryRequestId_integrationClientId_fkey','PrequoteConversion_deliveryQuoteId_deliveryRequestId_fkey')`;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.condeferrable && r.condeferred)).toBe(true);
    await p.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SAVEPOINT b2_child');
      await expect(
        tx.deliveryPackage.create({
          data: { ...c.deliveryRequest.packages[0], id: randomUUID() },
        }),
      ).rejects.toThrow();
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT b2_child');
      expect(
        await tx.deliveryPackage.count({
          where: { deliveryRequestId: c.deliveryRequestId },
        }),
      ).toBe(c.packageIds.length);
    });
  });
  it('SQL rejects destination adoption and incomplete manifest with no orphan result', async () => {
    const { c } = await converted();
    for (const incomplete of [false, true]) {
      const id = await emit(),
        source = await p.deliveryPrequote.findUniqueOrThrow({
          where: { publicId: id },
        }),
        k = key();
      await expect(
        p.$transaction(async (tx) => {
          const conversionId = randomUUID();
          const record = await tx.apiIdempotencyRecord.create({
            data: {
              integrationClientId: clients[0],
              key: k,
              operation: 'delivery_prequotes.convert',
              resourceType: 'PrequoteConversion',
              resourceId: conversionId,
              requestHash: 'a'.repeat(64),
            },
          });
          const {
            prequote: _p,
            deliveryRequest: _r,
            deliveryQuote: _q,
            ...data
          } = c;
          void _p;
          void _r;
          void _q;
          await tx.prequoteConversion.create({
            data: {
              ...data,
              id: conversionId,
              prequoteId: source.id,
              idempotencyRecordId: record.id,
              deliveryRequestId: incomplete
                ? randomUUID()
                : c.deliveryRequestId,
              deliveryQuoteId: randomUUID(),
              stopIds: [randomUUID(), randomUUID()],
              packageIds: [randomUUID()],
              financialContextId: randomUUID(),
            },
          });
        }),
      ).rejects.toThrow();
      await noKey(k);
    }
  });
  it('captured logs omit token, opaque confirmation refs and request contacts', () => {
    const text = logs.join('\n');
    for (const token of tokens) expect(text).not.toContain(token);
    for (const forbidden of [
      'receipt-demo',
      'order-demo',
      '0000000000',
      'merchantConfirmation',
      'secretHash',
    ])
      expect(text).not.toContain(forbidden);
  });
});
describe('B2 additional boundaries', () => {
  it('independent Nest instances share one conversion result', async () => {
    const id = await emit(),
      k = key();
    const { AppModule } = await import('../dist/app.module.js');
    const { setup } = await import('../dist/setup.js');
    const { ROUTING_PROVIDER } =
      await import('../dist/routing/routing.types.js');
    const { PREQUOTE_CONSUMPTION } =
      await import('../dist/delivery-prequotes/prequote-consumption.js');
    const ref = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ROUTING_PROVIDER)
      .useValue(routing)
      .overrideProvider(PREQUOTE_CONSUMPTION)
      .useValue(consumption)
      .setLogger(logger)
      .compile();
    const second = ref.createNestApplication({ logger, bodyParser: false });
    setup(second);
    await second.init();
    second.get(ConfigService).set('PREQUOTE_CONVERSION_ENABLED', true);
    try {
      const other = request(second.getHttpServer())
        .post(`/api/v1/delivery-prequotes/${id}/convert`)
        .auth(tokens[0], { type: 'bearer' })
        .set('Idempotency-Key', k)
        .send(conversionBody());
      const results = await Promise.all([convert(id, k), other]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
      expect(results[0].body.deliveryRequestPublicId).toBe(
        results[1].body.deliveryRequestPublicId,
      );
    } finally {
      await second.close();
    }
  }, 30000);
  it('admin detail/list and B2B list use frozen zone, human cannot convert', async () => {
    const { id, r, c } = await converted();
    const old = await p.serviceZone.findUniqueOrThrow({
      where: { id: zoneId },
    });
    const admin = await p.user.create({
      data: {
        email: `b2-${randomUUID()}@example.test`,
        role: 'SUPER_ADMIN',
        passwordHash: await (
          await import('argon2')
        ).hash(randomBytes(32).toString('hex')),
      },
    });
    const token = await new JwtService().signAsync(
      { sub: admin.id, type: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        issuer: 'mandaria',
        audience: 'mandaria-users',
        expiresIn: 60,
        algorithm: 'HS256',
      },
    );
    try {
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { code: `B2_RENAMED_${run}`, name: 'Live metadata changed' },
      });
      expect((await convert(id, key(), conversionBody(), token)).status).toBe(
        401,
      );
      const paths = [
        `/api/v1/admin/delivery-quotes/${r.body.quote.publicId}`,
        `/api/v1/admin/delivery-quotes?publicId=${r.body.quote.publicId}`,
        `/api/v1/admin/delivery-requests/${r.body.deliveryRequestPublicId}/quotes`,
      ];
      for (const path of paths) {
        const response = await api().get(path).auth(token, { type: 'bearer' });
        expect(response.status).toBe(200);
        const quote = response.body.items?.[0] ?? response.body;
        expect(quote.serviceZone.code).toBe(c.prequote.zoneCode);
        expect(quote.serviceZone.name).toBe(c.prequote.zoneName);
        expect(quote.prequoteConversion).toBeUndefined();
      }
      const b2b = await api()
        .get(
          `/api/v1/delivery-requests/${r.body.deliveryRequestPublicId}/quotes`,
        )
        .auth(tokens[0], { type: 'bearer' });
      expect(b2b.status).toBe(200);
      expect(b2b.body.items[0].serviceZone.name).toBe(c.prequote.zoneName);
    } finally {
      await p.user.update({ where: { id: admin.id }, data: { active: false } });
      await p.serviceZone.update({
        where: { id: zoneId },
        data: { code: old.code, name: old.name },
      });
    }
  });
  it('tampered SQL snapshot fails deferred verification and rolls back', async () => {
    const id = await emit(),
      k = key(),
      before = await counts();
    await withSqlFault('DeliveryQuote', 'NEW.amount:=1;', async () => {
      expect((await convert(id, k)).status).toBe(500);
    });
    expect(await counts()).toEqual(before);
    await noKey(k);
  });
  it('different coordinates, weights and multiplicity reject without mutation', async () => {
    const id = await emit();
    for (const mutate of [
      (b: ReturnType<typeof conversionBody>) => {
        b.deliveryRequest.stops[1].longitude = Number(
          (b.deliveryRequest.stops[1].longitude + 0.000001).toFixed(6),
        );
      },
      (b: ReturnType<typeof conversionBody>) => {
        Object.assign(b.deliveryRequest.packages[0], { weightKg: 2 });
      },
      (b: ReturnType<typeof conversionBody>) => {
        b.deliveryRequest.packages.push({ ...b.deliveryRequest.packages[0] });
      },
    ]) {
      const b = conversionBody(),
        k = key();
      mutate(b);
      expect((await convert(id, k, b)).body.code).toBe(
        'PREQUOTE_CONDITIONS_MISMATCH',
      );
      await noKey(k);
    }
  });
  it('null and omitted goodsValue are allowed and remain separate from fee', async () => {
    for (const value of [null, undefined]) {
      const id = await emit(),
        b = conversionBody();
      Reflect.set(b.deliveryRequest.financialContext, 'goodsValue', value);
      const r = await convert(id, key(), b);
      expect(r.status).toBe(201);
      const c = await p.prequoteConversion.findFirstOrThrow({
        where: { prequote: { publicId: id } },
        include: { deliveryRequest: { include: { financialContext: true } } },
      });
      expect(c.deliveryRequest.financialContext?.goodsValue).toBeNull();
      expect(r.body.deliveryCollectionInstruction).not.toHaveProperty('amount');
    }
  });
});
