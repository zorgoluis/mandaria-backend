import 'reflect-metadata';
import { hash } from 'argon2';
import { sign } from 'jsonwebtoken';
import { fundForAward } from './support/credits.js';
import { writeFileSync } from 'node:fs';
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
  routingProvider: 'd-controlled',
  calculatedAt: new Date(),
});
const routing = {
  name: 'd-controlled',
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
const userIds: string[] = [];
const providerIds: string[] = [];
const requestPublicIds: string[] = [];
const api = () => request((apiIndex++ % 2 ? app2 : app).getHttpServer());
const post = (k = key(), b: object = body, t = tokens[0]) =>
  api()
    .post('/api/v1/delivery-prequotes')
    .auth(t, { type: 'bearer' })
    .set('Idempotency-Key', k)
    .send(b);
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
      code: `D13_${run}_${i}`,
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
      code: `D13_${run}`,
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
  for (const publicId of requestPublicIds) await cancel(publicId).expect(200);
  if (zoneId)
    await p.serviceZone.update({
      where: { id: zoneId },
      data: { status: 'INACTIVE' },
    });
  await p.integrationCredential.updateMany({
    where: { id: { in: credentials } },
    data: { status: 'REVOKED', revokedAt: new Date() },
  });
  await p.user.updateMany({
    where: { id: { in: userIds } },
    data: { active: false },
  });
  await p.deliveryProvider.updateMany({
    where: { id: { in: providerIds } },
    data: { status: 'SUSPENDED' },
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
  requestPublicIds.push(r.body.deliveryRequestPublicId);
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
const human = async (role: 'PROVIDER_ADMIN' | 'DRIVER' | 'SUPER_ADMIN') => {
  const user = await p.user.create({
    data: {
      email: `d-${randomUUID()}@fixture.test`,
      role,
      active: true,
      passwordHash: await hash(randomBytes(32).toString('base64url')),
    },
  });
  userIds.push(user.id);
  return {
    user,
    token: sign(
      { sub: user.id, type: 'access' },
      process.env.JWT_ACCESS_SECRET!,
      { issuer: 'mandaria', audience: 'mandaria-users', expiresIn: 3600 },
    ),
  };
};
async function actors(independent: boolean) {
  const admin = await human('PROVIDER_ADMIN'),
    courier = await human('DRIVER');
  const provider = await p.deliveryProvider.create({
    data: {
      name: 'D test provider',
      code: `D13_${randomUUID()}`,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 3,
      maxVehicles: 3,
    },
  });
  providerIds.push(provider.id);
  await p.providerMembership.create({
    data: { providerId: provider.id, userId: admin.user.id, role: 'OWNER' },
  });
  const driver = await p.driver.create({
    data: {
      providerId: provider.id,
      userId: courier.user.id,
      name: 'D courier',
      status: 'ACTIVE',
      availability: 'AVAILABLE',
    },
  });
  let profileId: string | undefined;
  if (independent) {
    const approver = await human('SUPER_ADMIN');
    const profile = await p.independentDriverProfile.create({
      data: {
        driverId: driver.id,
        status: 'APPROVED',
        approvedAt: new Date(),
        approvedByUserId: approver.user.id,
      },
    });
    profileId = profile.id;
  }
  const vehicle = await p.vehicle.create({
    data: {
      ...(profileId
        ? { independentDriverProfileId: profileId }
        : { providerId: provider.id }),
      identifier: `D13-${randomUUID().slice(0, 12).toUpperCase()}`,
      type: 'MOTORCYCLE',
      status: 'ACTIVE',
    },
  });
  await p.providerServiceCoverage.create({
    data: {
      providerId: provider.id,
      serviceZoneId: zoneId,
      serviceType: 'LOCAL_DELIVERY',
    },
  });
  return { admin, courier, provider, driver, vehicle };
}
const get = (path: string, token: string) =>
  api().get(`/api/v1/${path}`).auth(token, { type: 'bearer' });
const act = (path: string, token: string, b: object = {}) =>
  api().post(`/api/v1/${path}`).auth(token, { type: 'bearer' }).send(b);
const instruction = (applicability: string) => ({
  applicability,
  goodsPaidToRestaurant: true,
  advanceToRestaurant: false,
  collectGoodsFromRecipient: false,
  deliveryFee: { amount: '25.10', currency: 'MXN' },
  payer: 'RECIPIENT',
  method: 'CASH',
  dueAt: 'DELIVERY',
  component: 'DELIVERY_FEE',
});
function privateDataAbsent(body: unknown) {
  const text = JSON.stringify(body);
  for (const forbidden of [
    'receipt-demo',
    'order-demo',
    'private-consent-fixture',
    'authorizationReference',
    'authenticatedTokenExpiresAt',
    'credentialId',
    'secretHash',
    'goodsPaymentReference',
    'orderAcceptanceReference',
  ])
    expect(text).not.toContain(forbidden);
}
describe('V1.13-D executor financial instructions', () => {
  it.each([false, true])(
    'converted offer, execution and cancellation preserve exact persisted instructions (independent=%s)',
    async (independent) => {
      const a = await actors(independent),
        other = await human('PROVIDER_ADMIN');
      const x = await converted();
      await accept(x.r.body.quote.publicId, attestation(x.r.body.quote)).expect(
        200,
      );
      const d = await p.dispatch.findUniqueOrThrow({
        where: { deliveryQuoteId: x.c.deliveryQuoteId },
      });
      const base = independent
        ? `driver/dispatches/${d.id}`
        : `provider/dispatches/${d.id}`;
      const token = independent ? a.courier.token : a.admin.token;
      const offer = await get(base, token).expect(200);
      expect(offer.body.collectionInstructions).toEqual(instruction('OFFER'));
      privateDataAbsent(offer.body);
      const list = await get(
        independent ? 'driver/dispatches/available' : 'provider/dispatches',
        token,
      ).expect(200);
      expect(
        list.body.items.find((v: { id: string }) => v.id === d.id)
          .collectionInstructions,
      ).toEqual(instruction('OFFER'));
      await get(`provider/dispatches/${d.id}`, other.token).expect(403);
      await get(base, tokens[0]).expect(401);
      await fundForAward(
        p,
        d.id,
        independent ? { driverId: a.driver.id } : { providerId: a.provider.id },
      );
      const won = await act(
        `${base}/${independent ? 'take' : 'claim'}`,
        token,
        independent ? { vehicleId: a.vehicle.id } : {},
      ).expect(200);
      expect(won.body.collectionInstructions).toEqual(instruction('CURRENT'));
      if (!independent) {
        const assigned = await act(`${base}/assignment`, token, {
          driverId: a.driver.id,
          vehicleId: a.vehicle.id,
        }).expect(201);
        expect(assigned.body.collectionInstructions).toEqual(
          instruction('CURRENT'),
        );
        const second = await human('DRIVER');
        const replacement = await p.driver.create({
          data: {
            providerId: a.provider.id,
            userId: second.user.id,
            name: 'D replacement',
            status: 'ACTIVE',
            availability: 'AVAILABLE',
          },
        });
        const reassigned = await act(`${base}/assignment/reassign`, token, {
          driverId: replacement.id,
          vehicleId: a.vehicle.id,
          reason: 'OPERATIONAL_CHANGE',
        }).expect(200);
        expect(reassigned.body.collectionInstructions).toEqual(
          instruction('CURRENT'),
        );
        expect(
          (await get('driver/me', a.courier.token)).body
            .activeDeliveryAssignment,
        ).toBeNull();
        expect(
          (await get('driver/me', second.token)).body.activeDeliveryAssignment
            .collectionInstructions,
        ).toEqual(instruction('CURRENT'));
        const cancelledAssignment = await act(
          `${base}/assignment/cancel`,
          token,
          { reason: 'OPERATIONAL_CHANGE' },
        ).expect(200);
        expect(cancelledAssignment.body.collectionInstructions).toEqual(
          instruction('HISTORICAL'),
        );
        await act(`${base}/assignment`, token, {
          driverId: a.driver.id,
          vehicleId: a.vehicle.id,
        }).expect(201);
      }
      const me = await get('driver/me', a.courier.token).expect(200);
      expect(me.body.activeDeliveryAssignment.collectionInstructions).toEqual(
        instruction('CURRENT'),
      );
      privateDataAbsent(me.body);
      if (!independent)
        writeFileSync(
          'docs/checks/v1.13-d-response-example.json',
          JSON.stringify(won.body, null, 2) + '\n',
        );
      const awards = await p.creditLedgerEntry.count({
        where: { type: 'SERVICE_AWARD', referenceId: d.id },
      });
      await cancel(x.r.body.deliveryRequestPublicId).expect(200);
      expect((await status(x.r.body.deliveryRequestPublicId)).body.status).toBe(
        'CANCELLED',
      );
      const history = await get(base, token).expect(200);
      expect(history.body.collectionInstructions).toEqual(
        instruction('HISTORICAL'),
      );
      privateDataAbsent(history.body);
      expect(
        (await get('driver/me', a.courier.token)).body.activeDeliveryAssignment,
      ).toBeNull();
      expect(
        await p.creditLedgerEntry.count({
          where: { type: 'SERVICE_AWARD', referenceId: d.id },
        }),
      ).toBe(awards);
      expect(
        await p.creditLedgerEntry.count({
          where: { type: 'SERVICE_REFUND', referenceId: d.id },
        }),
      ).toBe(1);
    },
  );
  it.each([false, true])(
    'release removes current collection instructions and preserves credit refunds (independent=%s)',
    async (independent) => {
      const a = await actors(independent),
        x = await converted();
      await accept(x.r.body.quote.publicId, attestation(x.r.body.quote)).expect(
        200,
      );
      const d = await p.dispatch.findUniqueOrThrow({
        where: { deliveryQuoteId: x.c.deliveryQuoteId },
      });
      const base = `${independent ? 'driver' : 'provider'}/dispatches/${d.id}`;
      const token = independent ? a.courier.token : a.admin.token;
      await fundForAward(
        p,
        d.id,
        independent ? { driverId: a.driver.id } : { providerId: a.provider.id },
      );
      await act(
        `${base}/${independent ? 'take' : 'claim'}`,
        token,
        independent ? { vehicleId: a.vehicle.id } : {},
      ).expect(200);
      const released = await act(
        `${base}/release`,
        token,
        independent
          ? { reason: 'OTHER', reasonDetail: 'Operational release fixture' }
          : { reason: 'Operational release fixture' },
      ).expect(200);
      if (independent)
        expect(released.body.collectionInstructions).toEqual(
          instruction('OFFER'),
        );
      else expect(released.body).not.toHaveProperty('collectionInstructions');
      expect(
        (await get('driver/me', a.courier.token).expect(200)).body
          .activeDeliveryAssignment,
      ).toBeNull();
      expect(
        await p.creditLedgerEntry.count({
          where: { referenceId: d.id, type: 'SERVICE_REFUND' },
        }),
      ).toBe(1);
      await cancel(x.r.body.deliveryRequestPublicId).expect(200);
    },
  );
  it('delivery is historical, never proof of collection; late cancellation does not reactivate instructions', async () => {
    const a = await actors(true),
      x = await converted();
    await accept(x.r.body.quote.publicId, attestation(x.r.body.quote)).expect(
      200,
    );
    const d = await p.dispatch.findUniqueOrThrow({
        where: { deliveryQuoteId: x.c.deliveryQuoteId },
      }),
      base = `driver/dispatches/${d.id}`;
    await fundForAward(p, d.id, { driverId: a.driver.id });
    await act(`${base}/take`, a.courier.token, {
      vehicleId: a.vehicle.id,
    }).expect(200);
    const delivered = await act(`${base}/deliver`, a.courier.token).expect(200);
    expect(delivered.body.collectionInstructions).toEqual(
      instruction('HISTORICAL'),
    );
    await cancel(x.r.body.deliveryRequestPublicId).expect(200);
    expect(
      (await get(base, a.courier.token)).body.collectionInstructions,
    ).toEqual(instruction('HISTORICAL'));
    expect(
      await p.creditLedgerEntry.count({
        where: { referenceId: d.id, type: 'SERVICE_REFUND' },
      }),
    ).toBe(0);
  });
});
