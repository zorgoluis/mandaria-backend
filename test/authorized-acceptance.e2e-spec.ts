import 'reflect-metadata';
import { hash } from 'argon2';
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
import { ThrottlerGuard } from '@nestjs/throttler';
import { fundProvider } from './support/credits.js';
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
  routingProvider: 'c2-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'c2-controlled',
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
const post = (k = key(), b: object = body, t = tokens[0]) =>
  api()
    .post('/api/v1/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
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
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
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
      code: `C2_${run}_${i}`,
      name: 'C2 fixture',
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
  await ensureTestCreditPolicies(p);
  const zone = await p.serviceZone.create({
    data: {
      code: `C2_${run}`,
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
  config.set('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', true);
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
async function noAward(
  c: Awaited<ReturnType<typeof converted>>['c'],
  k: string,
) {
  await noKey(k);
  expect(
    await p.authorizedQuoteAcceptance.count({
      where: { deliveryQuoteId: c.deliveryQuoteId },
    }),
  ).toBe(0);
  expect(
    await p.dispatch.count({
      where: { deliveryRequestId: c.deliveryRequestId },
    }),
  ).toBe(0);
  expect(
    (
      await p.deliveryQuote.findUniqueOrThrow({
        where: { id: c.deliveryQuoteId },
      })
    ).status,
  ).not.toBe('ACCEPTED');
}
async function waitBlocked() {
  for (let i = 0; i < 100; i++) {
    const rows = await p.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`;
    if (Number(rows[0].n) > 0) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw Error('Request did not reach the expected database lock');
}
async function withRequestLock<T>(
  requestId: string,
  work: () => Promise<T>,
  beforeRelease?: () => Promise<void>,
) {
  let locked!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (locked = r)),
    gate = new Promise<void>((r) => (release = r));
  const holding = p.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${requestId}::uuid FOR UPDATE`;
      locked();
      await gate;
    },
    { timeout: 10000 },
  );
  await ready;
  const pending = work();
  try {
    await waitBlocked();
    await beforeRelease?.();
  } finally {
    release();
    await holding;
  }
  return pending;
}

describe('C2 authorized acceptance, real isolated PostgreSQL', () => {
  it('upgrade B history fixture remains a converted OFFERED resource', async () => {
    const { c } = await converted();
    expect(c.deliveryQuote.status).toBe('OFFERED');
    expect(c.deliveryRequest.status).toBe('CREATED');
  });
  it('atomic exact attestation opens one dispatch and snapshots without routing, A5 or debit; private data never exposed', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const routes = routing.calculateRoute.mock.calls.length,
      starts = permit.start.mock.calls.length,
      ledger = await p.creditLedgerEntry.count();
    const result = await accept(r.body.quote.publicId, b, k);
    expect([result.status, result.body.code]).toEqual([200, undefined]);
    expect(result.headers['idempotent-replayed']).toBe('false');
    expect(result.headers['cache-control']).toBe('no-store');
    const evidence = await p.authorizedQuoteAcceptance.findUniqueOrThrow({
      where: { deliveryQuoteId: c.deliveryQuoteId },
      include: { dispatch: { include: { creditSnapshots: true } } },
    });
    expect(evidence.dispatch.creditSnapshots).toHaveLength(2);
    expect(evidence.dispatch.status).toBe('OPEN');
    expect(evidence.authorizedAmount.toFixed(2)).toBe(r.body.quote.amount);
    expect(evidence.credentialId).toBe(credentials[0]);
    expect(routing.calculateRoute).toHaveBeenCalledTimes(routes);
    expect(permit.start).toHaveBeenCalledTimes(starts);
    expect(await p.creditLedgerEntry.count()).toBe(ledger);
    expect(
      await p.deliveryFinancialContext.findUnique({
        where: { deliveryRequestId: c.deliveryRequestId },
      }),
    ).toEqual(c.deliveryRequest.financialContext);
    expect(JSON.stringify(result.body)).not.toMatch(
      /private-consent|credentialId|authenticatedToken|authorizationReference/,
    );
    const me = await api()
      .get('/api/v1/integrations/me')
      .auth(tokens[0], { type: 'bearer' })
      .expect(200);
    expect(me.body.authentication).toBeUndefined();
    expect(me.body.credentialId).toBeUndefined();
    expect(logs.join('\n')).not.toContain('private-consent-fixture');
    for (const t of tokens) expect(logs.join('\n')).not.toContain(t);
  });
  it.each(['amount', 'currency', 'expiresAt', 'quotePublicId'] as const)(
    'rejects mismatched %s with no key/economic effects',
    async (field) => {
      const { c, r } = await converted(),
        b = attestation(r.body.quote),
        k = key();
      b.customerAuthorization[field] = {
        amount: '0.01',
        currency: 'USD',
        expiresAt: '2099-01-01T00:00:00.000Z',
        quotePublicId: 'MQ-999999',
      }[field];
      const result = await accept(r.body.quote.publicId, b, k);
      expect(result.status).toBe(field === 'currency' ? 400 : 409);
      await noAward(c, k);
    },
  );
  it.each(['missing', 'null', 'extra', 'future', 'before', 'no-key'])(
    'validates %s authorization',
    async (mode) => {
      const { c, r } = await converted(),
        k = key(),
        b = attestation(r.body.quote);
      const body: object =
        mode === 'missing'
          ? {}
          : mode === 'null'
            ? { customerAuthorization: null }
            : mode === 'extra'
              ? { ...b, credentialId: credentials[1] }
              : b;
      if (mode === 'future')
        b.customerAuthorization.authorizedAt = '2099-01-01T00:00:00.000Z';
      if (mode === 'before')
        b.customerAuthorization.authorizedAt = '2020-01-01T00:00:00.000Z';
      const result =
        mode === 'no-key'
          ? await api()
              .post(`/api/v1/delivery-quotes/${r.body.quote.publicId}/accept`)
              .auth(tokens[0], { type: 'bearer' })
              .send(body)
          : await accept(r.body.quote.publicId, body, k);
      expect(result.status).toBe(400);
      await noAward(c, k);
    },
  );
  it('requires owner and scope and valid token on new acceptance and replay', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    expect((await accept(r.body.quote.publicId, b, k, tokens[1])).status).toBe(
      404,
    );
    expect(
      (
        await accept(
          r.body.quote.publicId,
          b,
          k,
          await sign(0, ['quotes:read']),
        )
      ).status,
    ).toBe(403);
    expect((await accept(r.body.quote.publicId, b, k, 'invalid')).status).toBe(
      401,
    );
    await noAward(c, k);
    await accept(r.body.quote.publicId, b, k).expect(200);
    await p.integrationClient.update({
      where: { id: clients[0] },
      data: { status: 'SUSPENDED' },
    });
    try {
      await accept(r.body.quote.publicId, b, k).expect(401);
    } finally {
      await p.integrationClient.update({
        where: { id: clients[0] },
        data: { status: 'ACTIVE' },
      });
    }
  });
  it('flag off blocks first acceptance; lost response replay remains available after cancel and never reopens', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    config.set('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', false);
    expect((await accept(r.body.quote.publicId, b, k)).body.code).toBe(
      'AUTHORIZED_ACCEPT_DISABLED',
    );
    await noAward(c, k);
    config.set('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', true);
    const first = await accept(r.body.quote.publicId, b, k).expect(200);
    await cancel(r.body.deliveryRequestPublicId).expect(200);
    config.set('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', false);
    const replay = await accept(r.body.quote.publicId, b, k).expect(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(first.body);
    expect((await status(r.body.deliveryRequestPublicId)).body.status).toBe(
      'CANCELLED',
    );
    expect(
      await p.authorizedQuoteAcceptance.count({
        where: { deliveryQuoteId: c.deliveryQuoteId },
      }),
    ).toBe(1);
  });
  it('same key concurrent attempts replay one result; incompatible body and namespace conflict', async () => {
    const { c, r, k: conversionKey } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => accept(r.body.quote.publicId, b, k)),
    );
    expect(results.map((x) => x.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    expect(
      results.filter((x) => x.headers['idempotent-replayed'] === 'false'),
    ).toHaveLength(1);
    expect(
      await p.authorizedQuoteAcceptance.count({
        where: { deliveryQuoteId: c.deliveryQuoteId },
      }),
    ).toBe(1);
    const changed = structuredClone(b);
    changed.customerAuthorization.reference = 'other';
    expect((await accept(r.body.quote.publicId, changed, k)).body.code).toBe(
      'HTTP_409',
    );
    expect((await accept(r.body.quote.publicId, b, conversionKey)).status).toBe(
      409,
    );
  });
  it('different keys concurrent: one winner, other keys rolled back', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote);
    const keys = Array.from({ length: 6 }, key);
    const results = await Promise.all(
      keys.map((k) => accept(r.body.quote.publicId, b, k)),
    );
    expect(results.filter((x) => x.status === 200)).toHaveLength(1);
    expect(
      results.filter((x) => x.body.code === 'QUOTE_ALREADY_AUTHORIZED'),
    ).toHaveLength(5);
    for (let i = 0; i < keys.length; i++)
      if (results[i].status !== 200) await noKey(keys[i]);
    expect(
      await p.dispatch.count({
        where: { deliveryRequestId: c.deliveryRequestId },
      }),
    ).toBe(1);
  });
  it('cancel wins MDR lock: acceptance fails, repeated cancellation retains original timestamp', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    await cancel(r.body.deliveryRequestPublicId).expect(200);
    const result = await withRequestLock(c.deliveryRequestId, () =>
      accept(r.body.quote.publicId, b, k).then((x) => x),
    );
    expect(result.body.code).toBe('QUOTE_NOT_ACCEPTABLE');
    await noAward(c, k);
    const a = await cancel(r.body.deliveryRequestPublicId),
      z = await cancel(r.body.deliveryRequestPublicId);
    expect(z.body.cancelledAt).toBe(a.body.cancelledAt);
    expect((await status(r.body.deliveryRequestPublicId)).body).toMatchObject({
      status: 'CANCELLED',
      deliveredAt: null,
    });
  });
  it('both live accept/cancel requests serialize without leaving dispatch operational', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const [a, z] = await withRequestLock(c.deliveryRequestId, () =>
      Promise.all([
        accept(r.body.quote.publicId, b, k),
        cancel(r.body.deliveryRequestPublicId),
      ]),
    );
    expect(z.status).toBe(200);
    expect([200, 409]).toContain(a.status);
    expect((await status(r.body.deliveryRequestPublicId)).body).toMatchObject({
      status: 'CANCELLED',
      deliveredAt: null,
    });
    if (a.status === 200) {
      expect(
        (await accept(r.body.quote.publicId, b, k)).headers[
          'idempotent-replayed'
        ],
      ).toBe('true');
    } else await noAward(c, k);
  });
  it('TTL is rechecked after MDR lock; expired converted request can be cancelled', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1800);
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const result = await withRequestLock(
      c.deliveryRequestId,
      () => accept(r.body.quote.publicId, b, k).then((x) => x),
      async () => {
        await new Promise((r) =>
          setTimeout(
            r,
            Math.max(0, c.deliveryQuote.expiresAt.getTime() - Date.now() + 50),
          ),
        );
      },
    );
    expect([result.status, result.body.code]).toEqual([409, 'QUOTE_EXPIRED']);
    await noAward(c, k);
    await cancel(r.body.deliveryRequestPublicId).expect(200);
    expect((await status(r.body.deliveryRequestPublicId)).body).toMatchObject({
      status: 'CANCELLED',
      deliveredAt: null,
    });
  });
  it('replay after natural expiry returns same accepted result', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1800);
    const { r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const first = await accept(r.body.quote.publicId, b, k).expect(200);
    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(
          0,
          new Date(r.body.quote.expiresAt).getTime() - Date.now() + 30,
        ),
      ),
    );
    const again = await accept(r.body.quote.publicId, b, k).expect(200);
    expect(again.body).toEqual(first.body);
    expect(again.headers['idempotent-replayed']).toBe('true');
  });
  it('revocation committed before credential lock rejects without effects', async () => {
    const { c, r } = await converted(),
      k = key(),
      b = attestation(r.body.quote);
    await p.integrationCredential.update({
      where: { id: credentials[0] },
      data: { status: 'REVOKED', revokedAt: new Date() },
    });
    try {
      await accept(r.body.quote.publicId, b, k).expect(401);
      await noAward(c, k);
    } finally {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'ACTIVE', revokedAt: null },
      });
    }
  });
  it('missing credit policy rolls back evidence, key, quote and dispatch', async () => {
    const { c, r } = await converted(),
      k = key(),
      b = attestation(r.body.quote);
    const policy = await p.creditPolicy.findFirstOrThrow({
      where: { actorType: 'PROVIDER', status: 'ACTIVE' },
    });
    await p.creditPolicy.update({
      where: { id: policy.id },
      data: { status: 'INACTIVE', effectiveUntil: new Date() },
    });
    try {
      const result = await accept(r.body.quote.publicId, b, k);
      expect(result.body.code).toBe('CREDIT_POLICY_UNAVAILABLE');
      await noAward(c, k);
    } finally {
      await ensureTestCreditPolicies(p);
    }
  });
  it('SQL denies direct accept and forged dispatch without authorized evidence with exact error', async () => {
    const { c } = await converted();
    await expect(
      p.$executeRaw`UPDATE "DeliveryQuote" SET status='ACCEPTED',"acceptedAt"=clock_timestamp() WHERE id=${c.deliveryQuoteId}::uuid`,
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: 'P0001', message: 'ERROR: AUTHORIZED_ACCEPT_REQUIRED' },
    });
    await expect(
      p.$executeRaw`INSERT INTO "Dispatch" (id,"deliveryRequestId","deliveryQuoteId","openedAt","expiresAt","updatedAt") VALUES (${randomUUID()}::uuid,${c.deliveryRequestId}::uuid,${c.deliveryQuoteId}::uuid,clock_timestamp(),clock_timestamp()+interval '10 minutes',clock_timestamp())`,
    ).rejects.toMatchObject({
      code: 'P2010',
      meta: { code: 'P0001', message: 'ERROR: AUTHORIZED_ACCEPT_REQUIRED' },
    });
  });
  it('SQL rejects orphan C key, and immutable record/key edits/deletes after acceptance', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote);
    await accept(r.body.quote.publicId, b).expect(200);
    const a = await p.authorizedQuoteAcceptance.findUniqueOrThrow({
      where: { deliveryQuoteId: c.deliveryQuoteId },
    });
    for (const query of [
      p.$executeRaw`UPDATE "AuthorizedQuoteAcceptance" SET "authorizationReference"='changed' WHERE id=${a.id}::uuid`,
      p.$executeRaw`DELETE FROM "AuthorizedQuoteAcceptance" WHERE id=${a.id}::uuid`,
    ])
      await expect(query).rejects.toMatchObject({
        meta: { code: 'P0001', message: 'ERROR: AUTHORIZED_ACCEPT_IMMUTABLE' },
      });
    await expect(
      p.$executeRaw`UPDATE "ApiIdempotencyRecord" SET key='forged-key' WHERE id=${a.idempotencyRecordId}::uuid`,
    ).rejects.toMatchObject({
      meta: {
        code: 'P0001',
        message: 'ERROR: AUTHORIZED_ACCEPT_KEY_IMMUTABLE',
      },
    });
    await expect(
      p.$executeRaw`INSERT INTO "ApiIdempotencyRecord" (id,"integrationClientId",key,operation,"requestHash","resourceType","resourceId") VALUES (${randomUUID()}::uuid,${clients[0]}::uuid,${key()},'delivery_quotes.accept_authorized',${'a'.repeat(64)},'AuthorizedQuoteAcceptance',${randomUUID()}::uuid)`,
    ).rejects.toMatchObject({
      meta: {
        code: 'P0001',
        message: 'ERROR: AUTHORIZED_ACCEPT_ATOMIC_RESULT',
      },
    });
  });
});

async function assignedConverted() {
  const passwordHash = await hash(randomBytes(32).toString('hex'));
  const { DispatchService } =
    await import('../dist/dispatch/dispatch.service.js');
  const { DeliveryAssignmentsService } =
    await import('../dist/delivery-assignments/delivery-assignments.service.js');
  const admin = await p.user.create({
    data: {
      email: `c2-${randomUUID()}@fixture.test`,
      role: 'PROVIDER_ADMIN',
      active: true,
      passwordHash,
    },
  });
  const user = await p.user.create({
    data: {
      email: `c2-${randomUUID()}@fixture.test`,
      role: 'DRIVER',
      active: true,
      passwordHash,
    },
  });
  const provider = await p.deliveryProvider.create({
    data: {
      name: 'C2 fixture',
      code: `C2_${randomUUID()}`,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 2,
      maxVehicles: 2,
    },
  });
  await p.providerMembership.create({
    data: { providerId: provider.id, userId: admin.id, role: 'OWNER' },
  });
  const driver = await p.driver.create({
    data: {
      providerId: provider.id,
      userId: user.id,
      name: 'C2 driver',
      status: 'ACTIVE',
      availability: 'AVAILABLE',
    },
  });
  const vehicle = await p.vehicle.create({
    data: {
      providerId: provider.id,
      identifier: `C2_${randomUUID().slice(0, 16).toUpperCase()}`,
      type: 'MOTORCYCLE',
      status: 'ACTIVE',
    },
  });
  await p.driverVehicleAssignment.create({
    data: {
      providerId: provider.id,
      driverId: driver.id,
      vehicleId: vehicle.id,
    },
  });
  await p.providerServiceCoverage.create({
    data: {
      providerId: provider.id,
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
    },
  });
  const item = await converted();
  const b = attestation(item.r.body.quote),
    k = key();
  await accept(item.r.body.quote.publicId, b, k).expect(200);
  const dispatch = await p.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: item.c.deliveryQuoteId },
    include: { creditSnapshots: true },
  });
  await fundProvider(
    p,
    provider.id,
    dispatch.creditSnapshots.find((s) => s.actorType === 'PROVIDER')!.credits,
  );
  await app.get(DispatchService).claim(dispatch.id, provider.id, admin.id);
  await app
    .get(DeliveryAssignmentsService)
    .create(
      dispatch.id,
      { driverId: driver.id, vehicleId: vehicle.id },
      { providerId: provider.id, userId: admin.id },
    );
  return { ...item, dispatch, provider, admin, b, k };
}
describe('C2 controlled operational and transactional barriers', () => {
  it.each(['completion', 'cancel'] as const)(
    '%s wins concurrent completion/cancel: no reopened dispatch and delivered state prevails',
    async (winner) => {
      const x = await assignedConverted();
      const { completeDelivery } =
        await import('../dist/deliveries/delivery-completion.js');
      let ready!: () => void, release!: () => void;
      const locked = new Promise<void>((r) => (ready = r)),
        gate = new Promise<void>((r) => (release = r));
      if (winner === 'completion') {
        const complete = p.$transaction(
          async (tx) => {
            await completeDelivery(
              tx,
              x.dispatch.id,
              { mode: 'FLEET', providerId: x.provider.id },
              x.admin.id,
            );
            ready();
            await gate;
          },
          { timeout: 10000 },
        );
        await locked;
        const pending = cancel(x.r.body.deliveryRequestPublicId).then((r) => r);
        try {
          await waitBlocked();
        } finally {
          release();
          await complete;
        }
        const result = await pending;
        expect(result.status).toBe(200);
        expect(result.body.status).toBe('CANCELLED');
        expect(
          (await status(x.r.body.deliveryRequestPublicId)).body.status,
        ).toBe('DELIVERED');
      } else {
        const { closeDispatchesForCancelledRequest } =
          await import('../dist/dispatch/dispatch-policy.js');
        const cancellation = p.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${x.c.deliveryRequestId}::uuid FOR UPDATE`;
            const now = new Date();
            await tx.deliveryRequest.update({
              where: { id: x.c.deliveryRequestId },
              data: {
                status: 'CANCELLED',
                cancelledAt: now,
                cancellationReason: 'C2 controlled ordering',
              },
            });
            await closeDispatchesForCancelledRequest(
              tx,
              x.c.deliveryRequestId,
              now,
            );
            ready();
            await gate;
          },
          { timeout: 10000 },
        );
        await locked;
        const completion = p
          .$transaction((tx) =>
            completeDelivery(
              tx,
              x.dispatch.id,
              { mode: 'FLEET', providerId: x.provider.id },
              x.admin.id,
            ),
          )
          .then(
            () => null,
            (error) => error,
          );
        try {
          await waitBlocked();
        } finally {
          release();
          await cancellation;
        }
        expect(await completion).toMatchObject({
          code: 'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
        });
        await cancel(x.r.body.deliveryRequestPublicId).expect(200);
        expect(
          (await status(x.r.body.deliveryRequestPublicId)).body,
        ).toMatchObject({ status: 'CANCELLED', deliveredAt: null });
      }
      config.set('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', false);
      await accept(x.r.body.quote.publicId, x.b, x.k).expect(200);
      const a = await p.authorizedQuoteAcceptance.findUniqueOrThrow({
        where: { deliveryQuoteId: x.c.deliveryQuoteId },
      });
      expect(a.dispatchId).toBe(x.dispatch.id);
      expect(
        await p.creditLedgerEntry.count({
          where: {
            referenceType: 'DISPATCH',
            referenceId: x.dispatch.id,
            type: 'SERVICE_AWARD',
          },
        }),
      ).toBe(1);
    },
  );
  it('controlled failure after evidence/MQ/Dispatch mutation rolls back everything', async () => {
    const { c, r } = await converted(),
      k = key();
    // Dedicated test DB only; transient trigger targets only this fixture request. No production bypass.
    await p.$executeRawUnsafe(
      `CREATE FUNCTION c2_abort_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM "Dispatch" WHERE id=NEW."dispatchId" AND "deliveryRequestId"='${c.deliveryRequestId}'::uuid) THEN RAISE EXCEPTION 'C2_CONTROLLED_ABORT'; END IF; RETURN NEW; END $$`,
    );
    await p.$executeRawUnsafe(
      'CREATE TRIGGER "C2_abort_snapshot" BEFORE INSERT ON "DispatchCreditSnapshot" FOR EACH ROW EXECUTE FUNCTION c2_abort_snapshot()',
    );
    try {
      const result = await accept(
        r.body.quote.publicId,
        attestation(r.body.quote),
        k,
      );
      expect(result.status).toBe(500);
      await noAward(c, k);
    } finally {
      await p.$executeRawUnsafe(
        'DROP TRIGGER "C2_abort_snapshot" ON "DispatchCreditSnapshot"',
      );
      await p.$executeRawUnsafe('DROP FUNCTION c2_abort_snapshot()');
    }
  });
  it('credential scope removed while request waits is rejected on revalidation', async () => {
    const { c, r } = await converted(),
      k = key(),
      b = attestation(r.body.quote);
    // Block credential BEFORE accept can take its SHARE lock; HTTP guard sees the committed old scopes.
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const old = await p.integrationCredential.findUniqueOrThrow({
      where: { id: credentials[0] },
    });
    const change = p.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "IntegrationCredential" WHERE id=${credentials[0]}::uuid FOR UPDATE`;
        await tx.integrationCredential.update({
          where: { id: credentials[0] },
          data: { scopes: ['quotes:read'] },
        });
        ready();
        await gate;
      },
      { timeout: 10000 },
    );
    await locked;
    const pending = accept(r.body.quote.publicId, b, k).then((r) => r);
    try {
      await waitBlocked();
    } finally {
      release();
      await change;
    }
    try {
      expect((await pending).status).toBe(403);
      await noAward(c, k);
    } finally {
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { scopes: old.scopes },
      });
    }
  });
});

describe('C2 SQL structural forgeries', () => {
  it.each([
    'wrong-owner',
    'wrong-quote',
    'wrong-amount',
    'no-dispatch',
  ] as const)(
    'rejects %s in structurally valid statements, exact guard failure',
    async (mode) => {
      const { c } = await converted();
      const other = mode === 'wrong-quote' ? await converted() : null;
      const id = randomUUID(),
        record = randomUUID();
      const result = p.$transaction(async (tx) => {
        await tx.apiIdempotencyRecord.create({
          data: {
            id: record,
            integrationClientId: clients[0],
            key: key(),
            operation: 'delivery_quotes.accept_authorized',
            resourceType: 'AuthorizedQuoteAcceptance',
            resourceId: id,
            requestHash: 'a'.repeat(64),
          },
        });
        await tx.$executeRaw`INSERT INTO "AuthorizedQuoteAcceptance" (id,"conversionId","deliveryRequestId","deliveryQuoteId","integrationClientId","dispatchId","idempotencyRecordId","credentialId","authenticatedTokenExpiresAt","authorizationVersion","authorizationStatus","authorizationReference","authorizedAt","authorizedAmount","authorizedCurrency","authorizedExpiresAt") VALUES (${id}::uuid,${c.id}::uuid,${c.deliveryRequestId}::uuid,${other?.c.deliveryQuoteId ?? c.deliveryQuoteId}::uuid,${mode === 'wrong-owner' ? clients[1] : clients[0]}::uuid,${randomUUID()}::uuid,${record}::uuid,${credentials[0]}::uuid,${new Date(Date.now() + 3600000).toISOString()}::timestamp,1,'AUTHORIZED_BY_CUSTOMER','sql-fixture',${new Date().toISOString()}::timestamp,${mode === 'wrong-amount' ? '0.01' : c.deliveryQuote.amount.toFixed(2)}::decimal,'MXN',${c.deliveryQuote.expiresAt.toISOString()}::timestamp)`;
      });
      if (mode === 'no-dispatch')
        await expect(result).rejects.toThrow(/AUTHORIZED_ACCEPT_ATOMIC_RESULT/);
      else
        await expect(result).rejects.toMatchObject({
          code: 'P2010',
          meta: {
            code: 'P0001',
            message: `ERROR: ${mode === 'wrong-owner' ? 'AUTHORIZED_ACCEPT_KEY_INVALID' : mode === 'wrong-quote' ? 'AUTHORIZED_ACCEPT_OWNER_INVALID' : 'CUSTOMER_AUTHORIZATION_MISMATCH'}`,
          },
        });
      expect(
        await p.apiIdempotencyRecord.findUnique({ where: { id: record } }),
      ).toBeNull();
      expect(
        await p.authorizedQuoteAcceptance.findUnique({ where: { id } }),
      ).toBeNull();
    },
  );
});

describe('C2 final transaction deadline', () => {
  it('expiry during snapshot persistence rolls back at deferred SQL validation with business code', async () => {
    config.set('PREQUOTE_VALIDITY_MS', 1800);
    const { c, r } = await converted(),
      k = key();
    await p.$executeRawUnsafe(
      `CREATE FUNCTION c2_delay_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE deadline timestamp; BEGIN SELECT q."expiresAt" INTO deadline FROM "Dispatch" d JOIN "DeliveryQuote" q ON q.id=d."deliveryQuoteId" WHERE d.id=NEW."dispatchId" AND d."deliveryRequestId"='${c.deliveryRequestId}'::uuid; IF deadline IS NOT NULL THEN PERFORM pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM (deadline-(clock_timestamp() AT TIME ZONE 'UTC'))))+0.03); END IF; RETURN NEW; END $$`,
    );
    await p.$executeRawUnsafe(
      'CREATE TRIGGER "C2_delay_snapshot" AFTER INSERT ON "DispatchCreditSnapshot" FOR EACH ROW EXECUTE FUNCTION c2_delay_snapshot()',
    );
    try {
      const result = await accept(
        r.body.quote.publicId,
        attestation(r.body.quote),
        k,
      );
      expect([result.status, result.body.code]).toEqual([409, 'QUOTE_EXPIRED']);
      await noAward(c, k);
    } finally {
      await p.$executeRawUnsafe(
        'DROP TRIGGER "C2_delay_snapshot" ON "DispatchCreditSnapshot"',
      );
      await p.$executeRawUnsafe('DROP FUNCTION c2_delay_snapshot()');
    }
  });
});

describe('C2 deterministic accept/cancel and administrative lock order', () => {
  it('cancel transaction holds MDR first; concurrent accept sees terminal state after waiting', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const cancellation = p.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "DeliveryRequest" WHERE id=${c.deliveryRequestId}::uuid FOR UPDATE`;
        const now = new Date();
        await tx.deliveryRequest.update({
          where: { id: c.deliveryRequestId },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReason: 'C2 ordering',
          },
        });
        await tx.deliveryQuote.update({
          where: { id: c.deliveryQuoteId },
          data: {
            status: 'CANCELLED',
            cancelledAt: now,
            cancellationReason: 'DELIVERY_REQUEST_CANCELLED',
          },
        });
        ready();
        await gate;
      },
      { timeout: 10000 },
    );
    await locked;
    const pending = accept(r.body.quote.publicId, b, k).then((x) => x);
    try {
      await waitBlocked();
    } finally {
      release();
      await cancellation;
    }
    expect((await pending).body.code).toBe('QUOTE_NOT_ACCEPTABLE');
    await noAward(c, k);
    await cancel(r.body.deliveryRequestPublicId).expect(200);
  });
  it('accept holds MDR and credential first; concurrent cancel and revocation wait for its atomic commit', async () => {
    const { c, r } = await converted(),
      b = attestation(r.body.quote),
      k = key();
    const advisory = randomInt(100000000, 200000000);
    let ready!: () => void, release!: () => void;
    const locked = new Promise<void>((r) => (ready = r)),
      gate = new Promise<void>((r) => (release = r));
    const holding = p.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(${advisory}::int,1::int)`;
        ready();
        await gate;
      },
      { timeout: 10000 },
    );
    await locked;
    await p.$executeRawUnsafe(
      `CREATE FUNCTION c2_hold_accept() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM "Dispatch" WHERE id=NEW."dispatchId" AND "deliveryRequestId"='${c.deliveryRequestId}'::uuid) THEN PERFORM pg_advisory_xact_lock(${advisory},1); END IF; RETURN NEW; END $$`,
    );
    await p.$executeRawUnsafe(
      'CREATE TRIGGER "C2_hold_accept" AFTER INSERT ON "DispatchCreditSnapshot" FOR EACH ROW EXECUTE FUNCTION c2_hold_accept()',
    );
    try {
      const accepting = accept(r.body.quote.publicId, b, k).then((x) => x);
      await waitBlocked();
      const cancelling = cancel(r.body.deliveryRequestPublicId).then((x) => x);
      const revoking = p.integrationCredential
        .update({
          where: { id: credentials[0] },
          data: { status: 'REVOKED', revokedAt: new Date() },
        })
        .then((x) => x);
      let allWaiting = false;
      for (let i = 0; i < 100; i++) {
        const [row] = await p.$queryRaw<
          { n: bigint }[]
        >`SELECT count(*) n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`;
        if (Number(row.n) >= 3) {
          allWaiting = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(allWaiting).toBe(true);
      release();
      await holding;
      expect((await accepting).status).toBe(200);
      expect((await cancelling).status).toBe(200);
      await revoking;
      await accept(r.body.quote.publicId, b, k).expect(401);
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'ACTIVE', revokedAt: null },
      });
      expect((await status(r.body.deliveryRequestPublicId)).body).toMatchObject(
        { status: 'CANCELLED', deliveredAt: null },
      );
      expect(
        await p.authorizedQuoteAcceptance.count({
          where: { deliveryQuoteId: c.deliveryQuoteId },
        }),
      ).toBe(1);
    } finally {
      release();
      await holding;
      await p.$executeRawUnsafe(
        'DROP TRIGGER "C2_hold_accept" ON "DispatchCreditSnapshot"',
      );
      await p.$executeRawUnsafe('DROP FUNCTION c2_hold_accept()');
      await p.integrationCredential.update({
        where: { id: credentials[0] },
        data: { status: 'ACTIVE', revokedAt: null },
      });
    }
  });
});
