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
  routingProvider: 'c4-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'c4-controlled',
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
async function execution(k: string) {
  return p.apiIdempotencyRecord.findUnique({
    where: {
      integrationClientId_key: { integrationClientId: clients[0], key: k },
    },
    include: { execution: true },
  });
}
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
      code: `C4_${run}_${i}`,
      name: 'C4 fixture',
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
      code: `C4_${run}`,
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
beforeEach(() => {
  vi.restoreAllMocks();
  routing.calculateRoute.mockReset().mockImplementation(async () => route());
  setConfig('PREQUOTE_AUTHORIZED_ACCEPT_ENABLED', true);
  setConfig('PREQUOTE_CONVERSION_ENABLED', true);
  setConfig('PREQUOTE_ENABLED', true);
  setConfig('PREQUOTE_VALIDITY_MS', 900000);
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

describe('C4 definitive cancellation and renewed consent', () => {
  it.each(['equal', 'lower'] as const)(
    'new MQ at %s price rejects old attestation and requires new exact consent',
    async (price) => {
      setConfig('PREQUOTE_VALIDITY_MS', 1800);
      const old = await converted(),
        oldBody = attestation(old.r.body.quote);
      await new Promise((r) =>
        setTimeout(
          r,
          Math.max(
            0,
            old.c.deliveryQuote.expiresAt.getTime() - Date.now() + 35,
          ),
        ),
      );
      const cancelled = await cancel(old.r.body.deliveryRequestPublicId).expect(
        200,
      );
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(cancelled.body.cancelledAt).toBeTruthy();
      expect(
        (await status(old.r.body.deliveryRequestPublicId)).body,
      ).toMatchObject({ status: 'CANCELLED', deliveredAt: null });
      const oldSnapshot = await p.deliveryQuote.findUniqueOrThrow({
        where: { id: old.c.deliveryQuoteId },
      });
      expect(oldSnapshot.expiresAt).toEqual(old.c.deliveryQuote.expiresAt);
      expect((await convert(old.id)).body.code).toBe(
        'PREQUOTE_ALREADY_CONVERTED',
      );
      setConfig('PREQUOTE_VALIDITY_MS', 900000);
      if (price === 'lower') {
        await p.ratePlan.update({
          where: { id: planId },
          data: { status: 'INACTIVE', deactivatedAt: new Date() },
        });
        const replacement = await p.ratePlan.create({
          data: {
            serviceZoneId: zoneId,
            serviceType: 'LOCAL_DELIVERY',
            version: 2,
            status: 'DRAFT',
            currency: 'MXN',
            quoteValidityMinutes: 15,
            bands: {
              create: {
                minDistanceMeters: 0,
                maxDistanceMeters: 10000,
                amount: '10.00',
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
      }
      const fresh = await converted();
      expect(fresh.c.deliveryRequest.externalReference).toBe(
        old.c.deliveryRequest.externalReference,
      );
      expect(fresh.c.deliveryQuoteId).not.toBe(old.c.deliveryQuoteId);
      if (price === 'equal')
        expect(fresh.r.body.quote.amount).toBe(old.r.body.quote.amount);
      else
        expect(Number(fresh.r.body.quote.amount)).toBeLessThan(
          Number(old.r.body.quote.amount),
        );
      const rejectedKey = key();
      const rejected = await accept(
        fresh.r.body.quote.publicId,
        oldBody,
        rejectedKey,
      );
      expect([rejected.status, rejected.body.code]).toEqual([
        409,
        'CUSTOMER_AUTHORIZATION_MISMATCH',
      ]);
      await noAward(fresh.c, rejectedKey);
      const freshBody = attestation(fresh.r.body.quote);
      freshBody.customerAuthorization.reference = 'new-explicit-consent';
      const ledger = await p.creditLedgerEntry.count();
      await accept(fresh.r.body.quote.publicId, freshBody).expect(200);
      expect(await p.creditLedgerEntry.count()).toBe(ledger);
      expect(
        (
          await p.deliveryFinancialContext.findUniqueOrThrow({
            where: { deliveryRequestId: fresh.c.deliveryRequestId },
          })
        ).goodsValue?.toFixed(2),
      ).toBe('150.00');
      expect(
        await p.deliveryQuote.findUniqueOrThrow({
          where: { id: old.c.deliveryQuoteId },
        }),
      ).toEqual(oldSnapshot);
      await cancel(fresh.r.body.deliveryRequestPublicId).expect(200);
    },
  );
});
