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
  fundProvider,
  independentBalance,
  providerBalance,
  purgeFixtureCredits,
  purgeFixtureDispatches,
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
const PREFIX = 'E2E_CCON_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credit-consumption.test`.toLowerCase();
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
const ZONE = { lng: -93.25, lat: 16.25 };
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
      externalReference: `CCON-${run}`,
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
const economy = async () => ({
  accounts: await prisma.creditAccount.findMany({
    select: { id: true, balance: true },
    orderBy: { id: 'asc' },
  }),
  entries: await prisma.creditLedgerEntry.count(),
});
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
/** Corrupts a monetized Dispatch by removing the snapshot it must have. */
async function dropSnapshots(dispatchId: string) {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    prisma.dispatchCreditSnapshot.deleteMany({ where: { dispatchId } }),
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
        name: `CCON ${key} ${run}`,
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
    .send({ name: 'Credit consumption client', code: `${PREFIX}CLIENT_${run}` })
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

describe.sequential('V1.10-D award and debit are one operation', () => {
  withApp();

  it('provider CLAIM debits exactly the cost shown and writes one SERVICE_AWARD', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 10);
    const view = await api()
      .get(`/api/v1/provider/dispatches/${dispatch.id}`)
      .auth(t.A, bearer)
      .expect(200);
    expect(view.body.creditCost).toBe(7);
    const routedBefore = routing.calls;
    const claimed = await claim(t.A, dispatch.id).expect(200);
    expect(claimed.body.claimedByMe).toBe(true);
    // What the provider was shown is exactly what it paid (§34), and awarding never routes (§36).
    expect(await providerBalance(prisma, ids.providerA)).toBe(3);
    expect(routing.calls).toBe(routedBefore);
    const awards = await awardsOf(dispatch.id);
    expect(awards).toHaveLength(1);
    expect(awards[0]).toMatchObject({
      type: 'SERVICE_AWARD',
      amount: -7,
      balanceBefore: 10,
      balanceAfter: 3,
      referenceType: 'DISPATCH',
      referenceId: dispatch.id,
      idempotencyKey: null,
    });
    // Traceable to the service, the actor and its frozen cost.
    const account = await prisma.creditAccount.findUniqueOrThrow({
      where: { id: awards[0].creditAccountId },
    });
    expect(account.providerId).toBe(ids.providerA);
    const snapshot = await prisma.dispatchCreditSnapshot.findUniqueOrThrow({
      where: {
        dispatchId_actorType: {
          dispatchId: dispatch.id,
          actorType: 'PROVIDER',
        },
      },
    });
    expect(-awards[0].amount).toBe(snapshot.credits);
    expect(
      logs.some(
        (l) => l.includes('SERVICE_AWARD_CHARGED') && l.includes(`"credits":7`),
      ),
    ).toBe(true);
  });

  it('independent TAKE debits its own account and keeps the assignment in the same operation', async () => {
    const dispatch = await openDispatch();
    await fundIndependentDriver(prisma, ids.driver, 14);
    const providerBefore = await providerBalance(prisma, ids.providerA);
    const view = await api()
      .get(`/api/v1/driver/dispatches/${dispatch.id}`)
      .auth(t.indep, bearer)
      .expect(200);
    expect(view.body.creditCost).toBe(14);
    await take(t.indep, dispatch.id).expect(200);
    expect(await independentBalance(prisma, ids.driver)).toBe(0);
    // The provider of the fleet the driver belongs to pays nothing for an independent service.
    expect(await providerBalance(prisma, ids.providerA)).toBe(providerBefore);
    const awards = await awardsOf(dispatch.id);
    expect(awards).toHaveLength(1);
    expect(awards[0].amount).toBe(-14);
    expect(
      await prisma.deliveryAssignment.count({
        where: { dispatchId: dispatch.id, status: 'ACTIVE' },
      }),
    ).toBe(1);
    await api()
      .post(`/api/v1/driver/dispatches/${dispatch.id}/release`)
      .auth(t.indep, bearer)
      .send({ reason: 'OPERATIONAL_ISSUE' })
      .expect(200);
    // V1.10-D does not refund on release: the credits stay consumed until V1.10-E.
    expect(await independentBalance(prisma, ids.driver)).toBe(0);
    expect(await awardsOf(dispatch.id)).toHaveLength(1);
  });

  it('an exact balance is enough and leaves zero; one credit less is refused and moves nothing', async () => {
    const exact = await openDispatch();
    await fundProvider(prisma, ids.providerB, 7);
    await claim(t.B, exact.id).expect(200);
    expect(await providerBalance(prisma, ids.providerB)).toBe(0);

    const short = await openDispatch();
    await fundProvider(prisma, ids.providerB, 6);
    const before = await economy();
    const refusedClaim = await claim(t.B, short.id).expect(409);
    expect(refusedClaim.body.code).toBe('INSUFFICIENT_CREDITS');
    const dispatch = await prisma.dispatch.findUniqueOrThrow({
      where: { id: short.id },
    });
    expect(dispatch.status).toBe('OPEN');
    expect(dispatch.claimedByProviderId).toBeNull();
    expect(
      await prisma.dispatchCandidate.count({
        where: { dispatchId: short.id, status: 'CLAIMED' },
      }),
    ).toBe(0);
    expect(await economy()).toEqual(before);
    expect(await awardsOf(short.id)).toHaveLength(0);
    expect(
      logs.some((l) =>
        l.includes('SERVICE_AWARD_REJECTED_INSUFFICIENT_CREDITS'),
      ),
    ).toBe(true);
    // The refused dispatch is still claimable by whoever can pay for it.
    await fundProvider(prisma, ids.providerA, 7);
    await claim(t.A, short.id).expect(200);
    expect(await awardsOf(short.id)).toHaveLength(1);
  });

  it('charges the cost frozen when the dispatch opened, not the policy in force now', async () => {
    const dispatch = await openDispatch();
    const snapshot = await prisma.dispatchCreditSnapshot.findUniqueOrThrow({
      where: {
        dispatchId_actorType: {
          dispatchId: dispatch.id,
          actorType: 'PROVIDER',
        },
      },
    });
    expect(snapshot.credits).toBe(7);
    // The economy changes after the dispatch opened: 20 credits/km from now on.
    await setPolicy('PROVIDER', perKm(20));
    await fundProvider(prisma, ids.providerA, 7);
    const balanceBefore = await providerBalance(prisma, ids.providerA);
    await claim(t.A, dispatch.id).expect(200);
    const awards = await awardsOf(dispatch.id);
    expect(awards[0].amount).toBe(-7);
    expect(await providerBalance(prisma, ids.providerA)).toBe(
      balanceBefore - 7,
    );
    // A dispatch opened now does cost the new price, and it is frozen too.
    const fresh = await openDispatch();
    const freshSnapshot = await prisma.dispatchCreditSnapshot.findUniqueOrThrow(
      {
        where: {
          dispatchId_actorType: {
            dispatchId: fresh.id,
            actorType: 'PROVIDER',
          },
        },
      },
    );
    expect(freshSnapshot.credits).toBe(140);
    await setPolicy('PROVIDER', perKm(1));
  });

  it('a fleet reassignment or an assignment cancellation never charges again', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 7);
    await claim(t.A, dispatch.id).expect(200);
    const afterClaim = await providerBalance(prisma, ids.providerA);
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
        identifier: `FA-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    const vehicleB = await prisma.vehicle.create({
      data: {
        providerId: ids.providerA,
        identifier: `FB-${run}`,
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
    // Mandaria sold the dispatch once; who executes it inside the fleet is not another sale.
    expect(await awardsOf(dispatch.id)).toHaveLength(1);
    expect(await providerBalance(prisma, ids.providerA)).toBe(afterClaim);
    // Releasing does not give the credits back either (refunds are V1.10-E).
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/release`)
      .auth(t.A, bearer)
      .send({ reason: 'Prueba V1.10-D' })
      .expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(afterClaim);
    expect(await awardsOf(dispatch.id)).toHaveLength(1);
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

  it('a failed CLAIM or TAKE never charges', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 7);
    await fundProvider(prisma, ids.providerB, 7);
    await fundIndependentDriver(prisma, ids.driver, 14);
    const before = await economy();
    // Not a candidate at all (another provider's view of an unknown dispatch): 404, no charge.
    await claim(t.A, randomUUID()).expect(404);
    // Wrong role and wrong audience.
    await claim(t.sa, dispatch.id).expect(403);
    await api()
      .post(`/api/v1/provider/dispatches/${dispatch.id}/claim`)
      .auth(t.b2b, bearer)
      .expect(401);
    await take(t.A, dispatch.id).expect(403);
    // A vehicle that is not the driver's own.
    const foreign = await prisma.vehicle.create({
      data: {
        providerId: ids.providerB,
        identifier: `FOR-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    await take(t.indep, dispatch.id, foreign.id).expect(404);
    await prisma.vehicle.delete({ where: { id: foreign.id } });
    expect(await economy()).toEqual(before);
    // Now a real claim, and the second provider arrives too late: it pays nothing.
    await claim(t.A, dispatch.id).expect(200);
    const afterWinner = await economy();
    const late = await claim(t.B, dispatch.id).expect(409);
    expect(late.body.code).toBe('DISPATCH_ALREADY_CLAIMED');
    await take(t.indep, dispatch.id).expect(409);
    expect(await economy()).toEqual(afterWinner);
    expect(await awardsOf(dispatch.id)).toHaveLength(1);
  });

  it('repeating the same CLAIM does not charge twice', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 21);
    await claim(t.A, dispatch.id).expect(200);
    const afterFirst = await providerBalance(prisma, ids.providerA);
    // The owner claiming again is the retry case: same answer, no second debit.
    await claim(t.A, dispatch.id).expect(200);
    await claim(t.A, dispatch.id).expect(200);
    expect(await providerBalance(prisma, ids.providerA)).toBe(afterFirst);
    expect(await awardsOf(dispatch.id)).toHaveLength(1);
  });
});

describe.sequential('V1.10-D concurrency', () => {
  withApp();

  it('10 simultaneous claims on one dispatch: one winner, exactly one charge', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 7);
    await fundProvider(prisma, ids.providerB, 7);
    const balancesBefore = {
      A: await providerBalance(prisma, ids.providerA),
      B: await providerBalance(prisma, ids.providerB),
    };
    const attempts = Array.from({ length: 10 }, (_, i) =>
      claim(i % 2 === 0 ? t.A : t.B, dispatch.id),
    );
    const results = await Promise.all(attempts.map((a) => a.then((r) => r)));
    // A repeated claim by the owner answers 200 again (V1.7), so what must be unique is the
    // winner and, above all, the charge.
    const winners = new Set(
      results
        .filter((r) => r.status === 200)
        .map((r) => r.body.claimedByMe as boolean),
    );
    expect(winners).toEqual(new Set([true]));
    expect(results.some((r) => r.status === 409)).toBe(true);
    const awards = await awardsOf(dispatch.id);
    expect(awards).toHaveLength(1);
    const winner = await prisma.dispatch.findUniqueOrThrow({
      where: { id: dispatch.id },
    });
    const winnerAccount = await prisma.creditAccount.findUniqueOrThrow({
      where: { id: awards[0].creditAccountId },
    });
    // Only the winner's account moved, by exactly the frozen cost.
    expect(winnerAccount.providerId).toBe(winner.claimedByProviderId);
    const after = {
      A: await providerBalance(prisma, ids.providerA),
      B: await providerBalance(prisma, ids.providerB),
    };
    const paid = winner.claimedByProviderId === ids.providerA ? 'A' : 'B';
    const idle = paid === 'A' ? 'B' : 'A';
    expect(after[paid]).toBe(balancesBefore[paid] - 7);
    expect(after[idle]).toBe(balancesBefore[idle]);
  });

  it('provider CLAIM against independent TAKE: one winner, exactly one actor pays', async () => {
    const dispatch = await openDispatch();
    await fundProvider(prisma, ids.providerA, 7);
    await fundIndependentDriver(prisma, ids.driver, 14);
    const before = {
      provider: await providerBalance(prisma, ids.providerA),
      independent: await independentBalance(prisma, ids.driver),
    };
    const [claimRes, takeRes] = await Promise.all([
      claim(t.A, dispatch.id),
      take(t.indep, dispatch.id),
    ]);
    const statuses = [claimRes.status, takeRes.status].sort();
    expect(statuses).toEqual([200, 409]);
    const awards = await awardsOf(dispatch.id);
    expect(awards).toHaveLength(1);
    const after = {
      provider: await providerBalance(prisma, ids.providerA),
      independent: await independentBalance(prisma, ids.driver),
    };
    if (claimRes.status === 200) {
      expect(after.provider).toBe(before.provider - 7);
      expect(after.independent).toBe(before.independent);
    } else {
      expect(after.independent).toBe(before.independent! - 14);
      expect(after.provider).toBe(before.provider);
      await api()
        .post(`/api/v1/driver/dispatches/${dispatch.id}/release`)
        .auth(t.indep, bearer)
        .send({ reason: 'OPERATIONAL_ISSUE' })
        .expect(200);
    }
  });

  it('two claims paid from one balance: only what the balance covers is charged', async () => {
    const first = await openDispatch();
    const second = await openDispatch();
    // Exactly 10 credits for two services of 7: only one can be paid.
    await setProviderBalance(prisma, ids.providerB, 10);
    const results = await Promise.all([
      claim(t.B, first.id),
      claim(t.B, second.id),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe(
      'INSUFFICIENT_CREDITS',
    );
    expect(await providerBalance(prisma, ids.providerB)).toBe(3);
    const awards = [
      ...(await awardsOf(first.id)),
      ...(await awardsOf(second.id)),
    ];
    expect(awards).toHaveLength(1);
  });

  it('a balance that covers both services pays both and ends at zero', async () => {
    const first = await openDispatch();
    const second = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 14);
    const results = await Promise.all([
      claim(t.A, first.id),
      claim(t.A, second.id),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(await providerBalance(prisma, ids.providerA)).toBe(0);
    expect([
      ...(await awardsOf(first.id)),
      ...(await awardsOf(second.id)),
    ]).toHaveLength(2);
  });

  it('a recharge racing a claim serializes: never corruption', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerB, 0);
    const [claimRes, recharge] = await Promise.all([
      claim(t.B, dispatch.id),
      api()
        .post(`/api/v1/admin/providers/${ids.providerB}/credits/recharge`)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({ credits: 10, method: 'TRANSFER' }),
    ]);
    expect(recharge.status).toBe(201);
    const balance = await providerBalance(prisma, ids.providerB);
    const awards = await awardsOf(dispatch.id);
    // Either order is valid; what is never valid is a balance that does not match its ledger.
    if (claimRes.status === 200) {
      expect(awards).toHaveLength(1);
      expect(balance).toBe(3);
    } else {
      expect(claimRes.status).toBe(409);
      expect(awards).toHaveLength(0);
      expect(balance).toBe(10);
    }
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
    expect(reconstructed).toBe(balance);
  });

  it('an administrative adjustment racing a claim keeps the balance consistent', async () => {
    const dispatch = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    const [claimRes, adjustment] = await Promise.all([
      claim(t.A, dispatch.id),
      api()
        .post(`/api/v1/admin/providers/${ids.providerA}/credits/adjustment`)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({ amount: -7, reason: 'Ajuste simultaneo' }),
    ]);
    const balance = await providerBalance(prisma, ids.providerA);
    expect(balance).toBeGreaterThanOrEqual(0);
    // One of the two movements may lose; both cannot take the same credits.
    const applied =
      (claimRes.status === 200 ? 7 : 0) + (adjustment.status === 201 ? 7 : 0);
    expect(7 - applied).toBe(balance);
    expect([200, 409]).toContain(claimRes.status);
    expect([201, 409]).toContain(adjustment.status);
  });
});

describe.sequential(
  'V1.10-D legacy, corruption and database guarantees',
  () => {
    withApp();

    it('a legacy dispatch is awarded without any charge and says so in the log', async () => {
      const dispatch = await openDispatch();
      await makeLegacy(dispatch.id);
      const before = await economy();
      const view = await api()
        .get(`/api/v1/provider/dispatches/${dispatch.id}`)
        .auth(t.A, bearer)
        .expect(200);
      expect(view.body.creditCost).toBeNull();
      await claim(t.A, dispatch.id).expect(200);
      expect(await economy()).toEqual(before);
      expect(await awardsOf(dispatch.id)).toHaveLength(0);
      expect(
        logs.some(
          (l) =>
            l.includes('LEGACY_DISPATCH_CREDIT_SKIPPED') &&
            l.includes(dispatch.id),
        ),
      ).toBe(true);
      // No zero-credit entry was invented to represent the free award.
      expect(
        await prisma.creditLedgerEntry.count({ where: { amount: 0 } }),
      ).toBe(0);
    });

    it('a monetized dispatch whose snapshot disappeared fails closed instead of being free', async () => {
      const dispatch = await openDispatch();
      await dropSnapshots(dispatch.id);
      await fundProvider(prisma, ids.providerA, 7);
      const before = await economy();
      const refusedClaim = await claim(t.A, dispatch.id).expect(409);
      expect(refusedClaim.body.code).toBe('CREDIT_SNAPSHOT_UNAVAILABLE');
      const row = await prisma.dispatch.findUniqueOrThrow({
        where: { id: dispatch.id },
      });
      expect(row.status).toBe('OPEN');
      expect(row.creditMode).toBe('MONETIZED');
      expect(await economy()).toEqual(before);
      const refusedTake = await take(t.indep, dispatch.id).expect(409);
      expect(refusedTake.body.code).toBe('CREDIT_SNAPSHOT_UNAVAILABLE');
      expect(await economy()).toEqual(before);
    });

    it('refuses every forged award written directly in SQL', async () => {
      const dispatch = await openDispatch();
      await fundProvider(prisma, ids.providerA, 21);
      await claim(t.A, dispatch.id).expect(200);
      const account = await prisma.creditAccount.findUniqueOrThrow({
        where: { providerId: ids.providerA },
      });
      const other = await prisma.creditAccount.findUniqueOrThrow({
        where: { providerId: ids.providerB },
      });
      const award = (await awardsOf(dispatch.id))[0];
      const free = await openDispatch();
      const legacy = await openDispatch();
      await makeLegacy(legacy.id);
      const entry = (over: Record<string, unknown>) =>
        prisma.creditLedgerEntry.create({
          data: {
            creditAccountId: account.id,
            type: 'SERVICE_AWARD',
            amount: -7,
            balanceBefore: account.balance,
            balanceAfter: account.balance - 7,
            referenceType: 'DISPATCH',
            referenceId: free.id,
            createdByUserId: ids.sa,
            ...over,
          } as never,
        });
      const outcome: Record<string, string> = {
        'second award for the same dispatch and account': await refused(() =>
          entry({
            referenceId: dispatch.id,
            balanceBefore: account.balance,
            balanceAfter: account.balance - 7,
          }),
        ),
        'award for a dispatch nobody claimed': await refused(() => entry({})),
        'award for a legacy dispatch': await refused(() =>
          entry({ referenceId: legacy.id }),
        ),
        'award charged to another provider': await refused(() =>
          entry({
            creditAccountId: other.id,
            referenceId: dispatch.id,
            balanceBefore: other.balance,
            balanceAfter: other.balance - 7,
          }),
        ),
        'forged amount for the right dispatch': await refused(() =>
          entry({
            referenceId: dispatch.id,
            amount: -1,
            balanceAfter: account.balance - 1,
          }),
        ),
        'award without a dispatch reference': await refused(() =>
          entry({ referenceType: null, referenceId: null }),
        ),
        'award pointing at something that is not a dispatch': await refused(
          () => entry({ referenceId: randomUUID() }),
        ),
        'award with a positive amount': await refused(() =>
          entry({
            referenceId: dispatch.id,
            amount: 7,
            balanceAfter: account.balance + 7,
          }),
        ),
        'award that would leave a negative balance': await refused(() =>
          entry({
            referenceId: free.id,
            amount: -(account.balance + 1),
            balanceAfter: -1,
          }),
        ),
        // The non-negative guarantee itself, on a movement the award guard does not re-derive.
        'any movement that would leave a negative balance': await refused(() =>
          prisma.creditLedgerEntry.create({
            data: {
              creditAccountId: account.id,
              type: 'ADMIN_ADJUSTMENT',
              amount: -(account.balance + 1),
              balanceBefore: account.balance,
              balanceAfter: -1,
              reason: 'Saldo negativo a la fuerza',
              createdByUserId: ids.sa,
              idempotencyKey: randomUUID(),
              requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
            },
          }),
        ),
        'editing a written award': await refused(() =>
          prisma.creditLedgerEntry.update({
            where: { id: award.id },
            data: { amount: -1 },
          }),
        ),
        'deleting a written award': await refused(() =>
          prisma.creditLedgerEntry.delete({ where: { id: award.id } }),
        ),
        'moving a balance without a ledger entry': await refused(() =>
          prisma.$executeRawUnsafe(
            `UPDATE "CreditAccount" SET balance = balance + 100 WHERE id = $1::uuid`,
            account.id,
          ),
        ),
        'relabelling a monetized dispatch as legacy': await refused(() =>
          prisma.$executeRawUnsafe(
            `UPDATE "Dispatch" SET "creditMode" = 'LEGACY' WHERE id = $1::uuid`,
            free.id,
          ),
        ),
      };
      expect(outcome).toEqual({
        'second award for the same dispatch and account': 'Unique constraint',
        'award for a dispatch nobody claimed': 'CREDIT_AWARD_INVALID',
        'award for a legacy dispatch': 'CREDIT_AWARD_INVALID',
        'award charged to another provider': 'CREDIT_AWARD_INVALID',
        'forged amount for the right dispatch': 'CREDIT_AWARD_MISMATCH',
        // The guard runs before the CHECKs, so a malformed award is stopped by the reason that
        // describes it best: no such dispatch, or an amount that is not the frozen cost.
        'award without a dispatch reference': 'CREDIT_AWARD_INVALID',
        'award pointing at something that is not a dispatch':
          'CREDIT_AWARD_INVALID',
        'award with a positive amount': 'CREDIT_AWARD_MISMATCH',
        'award that would leave a negative balance': 'CREDIT_AWARD_MISMATCH',
        // 23514: the arithmetic CHECK of V1.10-A, which bounds every balance at zero.
        'any movement that would leave a negative balance': '23514',
        'editing a written award': 'CREDIT_LEDGER_IMMUTABLE',
        'deleting a written award': 'CREDIT_LEDGER_IMMUTABLE',
        'moving a balance without a ledger entry':
          'CREDIT_BALANCE_WITHOUT_LEDGER',
        'relabelling a monetized dispatch as legacy':
          'DISPATCH_CREDIT_MODE_IMMUTABLE',
      });
      expect(await awardsOf(dispatch.id)).toHaveLength(1);
      expect(await providerBalance(prisma, ids.providerA)).toBe(
        account.balance,
      );
    });

    it('the client cannot choose what it pays: forged fields are ignored or rejected', async () => {
      const dispatch = await openDispatch();
      await fundProvider(prisma, ids.providerA, 7);
      const snapshot = await prisma.dispatchCreditSnapshot.findUniqueOrThrow({
        where: {
          dispatchId_actorType: {
            dispatchId: dispatch.id,
            actorType: 'PROVIDER',
          },
        },
      });
      const account = await prisma.creditAccount.findUniqueOrThrow({
        where: { providerId: ids.providerA },
      });
      const forged = await api()
        .post(`/api/v1/provider/dispatches/${dispatch.id}/claim`)
        .auth(t.A, bearer)
        .send({
          creditCost: 1,
          credits: 1,
          amount: -1,
          creditSnapshotId: snapshot.id,
          creditAccountId: account.id,
          actorType: 'INDEPENDENT_DRIVER',
          type: 'SERVICE_REFUND',
        });
      // Whatever the contract does with unknown fields, it never changes the charge.
      expect([200, 400]).toContain(forged.status);
      if (forged.status === 200) {
        const awards = await awardsOf(dispatch.id);
        expect(awards).toHaveLength(1);
        expect(awards[0].amount).toBe(-7);
        expect(awards[0].creditAccountId).toBe(account.id);
        expect(await providerBalance(prisma, ids.providerA)).toBe(
          account.balance - 7,
        );
      } else {
        expect(await awardsOf(dispatch.id)).toHaveLength(0);
        expect(await providerBalance(prisma, ids.providerA)).toBe(
          account.balance,
        );
      }
    });

    it('keeps the payment context and the recharge history untouched', async () => {
      const dispatch = await openDispatch();
      const balanceBefore = await providerBalance(prisma, ids.providerA);
      await api()
        .post(`/api/v1/admin/providers/${ids.providerA}/credits/recharge`)
        .auth(t.sa, bearer)
        .set('Idempotency-Key', randomUUID())
        .send({
          credits: 20,
          method: 'TRANSFER',
          externalReference: `R-${run}`,
        })
        .expect(201);
      expect(await providerBalance(prisma, ids.providerA)).toBe(
        balanceBefore + 20,
      );
      const claimed = await claim(t.A, dispatch.id).expect(200);
      expect(await providerBalance(prisma, ids.providerA)).toBe(
        balanceBefore + 13,
      );
      // Money stays money and credits stay credits: no conversion, no cross-sum.
      expect(claimed.body.service.deliveryFee).toEqual({
        amount: '60.00',
        currency: 'MXN',
      });
      expect(claimed.body.service.goods).toMatchObject({
        value: '800.00',
        currency: 'MXN',
        driverAdvancesGoods: true,
        driverAdvanceAmount: '800.00',
      });
      expect(claimed.body.creditCost).toBe(7);
      const ledger = await api()
        .get(`/api/v1/admin/providers/${ids.providerA}/credits/ledger`)
        .auth(t.sa, bearer)
        .expect(200);
      const types = ledger.body.items.map((e: { type: string }) => e.type);
      expect(types.slice(0, 2)).toEqual(['SERVICE_AWARD', 'RECHARGE']);
      expect(ledger.body.items[0]).toMatchObject({ amount: -7 });
      expect(ledger.body.items[1]).toMatchObject({ amount: 20 });
    });

    it('no secret reaches the logs of a charged award', () => {
      const award = logs.filter((l) => l.includes('SERVICE_AWARD_CHARGED'));
      expect(award.length).toBeGreaterThan(0);
      for (const line of award) {
        expect(line).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
        expect(line).not.toContain(password);
        expect(line).toContain('creditAccountId');
      }
    });
  },
);

// Corrective D barriers: real PostgreSQL, without purge switches or disabled guards.
describe.sequential('V1.10-D deferred SQL award integrity', () => {
  withApp();
  for (const mode of ['PROVIDER', 'INDEPENDENT_DRIVER'] as const) {
    for (const attack of [
      'missing',
      'amount',
      'payer',
      'actor',
      'duplicate',
      'orphan',
      'valid',
    ] as const) {
      it(mode + ' SQL ' + attack, async () => {
        // Earlier scenarios may keep the independent busy; release through the real API.
        const held = await prisma.dispatch.findFirst({
          where: {
            status: 'CLAIMED',
            claimedByIndependentDriverId: ids.driver,
          },
        });
        if (held)
          await api()
            .post('/api/v1/driver/dispatches/' + held.id + '/release')
            .auth(t.indep, bearer)
            .send({ reason: 'OPERATIONAL_ISSUE' })
            .expect(200);
        const d = await openDispatch();
        await setProviderBalance(prisma, ids.providerA, 100);
        await setProviderBalance(prisma, ids.providerB, 100);
        await fundIndependentDriver(prisma, ids.driver, 100);
        const profile = await prisma.independentDriverProfile.findUniqueOrThrow(
          { where: { driverId: ids.driver }, include: { driver: true } },
        );
        const pa = await prisma.creditAccount.findUniqueOrThrow({
          where: { providerId: ids.providerA },
        });
        const pb = await prisma.creditAccount.findUniqueOrThrow({
          where: { providerId: ids.providerB },
        });
        const ia = await prisma.creditAccount.findUniqueOrThrow({
          where: { independentDriverProfileId: profile.id },
        });
        const before = await economy();
        const account =
          attack === 'payer'
            ? pb
            : attack === 'actor'
              ? mode === 'PROVIDER'
                ? ia
                : pa
              : mode === 'PROVIDER'
                ? pa
                : ia;
        const cost = mode === 'PROVIDER' ? 7 : 14;
        let error: unknown;
        try {
          await prisma.$transaction(async (tx) => {
            const now = new Date();
            if (attack !== 'orphan') {
              if (mode === 'PROVIDER') {
                await tx.dispatchCandidate.update({
                  where: {
                    dispatchId_providerId: {
                      dispatchId: d.id,
                      providerId: ids.providerA,
                    },
                  },
                  data: { status: 'CLAIMED', claimedAt: now },
                });
                await tx.dispatch.update({
                  where: { id: d.id },
                  data: {
                    status: 'CLAIMED',
                    claimedByProviderId: ids.providerA,
                    claimedAt: now,
                  },
                });
              } else {
                await tx.dispatch.update({
                  where: { id: d.id },
                  data: {
                    status: 'CLAIMED',
                    claimedByIndependentDriverId: ids.driver,
                    claimedAt: now,
                  },
                });
                await tx.deliveryAssignment.create({
                  data: {
                    dispatchId: d.id,
                    mode: 'INDEPENDENT',
                    independentDriverProfileId: profile.id,
                    driverId: ids.driver,
                    vehicleId: ids.vehicle,
                    assignedAt: now,
                    assignedByUserId: profile.driver.userId,
                  },
                });
              }
            }
            if (attack !== 'missing') {
              const amount = -(attack === 'amount' ? cost - 1 : cost);
              await tx.creditLedgerEntry.create({
                data: {
                  creditAccountId: account.id,
                  type: 'SERVICE_AWARD',
                  amount,
                  balanceBefore: account.balance,
                  balanceAfter: account.balance + amount,
                  referenceType: 'DISPATCH',
                  referenceId: d.id,
                  createdByUserId: ids.sa,
                },
              });
              if (attack === 'duplicate')
                await tx.creditLedgerEntry.create({
                  data: {
                    creditAccountId: account.id,
                    type: 'SERVICE_AWARD',
                    amount,
                    balanceBefore: account.balance + amount,
                    balanceAfter: account.balance + 2 * amount,
                    referenceType: 'DISPATCH',
                    referenceId: d.id,
                    createdByUserId: ids.sa,
                  },
                });
            }
          });
        } catch (caught) {
          error = caught;
        }
        if (attack === 'valid') {
          expect(error).toBeUndefined();
          expect(await awardsOf(d.id)).toHaveLength(1);
          expect((await awardsOf(d.id))[0].amount).toBe(-cost);
          expect(
            (await prisma.dispatch.findUniqueOrThrow({ where: { id: d.id } }))
              .status,
          ).toBe('CLAIMED');
          if (mode === 'INDEPENDENT_DRIVER')
            expect(
              await prisma.deliveryAssignment.count({
                where: { dispatchId: d.id, status: 'ACTIVE' },
              }),
            ).toBe(1);
        } else {
          expect(error, 'SQL attack unexpectedly committed').toBeDefined();
          // A SQL error from the intended integrity barrier, not an unrelated fixture failure.
          expect(String(error)).toMatch(
            attack === 'duplicate'
              ? /Unique constraint|service_award_key/
              : /CREDIT_AWARD/,
          );
          expect(await economy()).toEqual(before);
          expect(await awardsOf(d.id)).toHaveLength(0);
          expect(
            (await prisma.dispatch.findUniqueOrThrow({ where: { id: d.id } }))
              .status,
          ).toBe('OPEN');
          expect(
            await prisma.deliveryAssignment.count({
              where: { dispatchId: d.id },
            }),
          ).toBe(0);
        }
      });
    }
  }
});

describe.sequential('V1.10-D reverse history protection', () => {
  withApp();
  it('claim and release inside one SQL transaction cannot erase the required debit', async () => {
    const d = await openDispatch();
    const before = await economy();
    await expect(
      prisma.$transaction(async (tx) => {
        const now = new Date();
        await tx.dispatchCandidate.update({
          where: {
            dispatchId_providerId: {
              dispatchId: d.id,
              providerId: ids.providerA,
            },
          },
          data: { status: 'CLAIMED', claimedAt: now },
        });
        await tx.dispatch.update({
          where: { id: d.id },
          data: {
            status: 'CLAIMED',
            claimedByProviderId: ids.providerA,
            claimedAt: now,
          },
        });
        await tx.dispatchCandidate.update({
          where: {
            dispatchId_providerId: {
              dispatchId: d.id,
              providerId: ids.providerA,
            },
          },
          data: {
            status: 'RELEASED',
            releasedAt: now,
            releaseReason: 'SQL transient award',
          },
        });
        await tx.dispatch.update({
          where: { id: d.id },
          data: { status: 'OPEN', claimedByProviderId: null, claimedAt: null },
        });
      }),
    ).rejects.toThrow(/CREDIT_AWARD_REQUIRED/);
    expect(await economy()).toEqual(before);
    expect(
      (await prisma.dispatch.findUniqueOrThrow({ where: { id: d.id } })).status,
    ).toBe('OPEN');
  });
  it('an enforced debit cannot lose its durable winner history', async () => {
    const d = await openDispatch();
    await setProviderBalance(prisma, ids.providerA, 7);
    await claim(t.A, d.id).expect(200);
    await api()
      .post('/api/v1/provider/dispatches/' + d.id + '/release')
      .auth(t.A, bearer)
      .send({ reason: 'SQL history protection' })
      .expect(200);
    const before = await economy();
    await expect(
      prisma.dispatchCandidate.delete({
        where: {
          dispatchId_providerId: {
            dispatchId: d.id,
            providerId: ids.providerA,
          },
        },
      }),
    ).rejects.toThrow(/CREDIT_AWARD_ORPHAN/);
    expect(await economy()).toEqual(before);
    expect(await awardsOf(d.id)).toHaveLength(1);
  });
  it('runtime SQL cannot fabricate a historical exemption', async () => {
    const d = await openDispatch();
    await expect(
      prisma.dispatchPreEnforcementAward.create({
        data: {
          dispatchId: d.id,
          actorType: 'PROVIDER',
          actorId: ids.providerA,
          awardedAt: new Date(),
        },
      }),
    ).rejects.toThrow(/CREDIT_HISTORY_IMMUTABLE/);
    expect(
      await prisma.dispatchPreEnforcementAward.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(0);
  });
});
