import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import {
  fundIndependentDriver,
  independentBalance,
  providerBalance,
  purgeFixtureCredits,
  purgeFixtureDispatches,
  setIndependentBalance,
  setProviderBalance,
} from './support/credits.js';

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
const PREFIX = 'E2E_CREF_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credit-refunds.test`.toLowerCase();
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
/** Routing spy: fixed canonical distance, and a counter to prove awards never route. */
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
const ZONE = { lng: -92.75, lat: 15.75 };
const t: Record<string, string> = {};
const ids: Record<string, string> = {};
const userIds: string[] = [];
let app: INestApplication;
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
  return res.body as { id: string; version: number };
}
async function openDispatch(distanceMeters = 6240) {
  routing.distanceMeters = distanceMeters;
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9615557788',
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `CREF-${run}`,
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [{ category: 'FOOD', description: 'Pedido', quantity: 1 }],
      financialContext: {
        goodsValue: '800.00',
        goodsPaymentMode: 'COURIER_ADVANCE',
        currency: 'MXN',
      },
    })
    .expect(201);
  const quote = await api()
    .post(`/api/v1/delivery-requests/${req.body.publicId}/quotes`)
    .auth(t.b2b, bearer)
    .expect(201);
  await api()
    .post(`/api/v1/delivery-quotes/${quote.body.publicId}/accept`)
    .auth(t.b2b, bearer)
    .expect(200);
  const row = await prisma.deliveryQuote.findUniqueOrThrow({
    where: { publicId: quote.body.publicId },
  });
  const dispatch = await prisma.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: row.id },
  });
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
}
const claim = (token: string, dispatchId: string) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/claim`)
    .auth(token, bearer);
const take = (token: string, dispatchId: string, vehicleId = ids.vehicle) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
const awardsOf = (dispatchId: string) =>
  prisma.creditLedgerEntry.findMany({
    where: { type: 'SERVICE_AWARD', referenceId: dispatchId },
    orderBy: { sequence: 'asc' },
  });
const refundsOf = (dispatchId: string) =>
  prisma.creditLedgerEntry.findMany({
    where: { type: 'SERVICE_REFUND', referenceId: dispatchId },
    orderBy: { sequence: 'asc' },
  });
const economy = async () => ({
  accounts: await prisma.creditAccount.findMany({
    select: { id: true, balance: true },
    orderBy: { id: 'asc' },
  }),
  entries: await prisma.creditLedgerEntry.count(),
});
const releaseProvider = (
  token: string,
  dispatchId: string,
  reason = 'Prueba V1.10-E',
) =>
  api()
    .post(`/api/v1/provider/dispatches/${dispatchId}/release`)
    .auth(token, bearer)
    .send({ reason });
const releaseDriver = (dispatchId: string) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/release`)
    .auth(t.indep, bearer)
    .send({ reason: 'OPERATIONAL_ISSUE' });
const cancelRequest = (publicId: string, reason = 'Cliente canceló el envío') =>
  api()
    .post(`/api/v1/delivery-requests/${publicId}/cancel`)
    .auth(t.b2b, bearer)
    .send({ reason });
/** The award of a dispatch with the refund that compensates it, as an audit would read them. */
async function economicHistory(dispatchId: string) {
  const award = (await awardsOf(dispatchId))[0] ?? null;
  const refund = (await refundsOf(dispatchId))[0] ?? null;
  return {
    award: award && { amount: award.amount, id: award.id },
    refund: refund && {
      amount: refund.amount,
      reverses: refund.reversesEntryId,
      reason: refund.refundReason,
    },
    net: (award?.amount ?? 0) + (refund?.amount ?? 0),
  };
}
/** Makes a Dispatch genuinely legacy, the way only a *_test database allows. */
async function makeLegacy(dispatchId: string) {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.dispatchCreditSnapshot.deleteMany({ where: { dispatchId } }),
    prisma.$executeRawUnsafe(
      `UPDATE "Dispatch" SET "creditMode" = 'LEGACY' WHERE id = $1::uuid`,
      dispatchId,
    ),
  ]);
}
async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return 'ACCEPTED';
  } catch (error) {
    const m = String((error as Error).message);
    return (
      /(CREDIT_AWARD_[A-Z_]+|CREDIT_[A-Z_]+|DISPATCH_CREDIT_MODE_[A-Z_]+|CreditLedgerEntry_[A-Za-z_]*check|CreditAccount_[A-Za-z_]*check|Unique constraint|23514|23505)/.exec(
        m,
      )?.[0] ?? 'refused'
    );
  }
}

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
  for (const key of ['A', 'B'] as const) {
    const provider = await prisma.deliveryProvider.create({
      data: {
        name: `CREF ${key} ${run}`,
        code: `${PREFIX}${key}_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 5,
        maxVehicles: 5,
      },
    });
    ids[`provider${key}`] = provider.id;
    await prisma.providerMembership.create({
      data: {
        providerId: provider.id,
        userId: await user(`admin${key}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  ids.driver = (
    await prisma.driver.create({
      data: {
        providerId: ids.providerA,
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
  t.A = await login('adminA');
  t.B = await login('adminB');
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
      .send({ identifier: `CC-${run}`, type: 'MOTORCYCLE' })
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
  for (const key of ['A', 'B'] as const)
    await api()
      .post(
        `/api/v1/admin/providers/${ids[`provider${key}`]}/service-coverages`,
      )
      .auth(t.sa, bearer)
      .send({ serviceZoneId: ids.zone, serviceType: 'LOCAL_DELIVERY' })
      .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Credit refunds client', code: `${PREFIX}CLIENT_${run}` })
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
  t.b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  // 6240 m: provider 7 credits (1/km), independent 14 (2/km), minimum 3.
  await setPolicy('PROVIDER', perKm(1));
  await setPolicy('INDEPENDENT_DRIVER', perKm(2));
  await app.close();
}, 180000);

afterAll(async () => {
  await purgeFixtureDispatches(prisma, [ids.client]);
  const providerIds = [ids.providerA, ids.providerB].filter(Boolean);
  const requests = (
    await prisma.deliveryRequest.findMany({
      where: { integrationClientId: ids.client },
      select: { id: true },
    })
  ).map((r) => r.id);
  await prisma.deliveryAssignment.deleteMany({
    where: { driverId: ids.driver },
  });
  await purgeFixtureCredits(prisma, { providerIds, driverIds: [ids.driver] });
  await prisma.deliveryQuote.deleteMany({
    where: { deliveryRequestId: { in: requests } },
  });
  await prisma.deliveryRequest.deleteMany({ where: { id: { in: requests } } });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: ids.client },
  });
  await prisma.providerServiceCoverage.deleteMany({
    where: { providerId: { in: providerIds } },
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
    where: { providerId: { in: providerIds } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationCredential.deleteMany({
    where: { clientId: ids.client },
  });
  await prisma.integrationClient.deleteMany({ where: { id: ids.client } });
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

describe.sequential('V1.10-E a reversed award returns its credits', () => {
  withApp();

  it('provider release returns exactly what the award charged, without touching it', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 20);
    await claim(t.A, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(13);
    const award = (await awardsOf(dispatch.id))[0];
    await releaseProvider(t.A, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(20);
    // The original debit is still there, byte for byte; the refund is a new, opposite entry.
    expect((await awardsOf(dispatch.id))[0]).toEqual(award);
    expect(await economicHistory(dispatch.id)).toMatchObject({
      award: { amount: -7 },
      refund: { amount: 7, reverses: award.id, reason: 'PROVIDER_RELEASE' },
      net: 0,
    });
    expect(
      logs.some(
        (l) => l.includes('SERVICE_REFUND_ISSUED') && l.includes(dispatch.id),
      ),
    ).toBe(true);
  });

  it('returns what was charged even if the policy changed in between', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    await setPolicy('PROVIDER', perKm(20));
    await releaseProvider(t.A, dispatch.id).expect(200);
    expect((await economicHistory(dispatch.id)).refund).toMatchObject({
      amount: 7,
    });
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
    await setPolicy('PROVIDER', perKm(1));
  });

  it('after a release another provider pays its own award', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await setProviderBalance(prisma, ids.providerB, 7);
    await claim(t.A, dispatch.id).expect(200);
    await releaseProvider(t.A, dispatch.id).expect(200);
    await claim(t.B, dispatch.id).expect(200);
    // A is even, B paid for the service it now holds.
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
    expect(await providerBalance(prisma, ids.providerB)).toBe(0);
    expect(await awardsOf(dispatch.id)).toHaveLength(2);
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    await releaseProvider(t.B, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerB)).toBe(7);
    expect(await refundsOf(dispatch.id)).toHaveLength(2);
  });

  it('an independent release returns the credits to the driver, never to a provider', async () => {
    const dispatch = await openDispatch();
    await fundIndependentDriver(prisma, ids.driver, 14);
    const providerBefore = await providerBalance(prisma, ids.providerA);
    await take(t.indep, dispatch.id).expect(200);
    expect(await independentBalance(prisma, ids.driver)).toBe(0);
    await releaseDriver(dispatch.id).expect(200);
    expect(await independentBalance(prisma, ids.driver)).toBe(14);
    expect(await providerBalance(prisma, ids.providerA)).toBe(providerBefore);
    expect(await economicHistory(dispatch.id)).toMatchObject({
      award: { amount: -14 },
      refund: { amount: 14, reason: 'INDEPENDENT_RELEASE' },
      net: 0,
    });
  });

  it('cancelling the delivery returns the credits of the provider that had won it', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(0);
    await cancelRequest(dispatch.requestPublicId).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
    expect(await economicHistory(dispatch.id)).toMatchObject({
      refund: { amount: 7, reason: 'DELIVERY_CANCELLED' },
      net: 0,
    });
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
        .status,
    ).toBe('CANCELLED');
  });

  it('cancelling the delivery returns the credits of an independent driver too', async () => {
    const dispatch = await openDispatch();
    await setIndependentBalance(prisma, ids.driver, 14);
    await take(t.indep, dispatch.id).expect(200);
    await cancelRequest(dispatch.requestPublicId).expect(200);
    expect(await independentBalance(prisma, ids.driver)).toBe(14);
    expect(await economicHistory(dispatch.id)).toMatchObject({
      refund: { amount: 14, reason: 'DELIVERY_CANCELLED' },
      net: 0,
    });
  });

  it('cancelling before anybody won it moves nothing at all', async () => {
    const dispatch = await openDispatch();
    const before = await economy();
    await cancelRequest(dispatch.requestPublicId).expect(200);
    expect(await economy()).toEqual(before);
    expect(await awardsOf(dispatch.id)).toHaveLength(0);
    expect(await refundsOf(dispatch.id)).toHaveLength(0);
    // No zero-credit movement was invented to represent "nothing happened".
    expect(await prisma.creditLedgerEntry.count({ where: { amount: 0 } })).toBe(
      0,
    );
  });

  it('reassigning or cancelling only the assignment returns nothing: the provider still owns it', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const afterClaim = await economy();
    const fleetUser = async (name: string) => {
      const u = await prisma.user.create({
        data: {
          email: mail(name),
          passwordHash: await argon2.hash(password),
          role: 'DRIVER',
        },
      });
      userIds.push(u.id);
      return u.id;
    };
    const driverA = await prisma.driver.create({
      data: {
        providerId: ids.providerA,
        userId: await fleetUser('fleetA'),
        name: `fleet-a-${run}`,
        status: 'ACTIVE',
      },
    });
    const driverB = await prisma.driver.create({
      data: {
        providerId: ids.providerA,
        userId: await fleetUser('fleetB'),
        name: `fleet-b-${run}`,
        status: 'ACTIVE',
      },
    });
    const vehicleA = await prisma.vehicle.create({
      data: {
        providerId: ids.providerA,
        identifier: `RA-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    const vehicleB = await prisma.vehicle.create({
      data: {
        providerId: ids.providerA,
        identifier: `RB-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment`)
      .auth(t.A, bearer)
      .send({ driverId: driverA.id, vehicleId: vehicleA.id })
      .expect(201);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/reassign`)
      .auth(t.A, bearer)
      .send({
        driverId: driverB.id,
        vehicleId: vehicleB.id,
        reason: 'OPERATIONAL_CHANGE',
      })
      .expect(200);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/assignment/cancel`)
      .auth(t.A, bearer)
      .send({ reason: 'OPERATIONAL_CHANGE' })
      .expect(200);
    // Changing who drives is not undoing the sale: the dispatch is still claimed and paid.
    expect(await economy()).toEqual(afterClaim);
    expect(await refundsOf(dispatch.id)).toHaveLength(0);
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: dispatch.id } }))
        .claimedByProviderId,
    ).toBe(ids.providerA);
    await releaseProvider(t.A, dispatch.id).expect(200);
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    await prisma.deliveryAssignment.deleteMany({
      where: { dispatchId: dispatch.id },
    });
    await prisma.vehicle.deleteMany({
      where: { id: { in: [vehicleA.id, vehicleB.id] } },
    });
    await prisma.driver.deleteMany({
      where: { id: { in: [driverA.id, driverB.id] } },
    });
  });

  it('keeps money and credits apart', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    const claimed = await claim(t.A, dispatch.id).expect(200);
    const money = {
      fee: claimed.body.service.deliveryFee,
      goods: claimed.body.service.goods,
    };
    await releaseProvider(t.A, dispatch.id).expect(200);
    // The released provider no longer sees the service detail, so the audit view is the witness:
    // returning credits changed no amount of money.
    const after = await api()
      .get(`/api/v1/admin/dispatches/${dispatch.id}`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(after.body.deliveryQuote).toMatchObject({
      amount: money.fee.amount,
      currency: money.fee.currency,
    });
    const financial = await prisma.deliveryFinancialContext.findFirstOrThrow({
      where: { deliveryRequest: { publicId: dispatch.requestPublicId } },
    });
    expect(financial.goodsValue?.toFixed(2)).toBe(money.goods.value);
    expect(financial.goodsPaymentMode).toBe('COURIER_ADVANCE');
    expect(money.fee).toEqual({ amount: '60.00', currency: 'MXN' });
    expect(money.goods).toMatchObject({
      value: '800.00',
      driverAdvanceAmount: '800.00',
    });
  });
});

describe.sequential('V1.10-E one reversal, one refund', () => {
  withApp();

  it('repeating the release never returns the credits twice', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    await releaseProvider(t.A, dispatch.id).expect(200);
    // The service is not this provider's any more, so a repeated release is refused outright.
    const again = await releaseProvider(t.A, dispatch.id).expect(409);
    expect(again.body.code).toBe('DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
  });

  it('repeating the cancellation never returns the credits twice', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    await cancelRequest(dispatch.requestPublicId).expect(200);
    await cancelRequest(dispatch.requestPublicId).expect(200);
    await cancelRequest(dispatch.requestPublicId).expect(200);
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
  });

  it('ten simultaneous reversals produce exactly one refund', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const attempts = [
      ...Array.from({ length: 5 }, () => releaseProvider(t.A, dispatch.id)),
      ...Array.from({ length: 5 }, () =>
        cancelRequest(dispatch.requestPublicId),
      ),
    ];
    const results = await Promise.all(
      attempts.map((a) => a.then((r) => r.status).catch(() => 0)),
    );
    expect(results.some((s) => s === 200)).toBe(true);
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
  });

  it('a release racing the cancellation of the delivery refunds once', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const [release, cancel] = await Promise.all([
      releaseProvider(t.A, dispatch.id).then((r) => r.status),
      cancelRequest(dispatch.requestPublicId).then((r) => r.status),
    ]);
    // Whichever order the database serialized, exactly one refund exists and the balance is whole.
    expect([release, cancel].filter((s) => s === 200).length).toBeGreaterThan(
      0,
    );
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
    expect(await providerBalance(prisma, ids.providerA)).toBe(7);
    const row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    expect(['OPEN', 'CANCELLED', 'EXPIRED']).toContain(row.status);
  });

  it('a refund racing a recharge and an adjustment keeps the ledger reconstructible', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerB, 7);
    await claim(t.B, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerB)).toBe(0);
    const [release, recharge, adjust] = await Promise.all([
      releaseProvider(t.B, dispatch.id).then((r) => r.status),
      api()
        .post(`/api/v1/admin/providers/${ids.providerB}/credits/recharge`)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({ credits: 20, method: 'TRANSFER' })
        .then((r) => r.status),
      api()
        .post(`/api/v1/admin/providers/${ids.providerB}/credits/adjustment`)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: 5, reason: 'Ajuste simultaneo con devolucion' })
        .then((r) => r.status),
    ]);
    expect([release, recharge, adjust]).toEqual([200, 201, 201]);
    const balance = await providerBalance(prisma, ids.providerB);
    const entries = await prisma.creditLedgerEntry.findMany({
      where: { creditAccount: { providerId: ids.providerB } },
      orderBy: { sequence: 'asc' },
    });
    let reconstructed = 0;
    for (const entry of entries) {
      expect(entry.balanceBefore).toBe(reconstructed);
      reconstructed += entry.amount;
      expect(entry.balanceAfter).toBe(reconstructed);
    }
    // 7 - 7 (award) + 7 (refund) + 20 + 5
    expect(reconstructed).toBe(balance);
    expect(balance).toBe(32);
  });

  it('a refund racing a new claim leaves one of the two valid orders, never another', async () => {
    const first = await openDispatch();
    const second = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, first.id).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(0);
    const [release, secondClaim] = await Promise.all([
      releaseProvider(t.A, first.id).then((r) => r.status),
      claim(t.A, second.id).then((r) => r.status),
    ]);
    expect(release).toBe(200);
    const balance = await providerBalance(prisma, ids.providerA);
    if (secondClaim === 200) {
      // The refund landed first: the new award spent it.
      expect(balance).toBe(0);
      expect(await awardsOf(second.id)).toHaveLength(1);
    } else {
      expect(secondClaim).toBe(409);
      expect(balance).toBe(7);
      expect(await awardsOf(second.id)).toHaveLength(0);
    }
  });
});

describe.sequential('V1.10-E historical boundary and corruption', () => {
  withApp();

  it('a legacy dispatch returns nothing and says so', async () => {
    const dispatch = await openDispatch();
    await makeLegacy(dispatch.id);
    await setProviderBalance(prisma, ids.providerA, 7);
    const before = await economy();
    await claim(t.A, dispatch.id).expect(200);
    await releaseProvider(t.A, dispatch.id).expect(200);
    expect(await economy()).toEqual(before);
    expect(await awardsOf(dispatch.id)).toHaveLength(0);
    expect(await refundsOf(dispatch.id)).toHaveLength(0);
    expect(
      logs.some(
        (l) =>
          l.includes('SERVICE_REFUND_SKIPPED_LEGACY') &&
          l.includes(dispatch.id),
      ),
    ).toBe(true);
  });

  it('a pre-enforcement exemption cannot be fabricated to fake a refundable claim', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const claimed = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    // V1.10-D made historical exemptions migration-only, so no suite (and no writer) can invent a
    // claim that "predates enforcement". The refund rule for that class is covered by the unit
    // test; here what matters is that the class itself cannot be forged.
    await expect(
      prisma.dispatchPreEnforcementAward.create({
        data: {
          dispatchId: dispatch.id,
          actorType: 'PROVIDER',
          actorId: ids.providerA,
          awardedAt: claimed.claimedAt!,
        },
      }),
    ).rejects.toThrow(/CREDIT_HISTORY_IMMUTABLE/);
    expect(
      await prisma.dispatchPreEnforcementAward.count({
        where: { dispatchId: dispatch.id },
      }),
    ).toBe(0);
    // And the award is still a normal, refundable one.
    await releaseProvider(t.A, dispatch.id).expect(200);
    expect(await refundsOf(dispatch.id)).toHaveLength(1);
  });

  it('an enforced award that lost its debit fails closed instead of reversing for free', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    // Corruption: the charge disappears but the dispatch is still an enforced award.
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.creditLedgerEntry.deleteMany({
        where: { type: 'SERVICE_AWARD', referenceId: dispatch.id },
      }),
    ]);
    const before = await economy();
    const refused = await releaseProvider(t.A, dispatch.id).expect(409);
    expect(refused.body.code).toBe('CREDIT_REFUND_INTEGRITY_ERROR');
    // Nothing moved and the service is still where it was.
    expect(await economy()).toEqual(before);
    const row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    expect(row.status).toBe('CLAIMED');
    expect(row.claimedByProviderId).toBe(ids.providerA);
    expect(
      logs.some((l) => l.includes('SERVICE_REFUND_INTEGRITY_FAILURE')),
    ).toBe(true);
    // Leave the fixture consistent again: the corrupted account is emptied (its balance is 0 and
    // so is its ledger), and the dispatch stays claimed with nothing owed.
    const account = await prisma.creditAccount.findUniqueOrThrow({
      where: { providerId: ids.providerA },
    });
    expect(account.balance).toBe(0);
    await prisma.$transaction([
      prisma.$executeRawUnsafe(
        `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
      ),
      prisma.creditLedgerEntry.deleteMany({
        where: { creditAccountId: account.id, type: 'SERVICE_REFUND' },
      }),
      prisma.creditLedgerEntry.deleteMany({
        where: { creditAccountId: account.id },
      }),
    ]);
  });
});

describe.sequential('V1.10-E what PostgreSQL refuses', () => {
  withApp();

  it('rejects every forged refund written directly in SQL', async () => {
    const paid = await openDispatch();
    const other = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await setProviderBalance(prisma, ids.providerB, 7);
    await claim(t.A, paid.id).expect(200);
    await claim(t.B, other.id).expect(200);
    const award = (await awardsOf(paid.id))[0];
    const otherAward = (await awardsOf(other.id))[0];
    const account = await prisma.creditAccount.findUniqueOrThrow({
      where: { providerId: ids.providerA },
    });
    const foreign = await prisma.creditAccount.findUniqueOrThrow({
      where: { providerId: ids.providerB },
    });
    const refund = (over: Record<string, unknown>) =>
      prisma.creditLedgerEntry.create({
        data: {
          creditAccountId: account.id,
          type: 'SERVICE_REFUND',
          amount: 7,
          balanceBefore: account.balance,
          balanceAfter: account.balance + 7,
          referenceType: 'DISPATCH',
          referenceId: paid.id,
          reversesEntryId: award.id,
          refundReason: 'PROVIDER_RELEASE',
          createdByUserId: ids.sa,
          ...over,
        } as never,
      });
    const outcome: Record<string, string> = {
      // The service is still awarded to this provider: nothing to give back yet.
      'refund without an operational reversal': await refused(() => refund({})),
      'refund of a nonexistent award': await refused(() =>
        refund({ reversesEntryId: randomUUID() }),
      ),
      'refund with no award at all': await refused(() =>
        refund({ reversesEntryId: null }),
      ),
      'refund of somebody else award': await refused(() =>
        refund({
          reversesEntryId: otherAward.id,
          referenceId: other.id,
        }),
      ),
      'refund credited to another provider': await refused(() =>
        refund({
          creditAccountId: foreign.id,
          balanceBefore: foreign.balance,
          balanceAfter: foreign.balance + 7,
        }),
      ),
      'refund pointing at a different dispatch': await refused(() =>
        refund({ referenceId: other.id }),
      ),
      'refund as the wrong actor': await refused(() =>
        refund({ refundReason: 'INDEPENDENT_RELEASE' }),
      ),
      'refund without a reason': await refused(() =>
        refund({ refundReason: null }),
      ),
      'refund of a recharge instead of an award': await refused(async () => {
        const recharge = await prisma.creditLedgerEntry.findFirstOrThrow({
          where: { creditAccountId: account.id, type: 'RECHARGE' },
        });
        return refund({ reversesEntryId: recharge.id });
      }),
    };
    // Now release it: from here the reversal is real and only the amount rules are left.
    await releaseProvider(t.A, paid.id).expect(200);
    const released = await prisma.creditAccount.findUniqueOrThrow({
      where: { id: account.id },
    });
    const secondRefund = (over: Record<string, unknown>) =>
      prisma.creditLedgerEntry.create({
        data: {
          creditAccountId: account.id,
          type: 'SERVICE_REFUND',
          amount: 7,
          balanceBefore: released.balance,
          balanceAfter: released.balance + 7,
          referenceType: 'DISPATCH',
          referenceId: paid.id,
          reversesEntryId: award.id,
          refundReason: 'PROVIDER_RELEASE',
          createdByUserId: ids.sa,
          ...over,
        } as never,
      });
    outcome['second refund of the same award'] = await refused(() =>
      secondRefund({}),
    );
    const issued = (await refundsOf(paid.id))[0];
    outcome['editing a written refund'] = await refused(() =>
      prisma.creditLedgerEntry.update({
        where: { id: issued.id },
        data: { amount: 70 },
      }),
    );
    outcome['deleting a written refund'] = await refused(() =>
      prisma.creditLedgerEntry.delete({ where: { id: issued.id } }),
    );
    // A second award for the same service (another provider) to test amounts against.
    await setProviderBalance(prisma, ids.providerB, 7);
    await claim(t.B, paid.id).expect(200);
    const bAward = (await awardsOf(paid.id)).find((a) => a.id !== award.id)!;
    const bAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: { providerId: ids.providerB },
    });
    await releaseProvider(t.B, paid.id).expect(200);
    const bAfter = await prisma.creditAccount.findUniqueOrThrow({
      where: { id: bAccount.id },
    });
    const amountRefund = (amount: number) =>
      prisma.creditLedgerEntry.create({
        data: {
          creditAccountId: bAccount.id,
          type: 'SERVICE_REFUND',
          amount,
          balanceBefore: bAfter.balance,
          balanceAfter: bAfter.balance + amount,
          referenceType: 'DISPATCH',
          referenceId: paid.id,
          reversesEntryId: bAward.id,
          refundReason: 'PROVIDER_RELEASE',
          createdByUserId: ids.sa,
        } as never,
      });
    outcome['refund larger than its award'] = await refused(() =>
      amountRefund(8),
    );
    outcome['refund smaller than its award'] = await refused(() =>
      amountRefund(6),
    );
    expect(outcome).toEqual({
      'refund without an operational reversal': 'CREDIT_REFUND_INVALID',
      'refund of a nonexistent award': 'CREDIT_REFUND_INVALID',
      // The guard runs before the CHECK, so these are stopped by the guard's own reason.
      'refund with no award at all': 'CREDIT_REFUND_INVALID',
      'refund of somebody else award': 'CREDIT_REFUND_INVALID',
      'refund credited to another provider': 'CREDIT_REFUND_INVALID',
      'refund pointing at a different dispatch': 'CREDIT_REFUND_INVALID',
      'refund as the wrong actor': 'CREDIT_REFUND_INVALID',
      'refund without a reason': 'CREDIT_REFUND_INVALID',
      'refund of a recharge instead of an award': 'CREDIT_REFUND_INVALID',
      'second refund of the same award': 'Unique constraint',
      'editing a written refund': 'CREDIT_LEDGER_IMMUTABLE',
      'deleting a written refund': 'CREDIT_LEDGER_IMMUTABLE',
      'refund larger than its award': 'CREDIT_REFUND_MISMATCH',
      'refund smaller than its award': 'CREDIT_REFUND_MISMATCH',
    });
  });

  it('refuses to reverse a paid service in SQL without returning its credits', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const reversals: Record<string, string> = {
      'release by hand': await refused(() =>
        prisma.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status: 'OPEN',
            claimedByProviderId: null,
            claimedAt: null,
          },
        }),
      ),
      'cancel by hand': await refused(() =>
        prisma.dispatch.update({
          where: { id: dispatch.id },
          data: {
            status: 'CANCELLED',
            cancelledAt: new Date(),
            cancellationReason: 'SQL',
          },
        }),
      ),
    };
    expect(reversals).toEqual({
      'release by hand': 'CREDIT_REFUND_REQUIRED',
      'cancel by hand': 'CREDIT_REFUND_REQUIRED',
    });
    // The service is untouched and still paid for.
    const row = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    expect(row.status).toBe('CLAIMED');
    expect(await refundsOf(dispatch.id)).toHaveLength(0);
    await releaseProvider(t.A, dispatch.id).expect(200);
  });

  it('leaves the economy of this suite consistent', async () => {
    // Scoped to the accounts this suite moved: other suites purge their own credit fixtures and
    // leave balances behind on purpose, which is noise here, not a violation.
    const own = await prisma.creditAccount.findMany({
      where: {
        OR: [
          { providerId: { in: [ids.providerA, ids.providerB] } },
          { independentDriverProfile: { driverId: ids.driver } },
        ],
      },
      select: { id: true },
    });
    const scope = own.map((a) => `'${a.id}'`).join(', ');
    const [scan] = await prisma.$queryRawUnsafe<Record<string, number>[]>(`
      WITH r AS (
        SELECT e.*, a."amount" award_amount, a."creditAccountId" award_account,
               a."referenceId" award_reference, a."type" award_type
          FROM "CreditLedgerEntry" e
          LEFT JOIN "CreditLedgerEntry" a ON a."id" = e."reversesEntryId"
         WHERE e."type" = 'SERVICE_REFUND')
      SELECT (SELECT count(*)::int FROM r WHERE award_type IS DISTINCT FROM 'SERVICE_AWARD') refund_without_award,
             (SELECT count(*)::int FROM r WHERE award_account <> "creditAccountId") wrong_account,
             (SELECT count(*)::int FROM r WHERE award_reference IS DISTINCT FROM "referenceId") wrong_dispatch,
             (SELECT count(*)::int FROM r WHERE "amount" <> -award_amount) wrong_amount,
             (SELECT count(*)::int FROM (SELECT "reversesEntryId" FROM "CreditLedgerEntry" WHERE "type" = 'SERVICE_REFUND' GROUP BY "reversesEntryId" HAVING count(*) > 1) x) duplicate_refunds,
             (SELECT count(*)::int FROM "CreditAccount" a WHERE a."id" IN (${scope}) AND a."balance" < 0) negative_balance,
             (SELECT count(*)::int FROM "CreditAccount" a
               WHERE a."id" IN (${scope})
                 AND a."balance" <> coalesce((SELECT sum(e."amount") FROM "CreditLedgerEntry" e WHERE e."creditAccountId" = a."id"), 0)) balance_mismatch,
             (SELECT count(*)::int FROM "Dispatch" d
               JOIN "CreditLedgerEntry" aw ON aw."type" = 'SERVICE_AWARD' AND aw."referenceId" = d."id"
              WHERE d."status" IN ('CANCELLED', 'EXPIRED')
                AND d."claimedByProviderId" IS NOT NULL
                AND EXISTS (SELECT 1 FROM "CreditAccount" ca WHERE ca."id" = aw."creditAccountId" AND ca."providerId" = d."claimedByProviderId")
                AND NOT EXISTS (SELECT 1 FROM "CreditLedgerEntry" rf WHERE rf."type" = 'SERVICE_REFUND' AND rf."reversesEntryId" = aw."id")) closed_without_refund
    `);
    expect(scan).toEqual({
      refund_without_award: 0,
      wrong_account: 0,
      wrong_dispatch: 0,
      wrong_amount: 0,
      duplicate_refunds: 0,
      negative_balance: 0,
      balance_mismatch: 0,
      closed_without_refund: 0,
    });
  });

  it('never wrote a secret in a refund log line', () => {
    const refundLogs = logs.filter((l) => l.includes('SERVICE_REFUND'));
    expect(refundLogs.length).toBeGreaterThan(0);
    for (const line of refundLogs) {
      expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
      expect(line).not.toContain(password);
    }
  });
});
