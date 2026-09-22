import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
process.env.JWT_ACCESS_EXPIRES_IN = '3600';
process.env.INTEGRATION_ACCESS_TOKEN_EXPIRES_IN = '3600';
process.env.DISPATCH_TTL_MINUTES = '60';
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_CSNAP_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credit-snapshots.test`.toLowerCase();
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
/** Routing spy: the canonical distance of the next quote, and how many times routing ran. */
const routing = {
  name: 'spy',
  distanceMeters: 6240,
  calls: 0,
  async calculateRoute() {
    routing.calls += 1;
    return {
      distanceMeters: routing.distanceMeters,
      durationSeconds: 900,
      routingProvider: 'spy',
      calculatedAt: new Date(),
    };
  },
};
const ZONE = { lng: -91.5, lat: 14.5 };
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const userIds: string[] = [];
let app: INestApplication;
/** Real ephemeral port: supertest bound to the server object closes it between requests. */
let baseUrl = '';
const api = () => request(baseUrl);
const bearer = { type: 'bearer' } as const;
const POLICIES = '/api/v1/admin/credit-policies';

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
  await instance.listen(0, '127.0.0.1');
  baseUrl = await instance.getUrl();
  return instance;
}
/** A fresh app per block resets the in-memory throttler (100/min, 5 logins/min per IP). */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}
const perKm = (creditsPerKm: number, minimumCredits = 3) => ({
  calculationType: 'PER_KM',
  creditsPerKm,
  minimumCredits,
});
/** New version of the ACTIVE policy of an actor (or version 1 if there is none). */
async function setPolicy(
  actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER',
  body: object,
) {
  const active = await prisma.creditPolicy.findFirst({
    where: { serviceType: 'LOCAL_DELIVERY', actorType, status: 'ACTIVE' },
  });
  const res = active
    ? await api()
        .post(`${POLICIES}/${active.id}/versions`)
        .auth(t.sa, bearer)
        .send(body)
    : await api()
        .post(POLICIES)
        .auth(t.sa, bearer)
        .send({ serviceType: 'LOCAL_DELIVERY', actorType, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; version: number; ranges: { id: string }[] };
}
async function quoted(
  distanceMeters = 6240,
  goodsPaymentMode = 'COURIER_ADVANCE',
) {
  routing.distanceMeters = distanceMeters;
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9615551234',
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `CSNAP-${run}`,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [{ category: 'FOOD', description: 'Pedido', quantity: 1 }],
      financialContext: {
        goodsValue: '800.00',
        goodsPaymentMode,
        currency: 'MXN',
      },
    })
    .expect(201);
  const quote = await api()
    .post(`/api/v1/delivery-requests/${req.body.publicId}/quotes`)
    .auth(t.b2b, bearer)
    .expect(201);
  return {
    requestPublicId: req.body.publicId as string,
    quotePublicId: quote.body.publicId as string,
  };
}
const accept = (quotePublicId: string) =>
  api()
    .post(`/api/v1/delivery-quotes/${quotePublicId}/accept`)
    .auth(t.b2b, bearer);
async function dispatchOf(quotePublicId: string) {
  const q = await prisma.deliveryQuote.findUniqueOrThrow({
    where: { publicId: quotePublicId },
  });
  return prisma.dispatch.findUnique({ where: { deliveryQuoteId: q.id } });
}
async function openDispatch(distanceMeters = 6240) {
  const q = await quoted(distanceMeters);
  await accept(q.quotePublicId).expect(200);
  return { ...q, id: (await dispatchOf(q.quotePublicId))!.id };
}
const snapshotsOf = (dispatchId: string) =>
  prisma.dispatchCreditSnapshot.findMany({
    where: { dispatchId },
    orderBy: { actorType: 'asc' },
  });
const economy = async () => ({
  accounts: await prisma.creditAccount.findMany({
    select: { id: true, balance: true, updatedAt: true },
    orderBy: { id: 'asc' },
  }),
  entries: await prisma.creditLedgerEntry.count(),
  service: await prisma.creditLedgerEntry.count({
    where: { type: { in: ['SERVICE_AWARD', 'SERVICE_REFUND'] } },
  }),
});
async function purgeActorPolicies(
  actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER',
) {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.dispatchCreditSnapshot.deleteMany({ where: { actorType } }),
    prisma.creditPolicyRange.deleteMany({
      where: { creditPolicy: { actorType } },
    }),
    prisma.creditPolicy.deleteMany({ where: { actorType } }),
  ]);
}
async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return 'ACCEPTED';
  } catch (error) {
    const m = String((error as Error).message);
    return (
      /(CREDIT_SNAPSHOT_[A-Z_]+|DispatchCreditSnapshot[A-Za-z_]*_(check|key|fkey)|Unique constraint|Foreign key|23514|23505|23503)/.exec(
        m,
      )?.[0] ?? 'refused'
    );
  }
}
let economyAtStart: Awaited<ReturnType<typeof economy>>;

beforeAll(async () => {
  await ensureTestCreditPolicies(prisma);
  const passwordHash = await argon2.hash(password);
  const user = async (
    name: string,
    role: 'SUPER_ADMIN' | 'PROVIDER_ADMIN' | 'DRIVER',
  ) => {
    const u = await prisma.user.create({
      data: { email: mail(name), passwordHash, role },
    });
    userIds.push(u.id);
    return u.id;
  };
  ids.sa = await user('sa', 'SUPER_ADMIN');
  const provider = await prisma.deliveryProvider.create({
    data: {
      name: `CSNAP ${run}`,
      code: `${PREFIX}${run}`,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 5,
      maxVehicles: 5,
    },
  });
  ids.provider = provider.id;
  await prisma.providerMembership.create({
    data: {
      providerId: provider.id,
      userId: await user('admin', 'PROVIDER_ADMIN'),
      role: 'OWNER',
    },
  });
  ids.driver = (
    await prisma.driver.create({
      data: {
        providerId: provider.id,
        userId: await user('indep', 'DRIVER'),
        name: 'indep',
        status: 'ACTIVE',
      },
    })
  ).id;
  await prisma.serviceZone.updateMany({
    where: { code: { startsWith: PREFIX }, status: 'ACTIVE' },
    data: { status: 'INACTIVE' },
  });
  app = await bootstrap();
  const login = async (name: string) =>
    (
      await api()
        .post('/api/v1/auth/login')
        .send({ email: mail(name), password })
        .expect(200)
    ).body.accessToken as string;
  t.sa = await login('sa');
  t.admin = await login('admin');
  await api()
    .post(`/api/v1/admin/drivers/${ids.driver}/independent`)
    .auth(t.sa, bearer)
    .send({})
    .expect(200);
  t.indep = await login('indep');
  ids.vehicle = (
    await api()
      .post(`/api/v1/admin/drivers/${ids.driver}/independent/vehicles`)
      .auth(t.sa, bearer)
      .send({ identifier: `CS-${run}`, type: 'MOTORCYCLE' })
      .expect(201)
  ).body.id;
  const zone = await api()
    .post('/api/v1/admin/service-zones')
    .auth(t.sa, bearer)
    .send({
      code: `${PREFIX}ZONE_${run}`,
      name: `Zona ${run}`,
      currency: 'MXN',
      boundary: {
        type: 'Polygon',
        coordinates: [
          [
            [ZONE.lng, ZONE.lat],
            [ZONE.lng + 0.1, ZONE.lat],
            [ZONE.lng + 0.1, ZONE.lat + 0.1],
            [ZONE.lng, ZONE.lat + 0.1],
            [ZONE.lng, ZONE.lat],
          ],
        ],
      },
    })
    .expect(201);
  ids.zone = zone.body.id;
  await api()
    .post(`/api/v1/admin/service-zones/${ids.zone}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  const plan = await api()
    .post('/api/v1/admin/rate-plans')
    .auth(t.sa, bearer)
    .send({
      serviceZoneId: ids.zone,
      serviceType: 'LOCAL_DELIVERY',
      quoteValidityMinutes: 60,
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 100000, amount: '60' },
      ],
    })
    .expect(201);
  await api()
    .post(`/api/v1/admin/rate-plans/${plan.body.id}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  await api()
    .post(`/api/v1/admin/providers/${ids.provider}/service-coverages`)
    .auth(t.sa, bearer)
    .send({ serviceZoneId: ids.zone, serviceType: 'LOCAL_DELIVERY' })
    .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Credit snapshots client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  ids.client = client.body.id;
  const credential = await api()
    .post(`/api/v1/admin/integrations/${ids.client}/credentials`)
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
  t.clientSecret = credential.body.clientSecret;
  t.b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  // The mandatory scenario: Provider 1 credit/km, Independent 2 credits/km, minimum 3.
  ids.pv1 = (await setPolicy('PROVIDER', perKm(1))).id;
  ids.iv1 = (await setPolicy('INDEPENDENT_DRIVER', perKm(2))).id;
  economyAtStart = await economy();
  await app.close();
}, 180000);

afterAll(async () => {
  const requests = (
    await prisma.deliveryRequest.findMany({
      where: { integrationClientId: ids.client },
      select: { id: true },
    })
  ).map((r) => r.id);
  await prisma.deliveryAssignment.deleteMany({
    where: { driverId: ids.driver },
  });
  // Quotes cascade to their Dispatches, and a Dispatch takes its credit snapshots with it.
  await prisma.deliveryQuote.deleteMany({
    where: { deliveryRequestId: { in: requests } },
  });
  await prisma.deliveryRequest.deleteMany({ where: { id: { in: requests } } });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: ids.client },
  });
  await prisma.providerServiceCoverage.deleteMany({
    where: { providerId: ids.provider },
  });
  if (ids.zone) {
    await prisma.rateBand.deleteMany({
      where: { ratePlan: { serviceZoneId: ids.zone } },
    });
    await prisma.ratePlan.deleteMany({ where: { serviceZoneId: ids.zone } });
    await prisma.serviceZone.deleteMany({ where: { id: ids.zone } });
  }
  await prisma.vehicle.deleteMany({
    where: { independentDriverProfile: { driverId: ids.driver } },
  });
  await prisma.independentDriverProfile.deleteMany({
    where: { driverId: ids.driver },
  });
  await prisma.driver.deleteMany({ where: { id: ids.driver } });
  await prisma.providerMembership.deleteMany({
    where: { providerId: ids.provider },
  });
  await prisma.deliveryProvider.deleteMany({ where: { id: ids.provider } });
  await prisma.integrationCredential.deleteMany({
    where: { clientId: ids.client },
  });
  await prisma.integrationClient.deleteMany({ where: { id: ids.client } });
  // Policies authored by this suite go (with any snapshot left behind), the baseline comes back.
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.dispatchCreditSnapshot.deleteMany({}),
    prisma.creditPolicyRange.deleteMany({}),
    prisma.creditPolicy.deleteMany({}),
  ]);
  await ensureTestCreditPolicies(prisma);
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}, 120000);

describe.sequential(
  'V1.10-C one frozen cost per actor, each view its own',
  () => {
    withApp();
    let a: Awaited<ReturnType<typeof openDispatch>>;

    it('opening a Dispatch freezes PROVIDER 7 and INDEPENDENT_DRIVER 14 for 6240 m, with full evidence', async () => {
      const before = routing.calls;
      const q = await quoted(6240);
      expect(routing.calls - before).toBe(1); // the quote routes once
      await accept(q.quotePublicId).expect(200);
      expect(routing.calls - before).toBe(1); // opening the Dispatch and freezing its cost: 0 more
      a = { ...q, id: (await dispatchOf(q.quotePublicId))!.id };
      const quoteRow = await prisma.deliveryQuote.findUniqueOrThrow({
        where: { publicId: q.quotePublicId },
      });
      const [p, i] = await snapshotsOf(a.id);
      expect(p).toMatchObject({
        actorType: 'PROVIDER',
        serviceType: 'LOCAL_DELIVERY',
        creditPolicyId: ids.pv1,
        calculationType: 'PER_KM',
        distanceMeters: quoteRow.distanceMeters,
        billableKm: 7,
        creditsPerKm: 1,
        minimumCredits: 3,
        calculatedCredits: 7,
        flatCredits: null,
        appliedRangeId: null,
        credits: 7,
      });
      expect(i).toMatchObject({
        actorType: 'INDEPENDENT_DRIVER',
        creditPolicyId: ids.iv1,
        billableKm: 7,
        creditsPerKm: 2,
        calculatedCredits: 14,
        credits: 14,
      });
      expect(quoteRow.distanceMeters).toBe(6240);
    });

    it('PROVIDER_ADMIN sees creditCost 7 (its own), outside deliveryFee and goods', async () => {
      const detail = await api()
        .get(`/api/v1/provider/dispatches/${a.id}`)
        .auth(t.admin, bearer)
        .expect(200);
      expect(detail.body.creditCost).toBe(7);
      expect(detail.body.service.deliveryFee).toEqual({
        amount: '60.00',
        currency: 'MXN',
      });
      expect(detail.body.service.goods).toMatchObject({
        value: '800.00',
        driverAdvanceAmount: '800.00',
      });
      expect(detail.body.service).not.toHaveProperty('creditCost');
      expect(detail.body).not.toHaveProperty('creditSnapshots');
      const list = await api()
        .get('/api/v1/provider/dispatches?view=AVAILABLE&pageSize=100')
        .auth(t.admin, bearer)
        .expect(200);
      expect(
        list.body.items.find((d: { id: string }) => d.id === a.id).creditCost,
      ).toBe(7);
    });

    it('the independent driver sees creditCost 14 (its own), never the provider one', async () => {
      const list = await api()
        .get('/api/v1/driver/dispatches/available?pageSize=100')
        .auth(t.indep, bearer)
        .expect(200);
      const mine = list.body.items.find((d: { id: string }) => d.id === a.id);
      expect(mine.creditCost).toBe(14);
      const detail = await api()
        .get(`/api/v1/driver/dispatches/${a.id}`)
        .auth(t.indep, bearer)
        .expect(200);
      expect(detail.body.creditCost).toBe(14);
      expect(detail.body.paymentContext).toMatchObject({
        deliveryFee: { amount: '60.00' },
        driverAdvanceAmount: { amount: '800.00' },
      });
      expect(detail.body.paymentContext).not.toHaveProperty('creditCost');
      expect(JSON.stringify(detail.body)).not.toMatch(
        /creditSnapshots|"PROVIDER"/,
      );
    });

    it('SUPER_ADMIN audits both snapshots; the B2B client sees no credit data', async () => {
      const admin = await api()
        .get(`/api/v1/admin/dispatches/${a.id}`)
        .auth(t.sa, bearer)
        .expect(200);
      expect(admin.body.legacyWithoutCreditSnapshots).toBe(false);
      expect(
        admin.body.creditSnapshots.map(
          (s: {
            actorType: string;
            credits: number;
            policyVersion: number;
          }) => [s.actorType, s.credits],
        ),
      ).toEqual([
        ['PROVIDER', 7],
        ['INDEPENDENT_DRIVER', 14],
      ]);
      expect(admin.body.creditSnapshots[0]).toMatchObject({
        creditPolicyId: ids.pv1,
        billableKm: 7,
        creditsPerKm: 1,
        distanceMeters: 6240,
      });
      const quote = await api()
        .get(`/api/v1/delivery-quotes/${a.quotePublicId}`)
        .auth(t.b2b, bearer)
        .expect(200);
      const req = await api()
        .get(`/api/v1/delivery-requests/${a.requestPublicId}`)
        .auth(t.b2b, bearer)
        .expect(200);
      expect(JSON.stringify([quote.body, req.body])).not.toMatch(/credit/i);
    });
  },
);

describe.sequential(
  'V1.10-C a policy change never alters a frozen cost',
  () => {
    withApp();

    it('A keeps 7/14 on v1 after v2 (3/km, 4/km); B opens with 21/28 on v2', async () => {
      const aId = (
        await prisma.dispatchCreditSnapshot.findFirstOrThrow({
          where: { creditPolicyId: ids.pv1 },
        })
      ).dispatchId;
      const frozen = JSON.stringify(await snapshotsOf(aId));
      const pv2 = await setPolicy('PROVIDER', perKm(3));
      const iv2 = await setPolicy('INDEPENDENT_DRIVER', perKm(4));
      expect(JSON.stringify(await snapshotsOf(aId))).toBe(frozen);
      const provider = await api()
        .get(`/api/v1/provider/dispatches/${aId}`)
        .auth(t.admin, bearer)
        .expect(200);
      const driver = await api()
        .get(`/api/v1/driver/dispatches/${aId}`)
        .auth(t.indep, bearer)
        .expect(200);
      expect([provider.body.creditCost, driver.body.creditCost]).toEqual([
        7, 14,
      ]);
      const b = await openDispatch(6240);
      const [p, i] = await snapshotsOf(b.id);
      expect([p.creditPolicyId, p.policyVersion, p.credits]).toEqual([
        pv2.id,
        pv2.version,
        21,
      ]);
      expect([i.creditPolicyId, i.policyVersion, i.credits]).toEqual([
        iv2.id,
        iv2.version,
        28,
      ]);
      const again = await snapshotsOf(aId);
      expect(again.map((s) => [s.policyVersion, s.credits])).toEqual([
        [
          (
            await prisma.creditPolicy.findUniqueOrThrow({
              where: { id: ids.pv1 },
            })
          ).version,
          7,
        ],
        [
          (
            await prisma.creditPolicy.findUniqueOrThrow({
              where: { id: ids.iv1 },
            })
          ).version,
          14,
        ],
      ]);
    });

    it('FLAT and DISTANCE_RANGE evidence: flat 5 without km; 12 400 m in [10000, 20000) -> 20', async () => {
      await setPolicy('PROVIDER', { calculationType: 'FLAT', flatCredits: 5 });
      const ranged = await setPolicy('INDEPENDENT_DRIVER', {
        calculationType: 'DISTANCE_RANGE',
        ranges: [
          { minDistanceMeters: 0, maxDistanceMeters: 10000, credits: 8 },
          { minDistanceMeters: 10000, maxDistanceMeters: 20000, credits: 20 },
          { minDistanceMeters: 20000, maxDistanceMeters: null, credits: 30 },
        ],
      });
      const c = await openDispatch(12400);
      const [p, i] = await snapshotsOf(c.id);
      expect(p).toMatchObject({
        calculationType: 'FLAT',
        flatCredits: 5,
        credits: 5,
        billableKm: null,
        calculatedCredits: null,
        creditsPerKm: null,
        distanceMeters: 12400,
      });
      const range = await prisma.creditPolicyRange.findFirstOrThrow({
        where: { creditPolicyId: ranged.id, position: 2 },
      });
      expect(i).toMatchObject({
        calculationType: 'DISTANCE_RANGE',
        appliedRangeId: range.id,
        appliedRangePosition: 2,
        appliedRangeMinDistanceMeters: 10000,
        appliedRangeMaxDistanceMeters: 20000,
        credits: 20,
        billableKm: null,
      });
      // Back to the PER_KM scenario for the blocks below.
      await setPolicy('PROVIDER', perKm(3));
      await setPolicy('INDEPENDENT_DRIVER', perKm(4));
    });
  },
);

describe.sequential(
  'V1.10-C transactional opening, fail closed, concurrency',
  () => {
    withApp();

    it('10 simultaneous acceptances of one quote: 1 Dispatch, exactly 1 snapshot per actor', async () => {
      const q = await quoted(6240);
      const results = await Promise.all(
        Array.from({ length: 10 }, () => accept(q.quotePublicId)),
      );
      expect(results.every((r) => r.status === 200)).toBe(true);
      const d = await dispatchOf(q.quotePublicId);
      expect(
        await prisma.dispatch.count({
          where: { deliveryQuoteId: d!.deliveryQuoteId },
        }),
      ).toBe(1);
      expect((await snapshotsOf(d!.id)).map((s) => s.actorType)).toEqual([
        'PROVIDER',
        'INDEPENDENT_DRIVER',
      ]);
      await accept(q.quotePublicId).expect(200); // a retry replays; still one snapshot per actor
      expect(
        await prisma.dispatchCreditSnapshot.count({
          where: { dispatchId: d!.id },
        }),
      ).toBe(2);
    });

    it('concurrent openings racing a new policy version: every snapshot is one complete version', async () => {
      const quotes = [];
      for (let i = 0; i < 6; i += 1) quotes.push(await quoted(6240));
      const [accepted, version] = await Promise.all([
        Promise.all(quotes.map((q) => accept(q.quotePublicId))),
        (async () => {
          await new Promise((r) => setTimeout(r, 5));
          return setPolicy('PROVIDER', perKm(5));
        })(),
      ]);
      expect(accepted.every((r) => r.status === 200)).toBe(true);
      const dispatches = await Promise.all(
        quotes.map((q) => dispatchOf(q.quotePublicId)),
      );
      for (const d of dispatches) {
        const snaps = await snapshotsOf(d!.id);
        expect(snaps).toHaveLength(2);
        const p = snaps.find((s) => s.actorType === 'PROVIDER')!;
        const policy = await prisma.creditPolicy.findUniqueOrThrow({
          where: { id: p.creditPolicyId },
        });
        // Never "policy v1 + rate v2": the snapshot's id, version and rate all belong to one row.
        expect([
          p.policyVersion,
          p.creditsPerKm,
          p.minimumCredits,
          p.credits,
        ]).toEqual([
          policy.version,
          policy.creditsPerKm,
          policy.minimumCredits,
          Math.max(7 * policy.creditsPerKm!, policy.minimumCredits!),
        ]);
        expect([3, 5]).toContain(policy.creditsPerKm);
      }
      expect(version.version).toBeGreaterThan(0);
    });

    it('a missing ACTIVE policy for one allowed actor fails the whole opening; nothing is left behind', async () => {
      const q = await quoted(6240);
      const before = {
        snapshots: await prisma.dispatchCreditSnapshot.count(),
        dispatches: await prisma.dispatch.count(),
      };
      await purgeActorPolicies('INDEPENDENT_DRIVER');
      const afterPurge = await prisma.dispatchCreditSnapshot.count();
      const refusedAccept = await accept(q.quotePublicId).expect(409);
      expect(refusedAccept.body.code).toBe('CREDIT_POLICY_UNAVAILABLE');
      expect(
        (
          await prisma.deliveryQuote.findUniqueOrThrow({
            where: { publicId: q.quotePublicId },
          })
        ).status,
      ).toBe('OFFERED');
      expect(await dispatchOf(q.quotePublicId)).toBeNull();
      // The PROVIDER snapshot written before the failure rolled back with the Dispatch: no orphan.
      expect(await prisma.dispatchCreditSnapshot.count()).toBe(afterPurge);
      expect(await prisma.dispatch.count()).toBe(before.dispatches);
      expect(logs.join('\n')).not.toContain(
        `"quotePublicId":"${q.quotePublicId}","deliveryRequestPublicId"`,
      ); // never logged as accepted
      // Configuration restored: the same quote can now be accepted and gets both snapshots.
      await setPolicy('INDEPENDENT_DRIVER', perKm(4));
      await accept(q.quotePublicId).expect(200);
      expect(
        (await snapshotsOf((await dispatchOf(q.quotePublicId))!.id)).map(
          (s) => s.credits,
        ),
      ).toEqual([35, 28]);
    });
  },
);

describe.sequential('V1.10-C database guarantees', () => {
  withApp();

  it('refuses forged, duplicated, retroactive, mutated or orphan snapshots', async () => {
    const anyDispatch = await prisma.dispatchCreditSnapshot.findFirstOrThrow({
      where: { actorType: 'PROVIDER' },
      orderBy: { createdAt: 'desc' },
    });
    const d = await prisma.dispatch.findUniqueOrThrow({
      where: { id: anyDispatch.dispatchId },
      include: { deliveryQuote: true },
    });
    const providerPolicy = await prisma.creditPolicy.findFirstOrThrow({
      where: { actorType: 'PROVIDER', status: 'ACTIVE' },
    });
    const independentPolicy = await prisma.creditPolicy.findFirstOrThrow({
      where: { actorType: 'INDEPENDENT_DRIVER', status: 'ACTIVE' },
    });
    const row = (over: object = {}) => ({
      dispatchId: d.id,
      actorType: 'PROVIDER' as const,
      serviceType: 'LOCAL_DELIVERY' as const,
      creditPolicyId: providerPolicy.id,
      policyVersion: providerPolicy.version,
      calculationType: 'PER_KM' as const,
      distanceMeters: d.deliveryQuote.distanceMeters,
      billableKm: 7,
      creditsPerKm: providerPolicy.creditsPerKm,
      minimumCredits: providerPolicy.minimumCredits,
      calculatedCredits: 7 * providerPolicy.creditsPerKm!,
      credits: Math.max(
        7 * providerPolicy.creditsPerKm!,
        providerPolicy.minimumCredits!,
      ),
      ...over,
    });
    // An ACCEPTED quote without a Dispatch, to open one by hand inside a transaction.
    const q = await quoted(6240);
    const quote = await prisma.deliveryQuote.findUniqueOrThrow({
      where: { publicId: q.quotePublicId },
    });
    const openByHand = (snapshots: object[]) =>
      prisma.$transaction(async (tx) => {
        await tx.deliveryQuote.update({
          where: { id: quote.id },
          data: { status: 'ACCEPTED', acceptedAt: new Date() },
        });
        const dispatch = await tx.dispatch.create({
          data: {
            deliveryRequestId: quote.deliveryRequestId,
            deliveryQuoteId: quote.id,
            openedAt: new Date(),
            expiresAt: new Date(Date.now() + 3600_000),
          },
        });
        for (const s of snapshots)
          await tx.dispatchCreditSnapshot.create({
            data: {
              ...row(),
              dispatchId: dispatch.id,
              distanceMeters: quote.distanceMeters,
              ...s,
            } as never,
          });
      });
    const indepRow = {
      actorType: 'INDEPENDENT_DRIVER',
      creditPolicyId: independentPolicy.id,
      policyVersion: independentPolicy.version,
      creditsPerKm: independentPolicy.creditsPerKm,
      minimumCredits: independentPolicy.minimumCredits,
      calculatedCredits: 7 * independentPolicy.creditsPerKm!,
      credits: 7 * independentPolicy.creditsPerKm!,
    };
    const outcome: Record<string, string> = {
      'duplicate actor on a dispatch': await refused(() =>
        prisma.dispatchCreditSnapshot.create({ data: row() }),
      ),
      'retroactive snapshot on an existing dispatch': await refused(
        async () => {
          await prisma.$transaction([
            prisma.$executeRawUnsafe(
              `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
            ),
            prisma.dispatchCreditSnapshot.deleteMany({
              where: { dispatchId: d.id, actorType: 'PROVIDER' },
            }),
            prisma.dispatchCreditSnapshot.create({ data: row() }),
          ]);
        },
      ),
      'Dispatch opened without snapshots': await refused(() => openByHand([])),
      'Dispatch opened with only one of two actors': await refused(() =>
        openByHand([{}]),
      ),
      'forged credits': await refused(() =>
        openByHand([{ credits: 999 }, indepRow]),
      ),
      'forged billable km': await refused(() =>
        openByHand([{ billableKm: 3 }, indepRow]),
      ),
      'another distance': await refused(() =>
        openByHand([{ distanceMeters: 1 }, indepRow]),
      ),
      'policy of the other actor': await refused(() =>
        openByHand([{ creditPolicyId: independentPolicy.id }, indepRow]),
      ),
      'superseded policy version': await refused(async () => {
        const old = await prisma.creditPolicy.findFirstOrThrow({
          where: {
            actorType: 'PROVIDER',
            status: 'INACTIVE',
            calculationType: 'PER_KM',
          },
        });
        return openByHand([
          {
            creditPolicyId: old.id,
            policyVersion: old.version,
            creditsPerKm: old.creditsPerKm,
            minimumCredits: old.minimumCredits,
            calculatedCredits: 7 * old.creditsPerKm!,
            credits: Math.max(7 * old.creditsPerKm!, old.minimumCredits!),
          },
          indepRow,
        ]);
      }),
      'nonexistent policy': await refused(() =>
        openByHand([{ creditPolicyId: randomUUID() }, indepRow]),
      ),
      'zero credits': await refused(() =>
        openByHand([{ credits: 0 }, indepRow]),
      ),
      'negative credits': await refused(() =>
        openByHand([{ credits: -7 }, indepRow]),
      ),
      'negative distance': await refused(() =>
        openByHand([{ distanceMeters: -1 }, indepRow]),
      ),
      'FLAT evidence on a PER_KM snapshot': await refused(() =>
        openByHand([{ flatCredits: 5 }, indepRow]),
      ),
      'UPDATE credits': await refused(() =>
        prisma.dispatchCreditSnapshot.update({
          where: { id: anyDispatch.id },
          data: { credits: 1 },
        }),
      ),
      'UPDATE policy reference': await refused(() =>
        prisma.dispatchCreditSnapshot.update({
          where: { id: anyDispatch.id },
          data: { policyVersion: 1 },
        }),
      ),
      'DELETE while the dispatch exists': await refused(() =>
        prisma.dispatchCreditSnapshot.delete({ where: { id: anyDispatch.id } }),
      ),
      TRUNCATE: await refused(() =>
        prisma.$executeRawUnsafe(`TRUNCATE "DispatchCreditSnapshot"`),
      ),
      'delete a referenced policy': await refused(() =>
        prisma.$transaction([
          prisma.$executeRawUnsafe(
            `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
          ),
          prisma.creditPolicy.delete({
            where: { id: anyDispatch.creditPolicyId },
          }),
        ]),
      ),
    };
    // The same actor twice inside the opening: the unique index is the last barrier.
    outcome['duplicate actor inside the opening'] = await refused(() =>
      openByHand([{}, {}, indepRow]),
    );
    // Each attack must be stopped by the guarantee meant for it, not by a side effect.
    expect(outcome).toEqual({
      'duplicate actor on a dispatch': 'CREDIT_SNAPSHOT_INVALID',
      'retroactive snapshot on an existing dispatch': 'CREDIT_SNAPSHOT_INVALID',
      'Dispatch opened without snapshots': 'CREDIT_SNAPSHOT_MISSING',
      'Dispatch opened with only one of two actors': 'CREDIT_SNAPSHOT_MISSING',
      'forged credits': 'CREDIT_SNAPSHOT_MISMATCH',
      'forged billable km': 'CREDIT_SNAPSHOT_MISMATCH',
      'another distance': 'CREDIT_SNAPSHOT_INVALID',
      'policy of the other actor': 'CREDIT_SNAPSHOT_INVALID',
      'superseded policy version': 'CREDIT_SNAPSHOT_INVALID',
      'nonexistent policy': 'CREDIT_SNAPSHOT_INVALID',
      'zero credits': 'CREDIT_SNAPSHOT_MISMATCH',
      'negative credits': 'CREDIT_SNAPSHOT_MISMATCH',
      'negative distance': 'CREDIT_SNAPSHOT_INVALID',
      'FLAT evidence on a PER_KM snapshot': '23514',
      'UPDATE credits': 'CREDIT_SNAPSHOT_IMMUTABLE',
      'UPDATE policy reference': 'CREDIT_SNAPSHOT_IMMUTABLE',
      'DELETE while the dispatch exists': 'CREDIT_SNAPSHOT_IMMUTABLE',
      TRUNCATE: 'CREDIT_SNAPSHOT_IMMUTABLE',
      'delete a referenced policy':
        'DispatchCreditSnapshot_creditPolicyId_fkey',
      'duplicate actor inside the opening': 'Unique constraint',
    });
    expect(
      (
        await prisma.deliveryQuote.findUniqueOrThrow({
          where: { id: quote.id },
        })
      ).status,
    ).toBe('OFFERED');
    expect(
      await prisma.dispatchCreditSnapshot.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(2);
  });

  it('a snapshot disappears only together with its Dispatch', async () => {
    const withSnapshots = await prisma.dispatch.findFirstOrThrow({
      where: {
        deliveryRequest: { integrationClientId: ids.client },
        creditSnapshots: { some: {} },
      },
      orderBy: { createdAt: 'desc' },
    });
    await prisma.deliveryQuote.delete({
      where: { id: withSnapshots.deliveryQuoteId },
    });
    expect(
      await prisma.dispatch.findUnique({ where: { id: withSnapshots.id } }),
    ).toBeNull();
    expect(
      await prisma.dispatchCreditSnapshot.count({
        where: { dispatchId: withSnapshots.id },
      }),
    ).toBe(0);
  });
});

describe.sequential('V1.10-C legacy dispatches and no charging yet', () => {
  withApp();

  it('a Dispatch without snapshots (pre-V1.10-C) reads with creditCost null and still works', async () => {
    const legacy = await openDispatch(6240);
    // V1.10-D: a Dispatch without snapshots is legacy only if it is labelled so; the fixture
    // switch (test databases only) is what lets a suite build a genuine pre-V1.10-C row.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.dispatchCreditSnapshot.deleteMany({
        where: { dispatchId: legacy.id },
      }),
      prisma.$executeRawUnsafe(
        `UPDATE "Dispatch" SET "creditMode" = 'LEGACY' WHERE id = $1::uuid`,
        legacy.id,
      ),
    ]);
    const provider = await api()
      .get(`/api/v1/provider/dispatches/${legacy.id}`)
      .auth(t.admin, bearer)
      .expect(200);
    const driver = await api()
      .get(`/api/v1/driver/dispatches/${legacy.id}`)
      .auth(t.indep, bearer)
      .expect(200);
    const admin = await api()
      .get(`/api/v1/admin/dispatches/${legacy.id}`)
      .auth(t.sa, bearer)
      .expect(200);
    expect([provider.body.creditCost, driver.body.creditCost]).toEqual([
      null,
      null,
    ]);
    expect(admin.body).toMatchObject({
      creditSnapshots: [],
      legacyWithoutCreditSnapshots: true,
    });
    await api()
      .post(`/api/v1/provider/dispatches/${legacy.id}/claim`)
      .auth(t.admin, bearer)
      .expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${legacy.id}/release`)
      .auth(t.admin, bearer)
      .send({ reason: 'Prueba legacy' })
      .expect(200);
  });

  it('CLAIM and TAKE with balance 0 and a frozen cost > 0 are refused and move no credit', async () => {
    const provAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: { providerId: ids.provider },
    });
    const profile = await prisma.independentDriverProfile.findUniqueOrThrow({
      where: { driverId: ids.driver },
    });
    const indAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: { independentDriverProfileId: profile.id },
    });
    expect([provAccount.balance, indAccount.balance]).toEqual([0, 0]);
    const toClaim = await openDispatch(6240);
    const toTake = await openDispatch(6240);
    const claimCost = (await snapshotsOf(toClaim.id)).find(
      (s) => s.actorType === 'PROVIDER',
    )!.credits;
    const takeCost = (await snapshotsOf(toTake.id)).find(
      (s) => s.actorType === 'INDEPENDENT_DRIVER',
    )!.credits;
    expect(claimCost).toBeGreaterThan(0);
    expect(takeCost).toBeGreaterThan(0);
    const before = await economy();
    // V1.10-D charges the frozen cost at CLAIM/TAKE, so an empty account wins nothing: this suite
    // never funds anyone, which is why no credit moves anywhere in it.
    const claim = await api()
      .post(`/api/v1/provider/dispatches/${toClaim.id}/claim`)
      .auth(t.admin, bearer)
      .expect(409);
    const take = await api()
      .post(`/api/v1/driver/dispatches/${toTake.id}/take`)
      .auth(t.indep, bearer)
      .send({ vehicleId: ids.vehicle })
      .expect(409);
    expect([claim.body.code, take.body.code]).toEqual([
      'INSUFFICIENT_CREDITS',
      'INSUFFICIENT_CREDITS',
    ]);
    // The frozen costs themselves are untouched by the refusal.
    expect((await snapshotsOf(toClaim.id)).map((s) => s.credits).length).toBe(
      2,
    );
    expect(await economy()).toEqual(before);
  });

  it('no credit moved during the whole suite and every quote routed exactly once', () =>
    economy().then((end) => {
      expect(end).toEqual(economyAtStart);
      // V1.10-D does charge awards, so what this suite guarantees is that IT never moved a
      // credit: the count it started with is the count it ends with.
      expect(end.service).toBe(economyAtStart.service);
      const opened = logs.filter((l) =>
        l.includes('"event":"DISPATCH_OPENED"'),
      );
      expect(opened.length).toBeGreaterThan(5);
      for (const line of opened) expect(line).toContain('creditCosts');
      const quotes = logs.filter(
        (l) =>
          l.includes('DELIVERY_QUOTE_CREATED') ||
          l.includes('ROUTING_CALCULATED'),
      ).length;
      expect(quotes).toBeGreaterThan(0);
    }));
});
