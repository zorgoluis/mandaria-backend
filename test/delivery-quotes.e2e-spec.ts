import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
// Expiration tests move the clock up to +50 min; keep human tokens valid meanwhile.
process.env.JWT_ACCESS_EXPIRES_IN = '3600';
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_Q_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@quotes.test`.toLowerCase();
const users = {
  sa: randomUUID(),
  providerAdmin: randomUUID(),
  driver: randomUUID(),
};
const clientIds: Record<string, string> = {};
const logs: string[] = [];
const secrets: string[] = [password];
const capture = (...args: unknown[]) => {
  logs.push(JSON.stringify(args));
};
const logger: LoggerService = {
  log: capture,
  error: capture,
  warn: capture,
  debug: capture,
  verbose: capture,
  fatal: capture,
};

/** Deterministic routing double: queued distances or RoutingErrors, optional latency. */
const routing = {
  name: 'fake',
  calls: 0,
  delayMs: 0,
  queue: [] as (number | Error)[],
  defaultDistance: 4700,
  async calculateRoute() {
    this.calls++;
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const next = this.queue.length ? this.queue.shift()! : this.defaultDistance;
    if (next instanceof Error) throw next;
    return {
      distanceMeters: next,
      durationSeconds: Math.round(next / 6),
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
let RoutingErrorClass: new (
  code: 'ROUTE_NOT_FOUND' | 'ROUTING_UNAVAILABLE',
  reason: string,
) => Error;

// Ocozocoautla-like and Tuxtla-like squares (test fixtures, not commercial boundaries).
const square = (
  minLng: number,
  minLat: number,
  maxLng: number,
  maxLat: number,
) => ({
  type: 'Polygon',
  coordinates: [
    [
      [minLng, minLat],
      [maxLng, minLat],
      [maxLng, maxLat],
      [minLng, maxLat],
      [minLng, minLat],
    ],
  ],
});
const OCOZ = { pickup: [16.7614, -93.3743], dropoff: [16.77, -93.36] };
const TUXTLA = [16.753, -93.116];
const OUTSIDE = [16.95, -93.7];
const ADDRESS = `Calle privada ${run} 42`;

let app: INestApplication;
const t: Record<string, string> = {};
const zones: Record<string, string> = {};
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;
async function bootstrap() {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { ROUTING_PROVIDER, RoutingError } =
    await import('../dist/routing/routing.types.js');
  RoutingErrorClass = RoutingError;
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
/** Fresh application per describe keeps the per-route throttles (30 quotes/min) out of the way. */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}
const stop = (
  type: string,
  sequence: number,
  [latitude, longitude]: number[],
) => ({
  type,
  sequence,
  address: ADDRESS,
  latitude,
  longitude,
  contactName: 'Contacto Prueba',
  contactPhone: '9619990000',
});
async function newRequest(
  token = t.A,
  pickup = OCOZ.pickup,
  dropoff = OCOZ.dropoff,
  financialContext: object = {
    goodsValue: '450.00',
    goodsPaymentMode: 'PREPAID',
    currency: 'MXN',
  },
) {
  const res = await api()
    .post('/api/v1/delivery-requests')
    .auth(token, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `Q-${run}`,
      stops: [stop('PICKUP', 1, pickup), stop('DROPOFF', 2, dropoff)],
      packages: [
        { category: 'FOOD', description: 'Pedido preparado', quantity: 2 },
      ],
      financialContext,
    })
    .expect(201);
  return res.body.publicId as string;
}
const quote = (requestId: string, token = t.A) =>
  api()
    .post(`/api/v1/delivery-requests/${requestId}/quotes`)
    .auth(token, bearer);
const accept = (quoteId: string, token = t.A) =>
  api().post(`/api/v1/delivery-quotes/${quoteId}/accept`).auth(token, bearer);
const getQuote = (quoteId: string, token = t.A) =>
  api().get(`/api/v1/delivery-quotes/${quoteId}`).auth(token, bearer);
const quotesOf = async (requestId: string) =>
  prisma.deliveryQuote.findMany({
    where: { deliveryRequest: { publicId: requestId } },
    orderBy: { createdAt: 'asc' },
  });
const bands = (amounts: string[]) =>
  amounts.map((amount, i) => ({
    minDistanceMeters: i * 2000,
    maxDistanceMeters: (i + 1) * 2000,
    amount,
  }));

beforeAll(async () => {
  // V1.10-C: accepting a quote opens a Dispatch, which needs ACTIVE credit policies.
  await ensureTestCreditPolicies(prisma);
  const passwordHash = await argon2.hash(password);
  await prisma.user.createMany({
    data: [
      { id: users.sa, email: mail('sa'), passwordHash, role: 'SUPER_ADMIN' },
      {
        id: users.providerAdmin,
        email: mail('pa'),
        passwordHash,
        role: 'PROVIDER_ADMIN',
      },
      { id: users.driver, email: mail('driver'), passwordHash, role: 'DRIVER' },
    ],
  });
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
  t.providerAdmin = await login(mail('pa'));
  t.driver = await login(mail('driver'));
  const client = async (name: string) => {
    const res = await api()
      .post('/api/v1/admin/integrations')
      .auth(t.sa, bearer)
      .send({ name, code: `E2E_QC_${name}_${run}` })
      .expect(201);
    clientIds[name] = res.body.id;
    return res.body.id as string;
  };
  const token = async (clientId: string, scopes: string[]) => {
    const credential = await api()
      .post(`/api/v1/admin/integrations/${clientId}/credentials`)
      .auth(t.sa, bearer)
      .send({ scopes })
      .expect(201);
    secrets.push(credential.body.clientSecret);
    return (
      await api()
        .post('/api/v1/integrations/token')
        .send({
          clientId: credential.body.clientId,
          clientSecret: credential.body.clientSecret,
        })
        .expect(200)
    ).body.accessToken as string;
  };
  const all = [
    'deliveries:create',
    'deliveries:read',
    'deliveries:cancel',
    'quotes:create',
    'quotes:read',
    'quotes:accept',
  ];
  t.A = await token(await client('A'), all);
  t.B = await token(await client('B'), all);
  const c = await client('C');
  t.creator = await token(c, ['deliveries:create', 'quotes:create']);
  t.reader = await token(c, ['quotes:read']);
  t.acceptor = await token(c, ['quotes:accept']);
  t.deliveriesOnly = await token(c, [
    'deliveries:create',
    'deliveries:read',
    'deliveries:cancel',
  ]);
  secrets.push(...Object.values(t));
  const zone = async (name: string, boundary: object) => {
    const res = await api()
      .post('/api/v1/admin/service-zones')
      .auth(t.sa, bearer)
      .send({
        code: `${PREFIX}${name}_${run}`,
        name: `Zona ${name}`,
        currency: 'MXN',
        boundary,
      })
      .expect(201);
    await api()
      .post(`/api/v1/admin/service-zones/${res.body.id}/activate`)
      .auth(t.sa, bearer)
      .expect(200);
    zones[name] = res.body.id;
  };
  await zone('OCOZ', square(-93.41, 16.735, -93.34, 16.79));
  await zone('TUXTLA', square(-93.2, 16.7, -93.05, 16.8));
  const plan = await api()
    .post('/api/v1/admin/rate-plans')
    .auth(t.sa, bearer)
    .send({
      serviceZoneId: zones.OCOZ,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 15,
      bands: bands(['35', '40', '50', '60', '70']),
    })
    .expect(201);
  await api()
    .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  await app.close();
}, 90000);

afterAll(async () => {
  vi.useRealTimers();
  const ids = Object.values(clientIds);
  const zoneIds = Object.values(zones);
  await prisma.deliveryQuote.deleteMany({
    where: {
      OR: [
        { serviceZoneId: { in: zoneIds } },
        { deliveryRequest: { integrationClientId: { in: ids } } },
      ],
    },
  });
  await prisma.deliveryRequest.deleteMany({
    where: { integrationClientId: { in: ids } },
  });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: { in: ids } },
  });
  await prisma.rateBand.deleteMany({
    where: { ratePlan: { serviceZoneId: { in: zoneIds } } },
  });
  await prisma.ratePlan.deleteMany({
    where: { serviceZoneId: { in: zoneIds } },
  });
  await prisma.serviceZone.deleteMany({ where: { id: { in: zoneIds } } });
  await prisma.integrationClient.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

describe.sequential('V1.6 quotes — distance bands', () => {
  withApp();
  it('maps route distances to [min, max) bands and rejects distances beyond the last band', async () => {
    for (const [distance, amount] of [
      [0, '35.00'],
      [1999, '35.00'],
      [2000, '40.00'],
      [3999, '40.00'],
      [4000, '50.00'],
      [9999, '70.00'],
    ] as const) {
      const requestId = await newRequest();
      routing.queue.push(distance);
      const res = await quote(requestId).expect(201);
      expect({
        distance,
        amount: res.body.amount,
        meters: res.body.distanceMeters,
      }).toEqual({ distance, amount, meters: distance });
    }
    for (const distance of [10000, 11400]) {
      const requestId = await newRequest();
      routing.queue.push(distance);
      const res = await quote(requestId).expect(422);
      expect(res.body.code).toBe('DISTANCE_NOT_SUPPORTED');
      expect(await quotesOf(requestId)).toHaveLength(0);
    }
  });
});

describe.sequential(
  'V1.6 quotes — lifecycle, snapshot and financial separation',
  () => {
    withApp();
    it('creates an OFFERED snapshot, reuses it without routing, accepts idempotently and freezes the price', async () => {
      const requestId = await newRequest();
      const before = routing.calls;
      const created = await quote(requestId).expect(201);
      expect(created.headers['quote-reused']).toBe('false');
      expect(created.body).toMatchObject({
        publicId: expect.stringMatching(/^MQ-\d{6,}$/),
        deliveryRequestPublicId: requestId,
        serviceType: 'LOCAL_DELIVERY',
        serviceZone: { code: `${PREFIX}OCOZ_${run}` },
        distanceMeters: 4700,
        durationSeconds: 783,
        amount: '50.00',
        currency: 'MXN',
        status: 'OFFERED',
        acceptedAt: null,
      });
      const ttl =
        Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt);
      expect(ttl).toBe(15 * 60_000);
      for (const hidden of [
        'id',
        'ratePlanId',
        'rateBandId',
        'deliveryRequestId',
        'routingProvider',
      ])
        expect(created.body).not.toHaveProperty(hidden);
      const reused = await quote(requestId).expect(200);
      expect(reused.headers['quote-reused']).toBe('true');
      expect(reused.body).toEqual(created.body);
      expect(routing.calls).toBe(before + 1);
      expect((await getQuote(created.body.publicId).expect(200)).body).toEqual(
        created.body,
      );
      const history = await api()
        .get(`/api/v1/delivery-requests/${requestId}/quotes`)
        .auth(t.A, bearer)
        .expect(200);
      expect(history.body.total).toBe(1);

      const accepted = await accept(created.body.publicId).expect(200);
      expect(accepted.body).toMatchObject({
        status: 'ACCEPTED',
        acceptedAt: expect.any(String),
        amount: '50.00',
      });
      const again = await accept(created.body.publicId).expect(200);
      expect(again.body.acceptedAt).toBe(accepted.body.acceptedAt);
      const afterAccept = await quote(requestId).expect(200);
      expect(afterAccept.body).toMatchObject({
        publicId: created.body.publicId,
        status: 'ACCEPTED',
      });
      expect(routing.calls).toBe(before + 1);

      // New tariff version: accepted snapshot unchanged, new quotes use the new ACTIVE plan.
      const active = await prisma.ratePlan.findFirstOrThrow({
        where: { serviceZoneId: zones.OCOZ, status: 'ACTIVE' },
      });
      const clone = await api()
        .post(`/api/v1/admin/rate-plans/${active.id}/clone`)
        .auth(t.sa, bearer)
        .expect(201);
      await api()
        .put(`/api/v1/admin/rate-plans/${clone.body.id}/bands`)
        .auth(t.sa, bearer)
        .send({ bands: bands(['35', '40', '80', '90', '99']) })
        .expect(200);
      await api()
        .post(`/api/v1/admin/rate-plans/${clone.body.id}/activate`)
        .auth(t.sa, bearer)
        .expect(200);
      const frozen = await getQuote(created.body.publicId).expect(200);
      expect(frozen.body.amount).toBe('50.00');
      const adminView = await api()
        .get(`/api/v1/admin/delivery-quotes/${created.body.publicId}`)
        .auth(t.sa, bearer)
        .expect(200);
      expect(adminView.body).toMatchObject({
        ratePlan: { id: active.id, version: active.version },
        rateBand: { minDistanceMeters: 4000, maxDistanceMeters: 6000 },
        routingProvider: 'fake',
      });
      const repriced = await quote(await newRequest()).expect(201);
      expect(repriced.body.amount).toBe('80.00');
      await expect(
        prisma.deliveryQuote.update({
          where: { publicId: created.body.publicId },
          data: { amount: '1.00' },
        }),
      ).rejects.toThrow(/DELIVERY_QUOTE_IMMUTABLE/);
    });

    it('keeps goods value and payment mode independent from the delivery price', async () => {
      for (const mode of ['PREPAID', 'COURIER_ADVANCE']) {
        const requestId = await newRequest(t.A, OCOZ.pickup, OCOZ.dropoff, {
          goodsValue: '450.00',
          goodsPaymentMode: mode,
          currency: 'MXN',
        });
        routing.queue.push(4700);
        const res = await quote(requestId).expect(201);
        expect(res.body.amount).toBe('80.00');
        const detail = await api()
          .get(`/api/v1/delivery-requests/${requestId}`)
          .auth(t.A, bearer)
          .expect(200);
        expect(detail.body.serviceType).toBe('LOCAL_DELIVERY');
        expect(detail.body.financialContext).toEqual({
          goodsValue: '450.00',
          goodsPaymentMode: mode,
          currency: 'MXN',
        });
        expect(detail.body).not.toHaveProperty('deliveryFee');
      }
    });
  },
);

describe.sequential('V1.6 quotes — expiration', () => {
  withApp();
  it('treats OFFERED past expiresAt as EXPIRED, rejects acceptance and prices a new quote', async () => {
    const real = Date.now();
    try {
      const requestId = await newRequest();
      const first = await quote(requestId).expect(201);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(real + 16 * 60_000);
      expect(
        (await getQuote(first.body.publicId).expect(200)).body.status,
      ).toBe('EXPIRED');
      const listed = await api()
        .get('/api/v1/admin/delivery-quotes')
        .query({ deliveryRequestPublicId: requestId, status: 'EXPIRED' })
        .auth(t.sa, bearer)
        .expect(200);
      expect(listed.body.total).toBe(1);
      const offered = await api()
        .get('/api/v1/admin/delivery-quotes')
        .query({ deliveryRequestPublicId: requestId, status: 'OFFERED' })
        .auth(t.sa, bearer)
        .expect(200);
      expect(offered.body.total).toBe(0);
      const calls = routing.calls;
      await accept(first.body.publicId)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('QUOTE_EXPIRED'));
      expect((await quotesOf(requestId))[0]).toMatchObject({
        status: 'EXPIRED',
        expiredAt: expect.any(Date),
      });
      const second = await quote(requestId).expect(201);
      expect(second.body.publicId).not.toBe(first.body.publicId);
      expect(routing.calls).toBe(calls + 1);

      // Lazy expiry on the create path as well.
      const other = await newRequest();
      const stale = await quote(other).expect(201);
      vi.setSystemTime(real + 32 * 60_000);
      const fresh = await quote(other).expect(201);
      expect(fresh.body.publicId).not.toBe(stale.body.publicId);
      expect((await quotesOf(other)).map((q) => q.status)).toEqual([
        'EXPIRED',
        'OFFERED',
      ]);
      expect(
        logs.some(
          (l) =>
            l.includes('DELIVERY_QUOTE_EXPIRED') &&
            l.includes(stale.body.publicId),
        ),
      ).toBe(true);

      // ACCEPTED never expires.
      await accept(fresh.body.publicId).expect(200);
      vi.setSystemTime(real + 50 * 60_000);
      expect(
        (await getQuote(fresh.body.publicId).expect(200)).body.status,
      ).toBe('ACCEPTED');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.sequential(
  'V1.6 quotes — domain failures never create quotes nor cancel the request',
  () => {
    withApp();
    const expectFailure = async (
      requestId: string,
      status: number,
      code: string,
    ) => {
      const res = await quote(requestId).expect(status);
      expect(res.body.code).toBe(code);
      expect(await quotesOf(requestId)).toHaveLength(0);
      expect(
        (
          await api()
            .get(`/api/v1/delivery-requests/${requestId}`)
            .auth(t.A, bearer)
            .expect(200)
        ).body.status,
      ).toBe('CREATED');
    };
    it('maps service area and cross-zone cases without calling routing', async () => {
      const calls = routing.calls;
      await expectFailure(
        await newRequest(t.A, OUTSIDE, OCOZ.dropoff),
        422,
        'OUT_OF_SERVICE_AREA',
      );
      await expectFailure(
        await newRequest(t.A, OCOZ.pickup, OUTSIDE),
        422,
        'OUT_OF_SERVICE_AREA',
      );
      await expectFailure(
        await newRequest(t.A, OCOZ.pickup, TUXTLA),
        422,
        'CROSS_ZONE_NOT_SUPPORTED',
      );
      await expectFailure(
        await newRequest(t.A, TUXTLA, [16.76, -93.1]),
        503,
        'RATE_CONFIGURATION_UNAVAILABLE',
      );
      const inactive = await newRequest();
      await api()
        .post(`/api/v1/admin/service-zones/${zones.OCOZ}/deactivate`)
        .auth(t.sa, bearer)
        .expect(200);
      try {
        await expectFailure(inactive, 422, 'OUT_OF_SERVICE_AREA');
      } finally {
        await api()
          .post(`/api/v1/admin/service-zones/${zones.OCOZ}/activate`)
          .auth(t.sa, bearer)
          .expect(200);
      }
      expect(routing.calls).toBe(calls);
    });
    it('maps routing failures, allows retrying, and refuses inconsistent active configuration', async () => {
      for (const [error, status, code] of [
        [
          new RoutingErrorClass('ROUTE_NOT_FOUND', 'NO_ROUTES'),
          422,
          'ROUTE_NOT_FOUND',
        ],
        [
          new RoutingErrorClass('ROUTING_UNAVAILABLE', 'TIMEOUT'),
          503,
          'ROUTING_UNAVAILABLE',
        ],
        [
          new RoutingErrorClass('ROUTING_UNAVAILABLE', 'HTTP_503'),
          503,
          'ROUTING_UNAVAILABLE',
        ],
        [
          new RoutingErrorClass('ROUTING_UNAVAILABLE', 'INVALID_RESPONSE'),
          503,
          'ROUTING_UNAVAILABLE',
        ],
        [new Error('unexpected adapter bug'), 503, 'ROUTING_UNAVAILABLE'],
      ] as const) {
        const requestId = await newRequest();
        routing.queue.push(error);
        await expectFailure(requestId, status, code);
        // Same request can be retried once routing recovers.
        const retried = await quote(requestId).expect(201);
        expect(retried.body.status).toBe('OFFERED');
      }
      const active = await prisma.ratePlan.findFirstOrThrow({
        where: { serviceZoneId: zones.OCOZ, status: 'ACTIVE' },
        include: { bands: { orderBy: { minDistanceMeters: 'asc' } } },
      });
      // Bands referenced by historical quotes cannot be deleted (composite FK, RESTRICT).
      await expect(
        prisma.rateBand.delete({ where: { id: active.bands[2].id } }),
      ).rejects.toThrow(/foreign key/);
      // Simulate an anomaly the API prevents: removing an unused middle band leaves a gap.
      const middle = active.bands[3];
      await prisma.rateBand.delete({ where: { id: middle.id } });
      try {
        await expectFailure(
          await newRequest(),
          503,
          'RATE_CONFIGURATION_INVALID',
        );
      } finally {
        await prisma.$transaction([
          prisma.$executeRawUnsafe(
            'ALTER TABLE "RateBand" DISABLE TRIGGER "RateBand_draft_only"',
          ),
          prisma.rateBand.create({
            data: {
              ratePlanId: middle.ratePlanId,
              minDistanceMeters: middle.minDistanceMeters,
              maxDistanceMeters: middle.maxDistanceMeters,
              amount: middle.amount,
              currency: middle.currency,
            },
          }),
          prisma.$executeRawUnsafe(
            'ALTER TABLE "RateBand" ENABLE TRIGGER "RateBand_draft_only"',
          ),
        ]);
      }
      const failures = logs
        .filter((l) => l.includes('DELIVERY_QUOTE_FAILED'))
        .join('\n');
      for (const code of [
        'OUT_OF_SERVICE_AREA',
        'CROSS_ZONE_NOT_SUPPORTED',
        'ROUTE_NOT_FOUND',
        'ROUTING_UNAVAILABLE',
        'RATE_CONFIGURATION_UNAVAILABLE',
        'RATE_CONFIGURATION_INVALID',
        'DISTANCE_NOT_SUPPORTED',
      ])
        expect(failures).toContain(`"reasonCode":"${code}"`);
      expect(logs.join('\n')).toContain('"event":"ROUTING_FAILED"');
    });
  },
);

describe.sequential('V1.6 quotes — cancellation and concurrency', () => {
  withApp();
  it('cancels OFFERED quotes with the request and preserves ACCEPTED history', async () => {
    const offeredRequest = await newRequest();
    const offered = await quote(offeredRequest).expect(201);
    await api()
      .post(`/api/v1/delivery-requests/${offeredRequest}/cancel`)
      .auth(t.A, bearer)
      .send({ reason: 'Cliente canceló' })
      .expect(200);
    expect(
      (await getQuote(offered.body.publicId).expect(200)).body,
    ).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'DELIVERY_REQUEST_CANCELLED',
    });
    await accept(offered.body.publicId)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('QUOTE_NOT_ACCEPTABLE'));
    await quote(offeredRequest)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('DELIVERY_REQUEST_NOT_QUOTABLE'));

    const acceptedRequest = await newRequest();
    const acceptedQuote = await quote(acceptedRequest).expect(201);
    await accept(acceptedQuote.body.publicId).expect(200);
    await api()
      .post(`/api/v1/admin/delivery-requests/${acceptedRequest}/cancel`)
      .auth(t.sa, bearer)
      .send({ reason: 'Operación' })
      .expect(200);
    expect(
      (await getQuote(acceptedQuote.body.publicId).expect(200)).body.status,
    ).toBe('ACCEPTED');
    expect(
      logs.some(
        (l) =>
          l.includes('DELIVERY_QUOTE_CANCELLED') &&
          l.includes(offered.body.publicId),
      ),
    ).toBe(true);
  });

  it('20 concurrent quote calls produce one quote and one routing call; concurrent accepts one ACCEPTED', async () => {
    const requestId = await newRequest();
    const calls = routing.calls;
    routing.delayMs = 150;
    try {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => quote(requestId)),
      );
      expect(results.map((r) => r.status).sort()).toEqual([
        ...Array(19).fill(200),
        201,
      ]);
      expect(new Set(results.map((r) => r.body.publicId)).size).toBe(1);
      expect(routing.calls).toBe(calls + 1);
      expect(await quotesOf(requestId)).toHaveLength(1);
      const publicId = results[0].body.publicId;
      const accepts = await Promise.all(
        Array.from({ length: 10 }, () => accept(publicId)),
      );
      expect(accepts.map((r) => r.status)).toEqual(Array(10).fill(200));
      expect(new Set(accepts.map((r) => r.body.acceptedAt)).size).toBe(1);
      expect(
        (await quotesOf(requestId)).filter((q) => q.status === 'ACCEPTED'),
      ).toHaveLength(1);
      expect(
        logs.filter(
          (l) => l.includes('DELIVERY_QUOTE_ACCEPTED') && l.includes(publicId),
        ),
      ).toHaveLength(1);
    } finally {
      routing.delayMs = 0;
    }
    // Quote racing a cancellation never leaves an OFFERED quote on a cancelled request.
    const raced = await newRequest();
    routing.delayMs = 100;
    try {
      await Promise.all([
        quote(raced),
        api()
          .post(`/api/v1/delivery-requests/${raced}/cancel`)
          .auth(t.A, bearer)
          .send({ reason: 'carrera' }),
      ]);
    } finally {
      routing.delayMs = 0;
    }
    expect(
      (await quotesOf(raced)).filter((q) => q.status === 'OFFERED'),
    ).toHaveLength(0);
    // Database backstops: a second OFFERED or ACCEPTED quote for the same request is impossible.
    const [existing] = await quotesOf(requestId);
    await expect(
      prisma.deliveryQuote.create({
        data: {
          publicId: `MQ-9${Date.now()}`,
          deliveryRequestId: existing.deliveryRequestId,
          serviceType: existing.serviceType,
          serviceZoneId: existing.serviceZoneId,
          ratePlanId: existing.ratePlanId,
          rateBandId: existing.rateBandId,
          distanceMeters: existing.distanceMeters,
          durationSeconds: existing.durationSeconds,
          amount: existing.amount,
          currency: existing.currency,
          routingProvider: existing.routingProvider,
          routeCalculatedAt: existing.routeCalculatedAt,
          expiresAt: existing.expiresAt,
          status: 'ACCEPTED',
          acceptedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/Unique constraint/);
  });
});

describe.sequential(
  'V1.6 quotes — isolation, scopes, roles, admin, audit and docs',
  () => {
    withApp();
    it('isolates IntegrationClients and enforces quote scopes independently', async () => {
      const own = await newRequest(t.A);
      const ownQuote = (await quote(own).expect(201)).body.publicId;
      await quote(own, t.B).expect(404);
      await getQuote(ownQuote, t.B).expect(404);
      await accept(ownQuote, t.B).expect(404);
      await api()
        .get(`/api/v1/delivery-requests/${own}/quotes`)
        .auth(t.B, bearer)
        .expect(404);
      await getQuote('MQ-999999999').expect(404);
      await getQuote('not-a-quote').expect(400);

      const cRequest = await newRequest(t.creator);
      const cQuote = (await quote(cRequest, t.creator).expect(201)).body
        .publicId;
      await getQuote(cQuote, t.creator).expect(403);
      await accept(cQuote, t.creator).expect(403);
      await quote(cRequest, t.reader).expect(403);
      await accept(cQuote, t.reader).expect(403);
      await getQuote(cQuote, t.reader).expect(200);
      await quote(cRequest, t.acceptor).expect(403);
      await getQuote(cQuote, t.acceptor).expect(403);
      await accept(cQuote, t.acceptor).expect(200);
      for (const call of [
        () => quote(cRequest, t.deliveriesOnly),
        () => getQuote(cQuote, t.deliveriesOnly),
        () => accept(cQuote, t.deliveriesOnly),
      ])
        expect((await call()).status).toBe(403);
    });

    it('keeps humans out of B2B quote routes, gives SUPER_ADMIN read-only quote administration', async () => {
      const requestId = await newRequest();
      const quoteId = (await quote(requestId).expect(201)).body.publicId;
      for (const token of [t.providerAdmin, t.driver, t.sa]) {
        await quote(requestId, token).expect(401);
        await getQuote(quoteId, token).expect(401);
        await accept(quoteId, token).expect(401);
      }
      for (const token of [t.providerAdmin, t.driver]) {
        await api()
          .get('/api/v1/admin/delivery-quotes')
          .auth(token, bearer)
          .expect(403);
        await api()
          .get(`/api/v1/admin/delivery-quotes/${quoteId}`)
          .auth(token, bearer)
          .expect(403);
        await api()
          .get(`/api/v1/admin/delivery-requests/${requestId}/quotes`)
          .auth(token, bearer)
          .expect(403);
      }
      await api()
        .get('/api/v1/admin/delivery-quotes')
        .auth(t.A, bearer)
        .expect(401);
      await api()
        .post(`/api/v1/admin/delivery-quotes/${quoteId}/accept`)
        .auth(t.sa, bearer)
        .expect(404);
      await api()
        .patch(`/api/v1/admin/delivery-quotes/${quoteId}`)
        .auth(t.sa, bearer)
        .send({ amount: '1' })
        .expect(404);
      await api()
        .delete(`/api/v1/admin/delivery-quotes/${quoteId}`)
        .auth(t.sa, bearer)
        .expect(404);
      const list = await api()
        .get('/api/v1/admin/delivery-quotes')
        .query({
          integrationClientId: clientIds.A,
          status: 'OFFERED',
          deliveryRequestPublicId: requestId,
        })
        .auth(t.sa, bearer)
        .expect(200);
      expect(
        list.body.items.map((q: { publicId: string }) => q.publicId),
      ).toEqual([quoteId]);
      expect(list.body.items[0]).toMatchObject({
        deliveryRequest: { integrationClientId: clientIds.A },
        ratePlan: { version: expect.any(Number) },
      });
      const perRequest = await api()
        .get(`/api/v1/admin/delivery-requests/${requestId}/quotes`)
        .auth(t.sa, bearer)
        .expect(200);
      expect(perRequest.body.total).toBe(1);
    });

    it('audits without coordinates, addresses or secrets and documents the V1.6 contract', async () => {
      const all = logs.join('\n');
      for (const event of [
        'DELIVERY_QUOTE_CREATED',
        'DELIVERY_QUOTE_ACCEPTED',
        'DELIVERY_QUOTE_EXPIRED',
        'DELIVERY_QUOTE_CANCELLED',
        'DELIVERY_QUOTE_FAILED',
        'ROUTING_CALCULATED',
      ])
        expect(all).toContain(event);
      for (const sensitive of [
        ADDRESS,
        '16.7614',
        '-93.3743',
        '9619990000',
        ...secrets,
      ])
        expect(all).not.toContain(sensitive);
      const docs = (await api().get('/docs-json').expect(200)).body;
      const create =
        docs.paths['/api/v1/delivery-requests/{publicId}/quotes'].post;
      expect(create['x-scopes']).toEqual(['quotes:create']);
      for (const status of [
        '200',
        '201',
        '401',
        '403',
        '404',
        '409',
        '422',
        '503',
      ])
        expect(create.responses[status]).toBeDefined();
      expect(
        docs.paths['/api/v1/delivery-quotes/{publicId}/accept'].post[
          'x-scopes'
        ],
      ).toEqual(['quotes:accept']);
      expect(
        docs.paths['/api/v1/delivery-quotes/{publicId}'].get['x-scopes'],
      ).toEqual(['quotes:read']);
      for (const path of [
        '/api/v1/admin/service-zones',
        '/api/v1/admin/rate-plans',
        '/api/v1/admin/delivery-quotes',
      ])
        expect(docs.paths[path].get['x-roles']).toEqual(['SUPER_ADMIN']);
      const schemas = docs.components.schemas;
      expect(schemas.DeliveryQuoteResponse.properties.status.enum).toEqual([
        'OFFERED',
        'ACCEPTED',
        'EXPIRED',
        'CANCELLED',
      ]);
      expect(schemas.RatePlanResponse.properties.status.enum).toEqual([
        'DRAFT',
        'ACTIVE',
        'INACTIVE',
      ]);
      expect(schemas.CreateRatePlanDto.properties.calculationType.enum).toEqual(
        ['DISTANCE_BANDS'],
      );
      expect(
        schemas.DeliveryRequestResponse.properties.serviceType.enum,
      ).toEqual(['LOCAL_DELIVERY']);
      expect(schemas.CreateCredentialDto.properties.scopes.items.enum).toEqual(
        expect.arrayContaining([
          'quotes:create',
          'quotes:read',
          'quotes:accept',
        ]),
      );
      expect(JSON.stringify(docs)).not.toMatch(/AIza|GOOGLE_ROUTES_API_KEY/);
    });
  },
);
