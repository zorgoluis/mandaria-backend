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
// Expiration tests move the clock forward; keep tokens valid meanwhile.
process.env.JWT_ACCESS_EXPIRES_IN = '3600';
process.env.INTEGRATION_ACCESS_TOKEN_EXPIRES_IN = '3600';
process.env.DISPATCH_TTL_MINUTES = '10';
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_D_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@dispatch.test`.toLowerCase();
const CONTACT_PHONE = '9617776655';
const CONTACT_NAME = `Contacto ${run}`;
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
  async calculateRoute() {
    return {
      distanceMeters: 4700,
      durationSeconds: 780,
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
// Far from the V1.6 E2E squares so both suites can keep ACTIVE zones concurrently.
const square = (lng: number, lat: number) => ({
  type: 'Polygon',
  coordinates: [
    [
      [lng, lat],
      [lng + 0.1, lat],
      [lng + 0.1, lat + 0.1],
      [lng, lat + 0.1],
      [lng, lat],
    ],
  ],
});
const ZONES = {
  MAIN: { lng: -101.0, lat: 20.0 },
  OTHER: { lng: -102.0, lat: 21.0 },
  EMPTY: { lng: -103.0, lat: 22.0 },
};
/** A: eligible, B: eligible, C: other zone only, D: SUSPENDED, F: coverage INACTIVE, P1/P2: extra eligible. */
const PROVIDERS = ['A', 'B', 'C', 'D', 'F', 'P1', 'P2'] as const;
type Key = (typeof PROVIDERS)[number];
const providerIds = {} as Record<Key, string>;
const zoneIds: Record<string, string> = {};
const users: string[] = [];
const clientIds: string[] = [];
const t: Record<string, string> = {};

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
/** Fresh app per describe resets per-IP throttles (login 5/min, quote 30/min). */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}
async function loginAll(entries: [string, string][]) {
  for (let i = 0; i < entries.length; i += 5) {
    app = await bootstrap();
    for (const [key, email] of entries.slice(i, i + 5))
      t[key] = (
        await api()
          .post('/api/v1/auth/login')
          .send({ email, password })
          .expect(200)
      ).body.accessToken;
    await app.close();
  }
}
const point = (zone: keyof typeof ZONES, d: number) => [
  ZONES[zone].lat + d,
  ZONES[zone].lng + d,
];
async function acceptedDispatch(
  zone: keyof typeof ZONES = 'MAIN',
  goods: object = {
    goodsValue: '450.00',
    goodsPaymentMode: 'COURIER_ADVANCE',
    currency: 'MXN',
  },
) {
  const quote = await quoted(zone, goods);
  const accepted = await api()
    .post(`/api/v1/delivery-quotes/${quote.publicId}/accept`)
    .auth(t.b2b, bearer)
    .expect(200);
  expect(accepted.body.status).toBe('ACCEPTED');
  const dispatch = await prisma.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: quote.id },
    include: { candidates: true },
  });
  return { ...quote, dispatch };
}
async function quoted(zone: keyof typeof ZONES, goods: object) {
  const [pLat, pLng] = point(zone, 0.02);
  const [dLat, dLng] = point(zone, 0.05);
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `ORD-${run}`,
      stops: [
        {
          type: 'PICKUP',
          sequence: 1,
          address: `Origen ${run}`,
          latitude: pLat,
          longitude: pLng,
          contactName: CONTACT_NAME,
          contactPhone: CONTACT_PHONE,
          instructions: 'Preguntar por caja 2',
        },
        {
          type: 'DROPOFF',
          sequence: 2,
          address: `Destino ${run}`,
          latitude: dLat,
          longitude: dLng,
          contactName: CONTACT_NAME,
          contactPhone: CONTACT_PHONE,
        },
      ],
      packages: [{ category: 'FOOD', description: 'Pedido', quantity: 1 }],
      financialContext: goods,
    })
    .expect(201);
  const q = await api()
    .post(`/api/v1/delivery-requests/${req.body.publicId}/quotes`)
    .auth(t.b2b, bearer)
    .expect(201);
  const row = await prisma.deliveryQuote.findUniqueOrThrow({
    where: { publicId: q.body.publicId },
  });
  return {
    requestPublicId: req.body.publicId as string,
    publicId: q.body.publicId as string,
    id: row.id,
  };
}
const claim = (key: string, dispatchId: string, providerId?: string) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/claim`)
    .query(providerId ? { providerId } : {})
    .auth(t[key], bearer);
const release = (
  key: string,
  dispatchId: string,
  reason = 'Sin unidad libre',
) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/release`)
    .auth(t[key], bearer)
    .send({ reason });
const detail = (key: string, dispatchId: string, providerId?: string) =>
  api()
    .get(`/api/v1/provider/dispatches/${dispatchId}`)
    .query(providerId ? { providerId } : {})
    .auth(t[key], bearer);

beforeAll(async () => {
  // V1.10-C: accepting a quote opens a Dispatch, which needs ACTIVE credit policies.
  await ensureTestCreditPolicies(prisma);
  const passwordHash = await argon2.hash(password);
  const user = async (
    key: string,
    role: 'SUPER_ADMIN' | 'PROVIDER_ADMIN' | 'DRIVER',
  ) => {
    const u = await prisma.user.create({
      data: { email: mail(key), passwordHash, role },
    });
    users.push(u.id);
    return u.id;
  };
  await user('sa', 'SUPER_ADMIN');
  await user('driver', 'DRIVER');
  for (const key of PROVIDERS) {
    const provider = await prisma.deliveryProvider.create({
      data: {
        name: `Proveedor ${key} ${run}`,
        code: `${PREFIX}${key}_${run}`,
        type: 'FLEET',
        status: key === 'D' ? 'SUSPENDED' : 'ACTIVE',
        maxDrivers: 5,
        maxVehicles: 5,
      },
    });
    providerIds[key] = provider.id;
    await prisma.providerMembership.create({
      data: {
        providerId: provider.id,
        userId: await user(`admin${key}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  // Admin of both A and B: must choose the provider explicitly.
  const both = await user('adminAB', 'PROVIDER_ADMIN');
  for (const key of ['A', 'B'] as const)
    await prisma.providerMembership.create({
      data: { providerId: providerIds[key], userId: both, role: 'ADMIN' },
    });
  await prisma.serviceZone.updateMany({
    where: { code: { startsWith: PREFIX }, status: 'ACTIVE' },
    data: { status: 'INACTIVE' },
  });
  await loginAll([
    ['sa', mail('sa')],
    ['A', mail('adminA')],
    ['B', mail('adminB')],
    ['C', mail('adminC')],
    ['D', mail('adminD')],
    ['F', mail('adminF')],
    ['P1', mail('adminP1')],
    ['P2', mail('adminP2')],
    ['AB', mail('adminAB')],
    ['driver', mail('driver')],
  ]);
  app = await bootstrap();
  for (const [name, { lng, lat }] of Object.entries(ZONES)) {
    const zone = await api()
      .post('/api/v1/admin/service-zones')
      .auth(t.sa, bearer)
      .send({
        code: `${PREFIX}${name}_${run}`,
        name: `Zona ${name}`,
        currency: 'MXN',
        boundary: square(lng, lat),
      })
      .expect(201);
    await api()
      .post(`/api/v1/admin/service-zones/${zone.body.id}/activate`)
      .auth(t.sa, bearer)
      .expect(200);
    zoneIds[name] = zone.body.id;
    const plan = await api()
      .post('/api/v1/admin/rate-plans')
      .auth(t.sa, bearer)
      .send({
        serviceZoneId: zone.body.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 60,
        bands: [
          { minDistanceMeters: 0, maxDistanceMeters: 50000, amount: '55' },
        ],
      })
      .expect(201);
    await api()
      .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
      .auth(t.sa, bearer)
      .expect(200);
  }
  const cover = (key: Key, zone: string) =>
    api()
      .post(`/api/v1/admin/providers/${providerIds[key]}/service-coverages`)
      .auth(t.sa, bearer)
      .send({ serviceZoneId: zoneIds[zone], serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  for (const key of ['A', 'B', 'D', 'P1', 'P2'] as const)
    await cover(key, 'MAIN');
  await cover('C', 'OTHER');
  const f = await cover('F', 'MAIN');
  await api()
    .patch(
      `/api/v1/admin/providers/${providerIds.F}/service-coverages/${f.body.id}`,
    )
    .auth(t.sa, bearer)
    .send({ status: 'INACTIVE' })
    .expect(200);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Dispatch client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  clientIds.push(client.body.id);
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
  t.b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  t.clientSecret = credential.body.clientSecret;
  await app.close();
}, 120000);

afterAll(async () => {
  vi.useRealTimers();
  const zones = Object.values(zoneIds);
  const providers = Object.values(providerIds);
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS e2e_force_dispatch_failure ON "Dispatch"',
  );
  await prisma.$executeRawUnsafe(
    'DROP FUNCTION IF EXISTS e2e_force_dispatch_failure()',
  );
  await prisma.deliveryQuote.deleteMany({
    where: {
      OR: [
        { serviceZoneId: { in: zones } },
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
  await prisma.providerServiceCoverage.deleteMany({
    where: { providerId: { in: providers } },
  });
  await prisma.rateBand.deleteMany({
    where: { ratePlan: { serviceZoneId: { in: zones } } },
  });
  await prisma.ratePlan.deleteMany({ where: { serviceZoneId: { in: zones } } });
  await prisma.serviceZone.deleteMany({ where: { id: { in: zones } } });
  await prisma.providerMembership.deleteMany({
    where: { providerId: { in: providers } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providers } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: clientIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

describe.sequential(
  'Quote ACCEPTED → Dispatch OPEN with a candidate snapshot',
  () => {
    withApp();

    it('accepting a quote opens its dispatch automatically with the configured TTL', async () => {
      const { dispatch, publicId } = await acceptedDispatch();
      const quote = await prisma.deliveryQuote.findUniqueOrThrow({
        where: { publicId },
      });
      expect(dispatch).toMatchObject({
        status: 'OPEN',
        claimedByProviderId: null,
        deliveryRequestId: quote.deliveryRequestId,
      });
      expect(dispatch.openedAt.getTime()).toBe(quote.acceptedAt!.getTime());
      expect(dispatch.expiresAt.getTime() - dispatch.openedAt.getTime()).toBe(
        10 * 60_000,
      );
      // Independent from the quote validity (60 minutes here).
      expect(dispatch.expiresAt.getTime()).not.toBe(quote.expiresAt.getTime());
    });

    it('offers only ACTIVE providers with ACTIVE coverage for the zone and service type', async () => {
      const { dispatch } = await acceptedDispatch();
      const offered = new Set(dispatch.candidates.map((c) => c.providerId));
      for (const key of ['A', 'B', 'P1', 'P2'] as const)
        expect(offered.has(providerIds[key]), key).toBe(true);
      for (const key of ['C', 'D', 'F'] as const)
        expect(offered.has(providerIds[key]), key).toBe(false);
      expect(dispatch.candidates.every((c) => c.status === 'OFFERED')).toBe(
        true,
      );
      // Snapshot: later coverage changes do not rewrite who it was offered to.
      const cov = await prisma.providerServiceCoverage.findFirstOrThrow({
        where: { providerId: providerIds.P2, serviceZoneId: zoneIds.MAIN },
      });
      await api()
        .patch(
          `/api/v1/admin/providers/${providerIds.P2}/service-coverages/${cov.id}`,
        )
        .auth(t.sa, bearer)
        .send({ status: 'INACTIVE' })
        .expect(200);
      const admin = await api()
        .get(`/api/v1/admin/dispatches/${dispatch.id}`)
        .auth(t.sa, bearer)
        .expect(200);
      expect(
        admin.body.candidates.map(
          (c: { provider: { id: string } }) => c.provider.id,
        ),
      ).toContain(providerIds.P2);
      // …but a no-longer-eligible candidate cannot claim.
      const res = await claim('P2', dispatch.id).expect(409);
      expect(res.body.code).toBe('PROVIDER_NOT_ELIGIBLE');
      await api()
        .patch(
          `/api/v1/admin/providers/${providerIds.P2}/service-coverages/${cov.id}`,
        )
        .auth(t.sa, bearer)
        .send({ status: 'ACTIVE' })
        .expect(200);
      const dup = await api()
        .post(`/api/v1/admin/providers/${providerIds.P2}/service-coverages`)
        .auth(t.sa, bearer)
        .send({ serviceZoneId: zoneIds.MAIN, serviceType: 'LOCAL_DELIVERY' })
        .expect(409);
      expect(dup.body.code).toBe('SERVICE_COVERAGE_EXISTS');
    });

    it('keeps the acceptance when nobody is eligible: OPEN dispatch without candidates, flagged noProviderAvailable', async () => {
      const { dispatch } = await acceptedDispatch('EMPTY');
      expect(dispatch.status).toBe('OPEN');
      expect(dispatch.candidates).toHaveLength(0);
      const admin = await api()
        .get(`/api/v1/admin/dispatches/${dispatch.id}`)
        .auth(t.sa, bearer)
        .expect(200);
      expect(admin.body).toMatchObject({
        status: 'OPEN',
        noProviderAvailable: true,
        candidates: [],
      });
    });

    it('repeated and concurrent acceptances keep 1 ACCEPTED quote and 1 dispatch', async () => {
      const { publicId, id, dispatch } = await acceptedDispatch();
      await api()
        .post(`/api/v1/delivery-quotes/${publicId}/accept`)
        .auth(t.b2b, bearer)
        .expect(200);
      expect(
        await prisma.dispatch.count({ where: { deliveryQuoteId: id } }),
      ).toBe(1);
      const fresh = await quoted('MAIN', {
        goodsPaymentMode: 'PREPAID',
        currency: 'MXN',
      });
      const responses = await Promise.all(
        Array.from({ length: 10 }, () =>
          api()
            .post(`/api/v1/delivery-quotes/${fresh.publicId}/accept`)
            .auth(t.b2b, bearer),
        ),
      );
      expect(responses.every((r) => r.status === 200)).toBe(true);
      expect(
        await prisma.dispatch.count({ where: { deliveryQuoteId: fresh.id } }),
      ).toBe(1);
      expect(
        await prisma.deliveryQuote.count({
          where: {
            deliveryRequest: { publicId: fresh.requestPublicId },
            status: 'ACCEPTED',
          },
        }),
      ).toBe(1);
      expect(dispatch.id).toBeTruthy();
    });

    it('is atomic: if the dispatch cannot be created the quote is not accepted', async () => {
      const fresh = await quoted('MAIN', {
        goodsPaymentMode: 'PREPAID',
        currency: 'MXN',
      });
      await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION e2e_force_dispatch_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW."deliveryQuoteId" = '${fresh.id}' THEN RAISE EXCEPTION 'forced dispatch failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER e2e_force_dispatch_failure BEFORE INSERT ON "Dispatch" FOR EACH ROW EXECUTE FUNCTION e2e_force_dispatch_failure()',
      );
      try {
        await api()
          .post(`/api/v1/delivery-quotes/${fresh.publicId}/accept`)
          .auth(t.b2b, bearer)
          .expect(500);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS e2e_force_dispatch_failure ON "Dispatch"',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS e2e_force_dispatch_failure()',
        );
      }
      expect(
        (
          await prisma.deliveryQuote.findUniqueOrThrow({
            where: { id: fresh.id },
          })
        ).status,
      ).toBe('OFFERED');
      expect(
        await prisma.dispatch.count({ where: { deliveryQuoteId: fresh.id } }),
      ).toBe(0);
      await api()
        .post(`/api/v1/delivery-quotes/${fresh.publicId}/accept`)
        .auth(t.b2b, bearer)
        .expect(200);
      expect(
        await prisma.dispatch.count({ where: { deliveryQuoteId: fresh.id } }),
      ).toBe(1);
    });
  },
);

describe.sequential('Provider claiming', () => {
  withApp();
  let target: string;

  it('Provider Admin A lists available work (OFFER view without contacts) and claims it', async () => {
    target = (await acceptedDispatch()).dispatch.id;
    const list = await api()
      .get('/api/v1/provider/dispatches')
      .query({ view: 'AVAILABLE', pageSize: 100 })
      .auth(t.A, bearer)
      .expect(200);
    const item = list.body.items.find((d: { id: string }) => d.id === target);
    expect(item).toMatchObject({
      status: 'OPEN',
      access: 'OFFER',
      myCandidate: { status: 'OFFERED' },
      service: {
        deliveryFee: { amount: '55.00', currency: 'MXN' },
        goods: {
          paymentMode: 'COURIER_ADVANCE',
          value: '450.00',
          driverAdvancesGoods: true,
        },
      },
    });
    const offerJson = JSON.stringify(item);
    for (const hidden of [
      CONTACT_PHONE,
      CONTACT_NAME,
      'Preguntar por caja',
      `ORD-${run}`,
      clientIds[0],
    ])
      expect(offerJson).not.toContain(hidden);
    const claimed = await claim('A', target).expect(200);
    expect(claimed.body).toMatchObject({
      status: 'CLAIMED',
      access: 'OWNER',
      claimedByMe: true,
    });
    expect(JSON.stringify(claimed.body)).toContain(CONTACT_PHONE);
    expect(JSON.stringify(claimed.body)).not.toContain(clientIds[0]);
    const row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: target },
      include: { candidates: true },
    });
    expect(row).toMatchObject({
      status: 'CLAIMED',
      claimedByProviderId: providerIds.A,
    });
    expect(row.claimedAt).not.toBeNull();
    const byProvider = new Map(
      row.candidates.map((c) => [c.providerId, c.status]),
    );
    expect(byProvider.get(providerIds.A)).toBe('CLAIMED');
    expect(byProvider.get(providerIds.B)).toBe('OFFERED');
    // Idempotent for the winner; everybody else gets a conflict and sees only a summary.
    await claim('A', target).expect(200);
    const lost = await claim('B', target).expect(409);
    expect(lost.body.code).toBe('DISPATCH_ALREADY_CLAIMED');
    const other = await detail('B', target).expect(200);
    expect(other.body).toMatchObject({
      status: 'CLAIMED',
      access: 'SUMMARY',
      service: null,
      claimedByMe: false,
    });
    const claimedList = await api()
      .get('/api/v1/provider/dispatches')
      .query({ view: 'CLAIMED' })
      .auth(t.A, bearer)
      .expect(200);
    expect(claimedList.body.items.map((d: { id: string }) => d.id)).toContain(
      target,
    );
    const availableB = await api()
      .get('/api/v1/provider/dispatches')
      .query({ view: 'AVAILABLE', pageSize: 100 })
      .auth(t.B, bearer)
      .expect(200);
    expect(
      availableB.body.items.map((d: { id: string }) => d.id),
    ).not.toContain(target);
  });

  it('blocks non-candidates, wrong memberships, SUPER_ADMIN, DRIVER and IntegrationClient', async () => {
    const { dispatch } = await acceptedDispatch();
    for (const key of ['C', 'D', 'F']) {
      await detail(key, dispatch.id).expect(404);
      const res = await claim(key, dispatch.id).expect(404);
      expect(res.body.code).toBe('HTTP_404');
      const list = await api()
        .get('/api/v1/provider/dispatches')
        .auth(t[key], bearer)
        .expect(200);
      expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(
        dispatch.id,
      );
    }
    // Admin A cannot act for Provider B, even though B is a candidate.
    await claim('A', dispatch.id, providerIds.B).expect(403);
    await detail('A', dispatch.id, providerIds.B).expect(403);
    await claim('sa', dispatch.id).expect(403);
    await claim('driver', dispatch.id).expect(403);
    await claim('b2b', dispatch.id).expect(401);
    await api()
      .get('/api/v1/provider/dispatches')
      .auth(t.b2b, bearer)
      .expect(401);
    await api().get('/api/v1/admin/dispatches').auth(t.A, bearer).expect(403);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/claim`)
      .auth(t.A, bearer)
      .send({ providerId: providerIds.B })
      .expect(400);
    // Multiple memberships: the provider must be chosen, and the choice is validated.
    const ambiguous = await claim('AB', dispatch.id).expect(409);
    expect(ambiguous.body.message).toMatch(/providerId/);
    await claim('AB', dispatch.id, providerIds.C).expect(403);
    const res = await claim('AB', dispatch.id, providerIds.B).expect(200);
    expect(res.body.claimedByMe).toBe(true);
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
        .claimedByProviderId,
    ).toBe(providerIds.B);
  });

  it('release: A claims → A releases → A cannot reclaim → B claims; only the owner releases', async () => {
    const { dispatch } = await acceptedDispatch();
    await claim('A', dispatch.id).expect(200);
    await release('B', dispatch.id).expect(409);
    await release('C', dispatch.id).expect(404);
    for (const reason of ['no', 'x'.repeat(501)])
      expect(
        (await release('A', dispatch.id, reason).expect(400)).body.code,
      ).toBe('VALIDATION_ERROR');
    const released = await release(
      'A',
      dispatch.id,
      '  Unidad descompuesta  ',
    ).expect(200);
    expect(released.body).toMatchObject({
      status: 'OPEN',
      access: 'SUMMARY',
      claimedByMe: false,
      myCandidate: { status: 'RELEASED', releaseReason: 'Unidad descompuesta' },
    });
    let row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    expect(row).toMatchObject({
      status: 'OPEN',
      claimedByProviderId: null,
      claimedAt: null,
    });
    expect((await release('A', dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
    );
    expect((await claim('A', dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_RECLAIM_NOT_ALLOWED',
    );
    await claim('B', dispatch.id).expect(200);
    // Concurrent releases by the owner: exactly one applies.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => release('B', dispatch.id)),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(
      results.filter(
        (r) =>
          r.status === 409 &&
          r.body.code === 'DISPATCH_NOT_CLAIMED_BY_PROVIDER',
      ),
    ).toHaveLength(4);
    row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    const candidates = await prisma.dispatchCandidate.findMany({
      where: { dispatchId: dispatch.id },
    });
    const status = new Map(candidates.map((c) => [c.providerId, c.status]));
    expect(row).toMatchObject({ status: 'OPEN', claimedByProviderId: null });
    expect(status.get(providerIds.A)).toBe('RELEASED');
    expect(status.get(providerIds.B)).toBe('RELEASED');
    expect(status.get(providerIds.P1)).toBe('OFFERED');
    expect(candidates.filter((c) => c.status === 'CLAIMED')).toHaveLength(0);
  });
});

// Own application: 3 rounds × 15 simultaneous claims stay under the real 60/min claim limit.
describe.sequential('Claim concurrency', () => {
  withApp();

  it('several providers claiming at once: exactly one winner, consistent database', async () => {
    for (let round = 0; round < 3; round++) {
      const { dispatch } = await acceptedDispatch();
      const attempts = ['A', 'B', 'P1', 'P2', 'AB'].flatMap((key) =>
        Array.from({ length: 3 }, () => ({
          key,
          send: () =>
            claim(key, dispatch.id, key === 'AB' ? providerIds.B : undefined),
        })),
      );
      const responses = await Promise.all(attempts.map((a) => a.send()));
      const row = await prisma.dispatch.findUniqueOrThrow({
        where: { id: dispatch.id },
        include: { candidates: true },
      });
      expect(row.status).toBe('CLAIMED');
      const winner = row.claimedByProviderId!;
      const winnerKeys = attempts
        .map((a, i) => ({ ...a, res: responses[i] }))
        .filter((a) => a.res.status === 200)
        .map((a) => a.key);
      // Every 200 belongs to the winning provider (its duplicates are idempotent).
      const keyProvider = (key: string) =>
        key === 'AB' ? providerIds.B : providerIds[key as Key];
      expect(new Set(winnerKeys.map(keyProvider))).toEqual(new Set([winner]));
      for (const [i, a] of attempts.entries())
        if (keyProvider(a.key) !== winner) {
          expect(responses[i].status).toBe(409);
          expect(responses[i].body.code).toBe('DISPATCH_ALREADY_CLAIMED');
        }
      expect(
        row.candidates
          .filter((c) => c.status === 'CLAIMED')
          .map((c) => c.providerId),
      ).toEqual([winner]);
    }
  });
});

describe.sequential('Expiration and cancellation', () => {
  withApp();

  it('an expired dispatch cannot be claimed and is persisted as EXPIRED', async () => {
    const { dispatch } = await acceptedDispatch();
    const other = await acceptedDispatch();
    await claim('A', other.dispatch.id).expect(200);
    const real = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(real + 11 * 60_000);
      const list = await api()
        .get('/api/v1/provider/dispatches')
        .query({ view: 'AVAILABLE', pageSize: 100 })
        .auth(t.B, bearer)
        .expect(200);
      expect(list.body.items.map((d: { id: string }) => d.id)).not.toContain(
        dispatch.id,
      );
      expect((await detail('B', dispatch.id).expect(200)).body.status).toBe(
        'EXPIRED',
      );
      expect((await claim('B', dispatch.id).expect(409)).body.code).toBe(
        'DISPATCH_EXPIRED',
      );
      const row = await prisma.dispatch.findUniqueOrThrow({
        where: { id: dispatch.id },
      });
      expect(row.status).toBe('EXPIRED');
      expect(row.expiredAt).not.toBeNull();
      expect((await claim('P1', dispatch.id).expect(409)).body.code).toBe(
        'DISPATCH_EXPIRED',
      );
      // A claim survives the window; releasing after it expires the dispatch instead of reopening.
      expect(
        (await detail('A', other.dispatch.id).expect(200)).body.status,
      ).toBe('CLAIMED');
      const released = await release('A', other.dispatch.id).expect(200);
      expect(released.body.status).toBe('EXPIRED');
      expect((await claim('B', other.dispatch.id).expect(409)).body.code).toBe(
        'DISPATCH_EXPIRED',
      );
      const after = await prisma.dispatch.findUniqueOrThrow({
        where: { id: other.dispatch.id },
      });
      expect(after).toMatchObject({
        status: 'EXPIRED',
        claimedByProviderId: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelling the delivery request cancels OPEN and CLAIMED dispatches, keeping the claim owner', async () => {
    const open = await acceptedDispatch();
    await api()
      .post(`/api/v1/delivery-requests/${open.requestPublicId}/cancel`)
      .auth(t.b2b, bearer)
      .send({ reason: 'Cliente canceló' })
      .expect(200);
    const openRow = await prisma.dispatch.findUniqueOrThrow({
      where: { id: open.dispatch.id },
    });
    expect(openRow).toMatchObject({
      status: 'CANCELLED',
      cancellationReason: 'DELIVERY_REQUEST_CANCELLED',
    });
    expect((await claim('A', open.dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_CANCELLED',
    );

    const claimed = await acceptedDispatch();
    await claim('B', claimed.dispatch.id).expect(200);
    await api()
      .post(`/api/v1/admin/delivery-requests/${claimed.requestPublicId}/cancel`)
      .auth(t.sa, bearer)
      .send({ reason: 'Cancelado por operación' })
      .expect(200);
    const row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: claimed.dispatch.id },
    });
    expect(row).toMatchObject({
      status: 'CANCELLED',
      claimedByProviderId: providerIds.B,
    });
    expect(
      (await detail('B', claimed.dispatch.id).expect(200)).body,
    ).toMatchObject({
      status: 'CANCELLED',
      access: 'OWNER',
      claimedByMe: true,
    });
    expect((await claim('A', claimed.dispatch.id).expect(409)).body.code).toBe(
      'DISPATCH_CANCELLED',
    );
    expect(
      (await release('B', claimed.dispatch.id).expect(409)).body.code,
    ).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    const admin = await api()
      .get('/api/v1/admin/dispatches')
      .query({
        status: 'CANCELLED',
        providerId: providerIds.B,
        deliveryRequestPublicId: claimed.requestPublicId,
      })
      .auth(t.sa, bearer)
      .expect(200);
    expect(admin.body.items).toHaveLength(1);
    expect(admin.body.items[0]).toMatchObject({
      claimedByProviderId: providerIds.B,
      status: 'CANCELLED',
    });
  });

  it('enforces dispatch invariants in PostgreSQL', async () => {
    const { dispatch, id } = await acceptedDispatch();
    const fresh = await quoted('MAIN', {
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
    });
    const reqId = (
      await prisma.deliveryQuote.findUniqueOrThrow({ where: { id: fresh.id } })
    ).deliveryRequestId;
    const now = new Date();
    const later = new Date(now.getTime() + 60_000);
    // Second dispatch for a quote, dispatch for a non-ACCEPTED quote.
    await expect(
      prisma.dispatch.create({
        data: {
          deliveryRequestId: dispatch.deliveryRequestId,
          deliveryQuoteId: id,
          openedAt: now,
          expiresAt: later,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.dispatch.create({
        data: {
          deliveryRequestId: reqId,
          deliveryQuoteId: fresh.id,
          openedAt: now,
          expiresAt: later,
        },
      }),
    ).rejects.toThrow(/DISPATCH_INVALID/);
    await expect(
      prisma.dispatch.update({
        where: { id: dispatch.id },
        data: { expiresAt: later },
      }),
    ).rejects.toThrow(/DISPATCH_IMMUTABLE/);
    // CLAIMED without a CLAIMED candidate, or two CLAIMED candidates.
    await expect(
      prisma.dispatch.update({
        where: { id: dispatch.id },
        data: {
          status: 'CLAIMED',
          claimedByProviderId: providerIds.A,
          claimedAt: now,
        },
      }),
    ).rejects.toThrow(/DISPATCH_INVALID/);
    await prisma.dispatchCandidate.update({
      where: {
        dispatchId_providerId: {
          dispatchId: dispatch.id,
          providerId: providerIds.A,
        },
      },
      data: { status: 'CLAIMED', claimedAt: now },
    });
    await expect(
      prisma.dispatchCandidate.update({
        where: {
          dispatchId_providerId: {
            dispatchId: dispatch.id,
            providerId: providerIds.B,
          },
        },
        data: { status: 'CLAIMED', claimedAt: now },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.dispatchCandidate.update({
        where: {
          dispatchId_providerId: {
            dispatchId: dispatch.id,
            providerId: providerIds.A,
          },
        },
        data: { status: 'OFFERED', claimedAt: null },
      }),
    ).rejects.toThrow(/DISPATCH_CANDIDATE_IMMUTABLE/);
    await expect(
      prisma.dispatchCandidate.create({
        data: {
          dispatchId: dispatch.id,
          providerId: providerIds.C,
          offeredAt: now,
          status: 'CLAIMED',
          claimedAt: now,
        },
      }),
    ).rejects.toThrow(/DISPATCH_CANDIDATE_INVALID/);
  });
});

describe('Audit', () => {
  it('records dispatch events without tokens, secrets or customer contact data', () => {
    const joined = logs.join('\n');
    for (const event of [
      'DISPATCH_OPENED',
      'DISPATCH_CLAIMED',
      'DISPATCH_RELEASED',
      'DISPATCH_EXPIRED',
      'DISPATCH_CANCELLED',
      'PROVIDER_COVERAGE_CREATED',
    ])
      expect(joined, event).toContain(event);
    expect(
      logs.some(
        (l) =>
          l.includes('DISPATCH_CLAIMED') &&
          l.includes('"providerId"') &&
          l.includes('"actorUserId"'),
      ),
    ).toBe(true);
    expect(
      logs.some(
        (l) =>
          l.includes('DISPATCH_RELEASED') && l.includes('Unidad descompuesta'),
      ),
    ).toBe(true);
    for (const secret of [
      password,
      t.b2b,
      t.A,
      t.sa,
      t.clientSecret,
      CONTACT_PHONE,
      CONTACT_NAME,
    ])
      expect(joined.includes(secret), 'sensitive value in logs').toBe(false);
  });
});
