import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { spawnSync } from 'node:child_process';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { ensureTestCreditPolicies } from './support/credit-policies.js';
import { fundForAward } from './support/credits.js';

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
process.env.DISPATCH_TTL_MINUTES = '1';
process.env.LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES = '5';
process.env.INDEPENDENT_DRIVER_MAX_VEHICLES = '2';
process.env.MAIL_PROVIDER = 'local_outbox';
process.env.DETAILED_EXECUTION_ENABLED = 'true';
process.env.PREQUOTE_AUTHORIZED_ACCEPT_ENABLED = 'true';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_IND_ATTEMPT_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@independent.test`.toLowerCase();
const GOODS_VALUE = '800.00';
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
      distanceMeters: 4200,
      durationSeconds: 700,
      routingProvider: 'fake',
      calculatedAt: new Date(),
    };
  },
};
const ZONE = { lng: -96.5, lat: 19.5 };
const square = () => ({
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
});
const providers: Record<string, string> = {};
const drivers: Record<string, string> = {};
const vehicles: Record<string, string> = {};
const userIds: string[] = [];
const clientIds: string[] = [];
const t: Record<string, string> = {};
let zoneId = '';
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

/** Accepted quote → dispatch OPEN. Provider A is always an eligible candidate. */
async function openDispatch(fund = true, requester = false) {
  if (requester) {
    const path = `/api/v1/admin/integrations/${clientIds[0]}/shipping-policy`;
    const policy = await api().get(path).auth(t.sa, bearer).expect(200);
    await api()
      .post(path)
      .auth(t.sa, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({ payer: 'REQUESTER', expectedRevision: policy.body.revision })
      .expect(200);
  }
  const stop = (type: string, sequence: number, d: number) => ({
    type,
    sequence,
    address: `Calle ${run} ${sequence}`,
    latitude: ZONE.lat + d,
    longitude: ZONE.lng + d,
    contactName: `Contacto ${run}`,
    contactPhone: '9614443322',
    instructions: `Timbre ${sequence}`,
  });
  const req = await api()
    .post('/api/v1/delivery-requests')
    .auth(t.b2b, bearer)
    .set('Idempotency-Key', randomUUID())
    .send({
      externalReference: `IND-${run}`,
      ...(requester
        ? {
            payerContact: {
              name: 'Synthetic payer',
              phone: '0000000000',
              capacity: 'REQUESTER',
            },
          }
        : {}),
      stops: [stop('PICKUP', 1, 0.02), stop('DROPOFF', 2, 0.05)],
      packages: [
        {
          category: 'FOOD',
          description: 'Pedido secreto',
          quantity: 1,
          handlingInstructions: 'No voltear',
        },
      ],
      financialContext: {
        goodsValue: GOODS_VALUE,
        goodsPaymentMode: requester ? 'PREPAID' : 'COURIER_ADVANCE',
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
    .set('Idempotency-Key', randomUUID())
    .send(
      requester
        ? {
            customerAuthorization: {
              version: 2,
              status: 'AUTHORIZED_BY_CUSTOMER',
              reference: 'synthetic-consent',
              authorizedAt: new Date().toISOString(),
              quotePublicId: quote.body.publicId,
              amount: quote.body.amount,
              currency: quote.body.currency,
              expiresAt: quote.body.expiresAt,
              shippingTermsVersion: 1,
              shippingTermsHash: req.body.shippingTerms.termsHash,
            },
          }
        : {},
    )
    .expect(200);
  const row = await prisma.deliveryQuote.findUniqueOrThrow({
    where: { publicId: quote.body.publicId },
  });
  const dispatch = await prisma.dispatch.findUniqueOrThrow({
    where: { deliveryQuoteId: row.id },
  });
  // V1.10-D: taking debits the frozen cost. This suite is about the take rules, so every driver
  // and the fleet provider get exactly what this one service costs, never a fat balance.
  if (fund)
    for (const driverId of Object.values(drivers))
      if (
        await prisma.independentDriverProfile.findUnique({
          where: { driverId },
        })
      )
        await fundForAward(prisma, dispatch.id, { driverId });
  if (fund)
    for (const providerId of Object.values(providers))
      await fundForAward(prisma, dispatch.id, { providerId });
  return { id: dispatch.id, requestPublicId: req.body.publicId as string };
}
const take = (token: string, dispatchId: string, vehicleId: string) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/take`)
    .auth(token, bearer)
    .send({ vehicleId });
const release = (
  token: string,
  dispatchId: string,
  body: object = { reason: 'CANNOT_COMPLETE' },
) =>
  api()
    .post(`/api/v1/driver/dispatches/${dispatchId}/release`)
    .auth(token, bearer)
    .send(body);
const activeOf = (dispatchId: string) =>
  prisma.deliveryAssignment.findFirst({
    where: { dispatchId, status: 'ACTIVE' },
  });
const dispatchRow = (id: string) =>
  prisma.dispatch.findUniqueOrThrow({ where: { id } });
beforeAll(async () => {
  // V1.10-C: accepting a quote opens a Dispatch, which needs ACTIVE credit policies.
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
  await user('sa', 'SUPER_ADMIN');
  for (const key of ['A', 'B'] as const) {
    const provider = await prisma.deliveryProvider.create({
      data: {
        name: `Proveedor ${key} ${run}`,
        code: `${PREFIX}${key}_${run}`,
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 10,
        maxVehicles: 10,
      },
    });
    providers[key] = provider.id;
    await prisma.providerMembership.create({
      data: {
        providerId: provider.id,
        userId: await user(`admin${key}`, 'PROVIDER_ADMIN'),
        role: 'OWNER',
      },
    });
  }
  const driver = async (key: string, providerKey: 'A' | 'B' = 'A') => {
    const userId = await user(key, 'DRIVER');
    const row = await prisma.driver.create({
      data: {
        providerId: providers[providerKey],
        userId,
        name: key,
        status: 'ACTIVE',
      },
    });
    drivers[key] = row.id;
  };
  // carlos, pedro and luis are real drivers of provider A; only the first two become independent.
  await driver('carlos');
  await driver('pedro');
  await driver('luis');
  await driver('bruno', 'B');
  // Fleet vehicles of provider A, used by the V1.8 path.
  for (const key of ['fleet1', 'fleet2']) {
    const row = await prisma.vehicle.create({
      data: {
        providerId: providers.A,
        identifier: `${key.toUpperCase()}-${run}`,
        type: 'MOTORCYCLE',
        status: 'ACTIVE',
      },
    });
    vehicles[key] = row.id;
  }
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
  t.A = await login(mail('adminA'));
  t.carlos = await login(mail('carlos'));
  t.pedro = await login(mail('pedro'));
  t.bruno = await login(mail('bruno'));
  const zone = await api()
    .post('/api/v1/admin/service-zones')
    .auth(t.sa, bearer)
    .send({
      code: `${PREFIX}ZONE_${run}`,
      name: `Zona ${run}`,
      currency: 'MXN',
      boundary: square(),
    })
    .expect(201);
  zoneId = zone.body.id;
  await api()
    .post(`/api/v1/admin/service-zones/${zoneId}/activate`)
    .auth(t.sa, bearer)
    .expect(200);
  const plan = await api()
    .post('/api/v1/admin/rate-plans')
    .auth(t.sa, bearer)
    .send({
      serviceZoneId: zoneId,
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
    .post(`/api/v1/admin/providers/${providers.A}/service-coverages`)
    .auth(t.sa, bearer)
    .send({ serviceZoneId: zoneId, serviceType: 'LOCAL_DELIVERY' })
    .expect(201);
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Independent client', code: `${PREFIX}CLIENT_${run}` })
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
  for (const who of ['carlos', 'pedro', 'bruno']) {
    await api()
      .post('/api/v1/admin/drivers/' + drivers[who] + '/independent')
      .auth(t.sa, bearer)
      .send({})
      .expect(200);
    const v = await api()
      .post('/api/v1/admin/drivers/' + drivers[who] + '/independent/vehicles')
      .auth(t.sa, bearer)
      .send({ identifier: who + '-' + run, type: 'MOTORCYCLE' })
      .expect(201);
    vehicles[who] = v.body.id;
  }
}, 180000);
afterAll(async () => {
  vi.useRealTimers();
  await app?.close();
  await prisma.$disconnect();
});

const takeKey = (
  who: string,
  id: string,
  key: string = randomUUID(),
  vehicle = vehicles[who],
) => take(t[who], id, vehicle).set('Idempotency-Key', key);
const releaseKey = (who: string, id: string, key: string = randomUUID()) =>
  release(t[who], id).set('Idempotency-Key', key);
const attempt = (
  who: string,
  id: string,
  operation: string,
  key: string,
  close = false,
) => {
  const path = `/api/v1/driver/dispatches/${id}/independent-attempt${close ? '/close' : ''}?operation=${operation}`;
  return (close ? api().post(path) : api().get(path))
    .auth(t[who], bearer)
    .set('Idempotency-Key', key);
};
const entries = (id: string) =>
  prisma.creditLedgerEntry.findMany({
    where: {
      referenceId: id,
      type: { in: ['SERVICE_AWARD', 'SERVICE_REFUND'] },
    },
    orderBy: { sequence: 'asc' },
  });
async function advance(who: string, id: string, phase: string) {
  const e = await prisma.deliveryExecution.findUniqueOrThrow({
    where: { dispatchId: id },
  });
  return api()
    .post(`/api/v1/driver/dispatches/${id}/execution-events`)
    .auth(t[who], bearer)
    .set('Idempotency-Key', randomUUID())
    .send({ assignmentId: e.assignmentId, expectedRevision: e.revision, phase })
    .expect(200);
}

describe('V1.19 independent durable attempts on PostgreSQL', () => {
  it('insufficient balance rolls back TAKE and its receipt; closure then rejects delayed replay', async () => {
    const d = await openDispatch(false),
      key = randomUUID();
    await takeKey('bruno', d.id, key)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INSUFFICIENT_CREDITS'));
    expect(await activeOf(d.id)).toBeNull();
    expect(await entries(d.id)).toHaveLength(0);
    expect(
      (await attempt('bruno', d.id, 'TAKE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    await attempt('bruno', d.id, 'TAKE', key, true).expect(200);
    await takeKey('bruno', d.id, key)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INDEPENDENT_ATTEMPT_CLOSED'));
  });
  it('unknown TAKE remains uncertain, closure fences delayed command and is immutable', async () => {
    const d = await openDispatch(),
      key = randomUUID();
    const before = await entries(d.id);
    expect(
      (await attempt('carlos', d.id, 'TAKE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    expect(await activeOf(d.id)).toBeNull();
    expect(
      (await attempt('carlos', d.id, 'TAKE', key, true).expect(200)).body.state,
    ).toBe('CLOSED_NO_EFFECTS');
    await takeKey('carlos', d.id, key.toUpperCase())
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('INDEPENDENT_ATTEMPT_CLOSED'));
    expect(await entries(d.id)).toEqual(before);
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "IndependentDispatchAttempt" SET state='APPLIED'`,
      ),
    ).rejects.toThrow('INDEPENDENT_ATTEMPT_IMMUTABLE');
  });
  it('same intent concurrent TAKE/replays debit once; original receipt survives restart and changed view', async () => {
    const d = await openDispatch(),
      key = randomUUID();
    const results = await Promise.all([
      takeKey('carlos', d.id.toUpperCase(), key.toUpperCase()),
      takeKey('carlos', d.id, key),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].body).toEqual(results[1].body);
    expect((await entries(d.id)).length).toBe(1);
    await takeKey('carlos', d.id, key, vehicles.pedro)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('IDEMPOTENCY_KEY_REUSED'));
    await app.close();
    app = await bootstrap();
    expect(
      (await attempt('carlos', d.id, 'TAKE', key).expect(200)).body.result,
    ).toEqual(results[0].body);
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import {PrismaClient} from '@prisma/client';const p=new PrismaClient({datasourceUrl:process.env.TEST_DATABASE_URL});const rows=await p.$queryRawUnsafe('SELECT state,response FROM "IndependentDispatchAttempt" WHERE key=$1::uuid',process.env.TEST_ATTEMPT_KEY);console.log(JSON.stringify(rows));await p.$disconnect();`,
      ],
      {
        env: { ...process.env, TEST_ATTEMPT_KEY: key },
        encoding: 'utf8',
        windowsHide: true,
      },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)[0]).toEqual({
      state: 'APPLIED',
      response: results[0].body,
    });
    expect(
      (await attempt('carlos', d.id, 'TAKE', key, true).expect(200)).body.state,
    ).toBe('APPLIED');
    const releaseId = randomUUID();
    const released = await releaseKey('carlos', d.id, releaseId).expect(200);
    await takeKey('pedro', d.id).expect(200);
    await api()
      .get(`/api/v1/driver/dispatches/${d.id}`)
      .auth(t.carlos, bearer)
      .expect(404);
    const historical = (await attempt('carlos', d.id, 'TAKE', key).expect(200))
      .body;
    expect(historical.result).toEqual(results[0].body);
    expect(
      (await attempt('carlos', d.id, 'RELEASE', releaseId).expect(200)).body
        .result,
    ).toEqual(released.body);
    expect(JSON.stringify(historical)).not.toContain('contact');
    expect(
      (await attempt('pedro', d.id, 'TAKE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    await releaseKey('pedro', d.id).expect(200);
  });
  it('RELEASE after expiry returns200, durable refund reference and stable original result', async () => {
    const d = await openDispatch(),
      key = randomUUID();
    const taken = await takeKey('carlos', d.id).expect(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 600000));
    let result;
    try {
      result = (await releaseKey('carlos', d.id, key).expect(200)).body;
    } finally {
      vi.useRealTimers();
    }
    expect(result.dispatchStatus).toBe('EXPIRED');
    expect(result.assignmentId).toBe(taken.body.assignmentId);
    await api()
      .get(`/api/v1/driver/dispatches/${d.id}`)
      .auth(t.carlos, bearer)
      .expect(404);
    expect(
      (await attempt('carlos', d.id, 'RELEASE', key).expect(200)).body.result,
    ).toEqual(result);
    expect((await releaseKey('carlos', d.id, key).expect(200)).body).toEqual(
      result,
    );
    const ledger = await entries(d.id);
    expect(ledger).toHaveLength(2);
    expect(ledger[1].reversesEntryId).toBe(ledger[0].id);
    expect(ledger[1].amount).toBe(-ledger[0].amount);
    expect(result.credits).toEqual({
      awardEntryId: ledger[0].id,
      refundEntryId: ledger[1].id,
      amount: ledger[1].amount,
    });
  });
  it('legacy no-key release also captures success before losing access', async () => {
    const d = await openDispatch();
    await take(t.carlos, d.id, vehicles.carlos).expect(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 600000));
    try {
      await release(t.carlos, d.id).expect(200);
    } finally {
      vi.useRealTimers();
    }
    expect((await dispatchRow(d.id)).status).toBe('EXPIRED');
    expect(await entries(d.id)).toHaveLength(2);
  });
  it('RELEASE closure fences delayed command without releasing assignment or refunding', async () => {
    const d = await openDispatch(),
      key = randomUUID();
    await takeKey('carlos', d.id).expect(200);
    expect(
      (await attempt('carlos', d.id, 'RELEASE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    expect(
      (await attempt('carlos', d.id, 'RELEASE', key, true).expect(200)).body
        .state,
    ).toBe('CLOSED_NO_EFFECTS');
    await releaseKey('carlos', d.id, key).expect(409);
    expect(await activeOf(d.id)).not.toBeNull();
    expect(await entries(d.id)).toHaveLength(1);
    await releaseKey('carlos', d.id).expect(200);
  });
  it.each(['TAKE', 'RELEASE'] as const)(
    'closure concurrent with %s has exactly one durable outcome',
    async (operation) => {
      const d = await openDispatch(),
        key = randomUUID();
      if (operation === 'RELEASE') await takeKey('carlos', d.id).expect(200);
      const [original, closed] = await Promise.all([
        operation === 'TAKE'
          ? takeKey('carlos', d.id, key)
          : releaseKey('carlos', d.id, key),
        attempt('carlos', d.id, operation, key, true),
      ]);
      expect(closed.status).toBe(200);
      const r = (await attempt('carlos', d.id, operation, key).expect(200))
        .body;
      if (r.state === 'APPLIED') {
        expect(original.status).toBe(200);
        expect(r.result).toEqual(original.body);
      } else {
        expect(r.state).toBe('CLOSED_NO_EFFECTS');
        expect(original.status).toBe(409);
      }
      expect(await entries(d.id)).toHaveLength(
        operation === 'TAKE'
          ? r.state === 'APPLIED'
            ? 1
            : 0
          : r.state === 'APPLIED'
            ? 2
            : 1,
      );
      if (await activeOf(d.id)) await releaseKey('carlos', d.id).expect(200);
    },
  );
  it('different actors competing TAKE produce a single award', async () => {
    const d = await openDispatch();
    const results = await Promise.all([
      takeKey('carlos', d.id),
      takeKey('pedro', d.id),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await entries(d.id)).toHaveLength(1);
    await releaseKey(
      results[0].status === 200 ? 'carlos' : 'pedro',
      d.id,
    ).expect(200);
  });
  it('busy driver/vehicle and foreign/inactive vehicle cannot award; failed receipt stays unknown until closed', async () => {
    const a = await openDispatch(),
      b = await openDispatch();
    await takeKey('carlos', a.id).expect(200);
    const key = randomUUID();
    await takeKey('carlos', b.id, key).expect(409);
    expect(await entries(b.id)).toHaveLength(0);
    expect(
      (await attempt('carlos', b.id, 'TAKE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    await attempt('carlos', b.id, 'TAKE', key, true).expect(200);
    await releaseKey('carlos', a.id).expect(200);
    await takeKey('carlos', b.id, key).expect(409);
    await takeKey('pedro', b.id, randomUUID(), vehicles.carlos).expect(404);
  });
  it('isolation by operation/resource/actor, no data oracle and role enforcement', async () => {
    const id = randomUUID(),
      key = randomUUID();
    await attempt('carlos', id, 'TAKE', key, true).expect(200);
    for (const [who, resource, op] of [
      ['pedro', id, 'TAKE'],
      ['carlos', randomUUID(), 'TAKE'],
      ['carlos', id, 'RELEASE'],
    ])
      expect(
        (await attempt(who, resource, op, key).expect(200)).body.state,
      ).toBe('PENDING_OR_UNKNOWN');
    await attempt('A', id, 'TAKE', key).expect(403);
    await attempt('sa', id, 'TAKE', key, true).expect(403);
    await api()
      .get(`/api/v1/driver/dispatches/${id}/independent-attempt?operation=TAKE`)
      .set('Idempotency-Key', key)
      .expect(401);
    await attempt('carlos', id, 'ADVANCE', key).expect(400);
    await attempt('carlos', id, 'TAKE', 'invalid').expect(400);
  });
  it('receipt persistence failure rolls back assignment and award; closing failed intent fences retry', async () => {
    const d = await openDispatch(),
      key = randomUUID();
    await prisma.$executeRawUnsafe(
      `CREATE FUNCTION test_fail_independent_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."dispatchId"='${d.id}'::uuid AND NEW.state='APPLIED' THEN RAISE EXCEPTION 'CONTROLLED_RECEIPT_FAILURE'; END IF; RETURN NEW; END $$`,
    );
    await prisma.$executeRawUnsafe(
      'CREATE TRIGGER test_fail_independent_receipt BEFORE INSERT ON "IndependentDispatchAttempt" FOR EACH ROW EXECUTE FUNCTION test_fail_independent_receipt()',
    );
    try {
      await takeKey('carlos', d.id, key)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('TAKE_CONFLICT'));
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER test_fail_independent_receipt ON "IndependentDispatchAttempt"',
      );
      await prisma.$executeRawUnsafe(
        'DROP FUNCTION test_fail_independent_receipt()',
      );
    }
    expect(await activeOf(d.id)).toBeNull();
    expect(await entries(d.id)).toHaveLength(0);
    expect((await dispatchRow(d.id)).status).toBe('OPEN');
    expect(
      (await attempt('carlos', d.id, 'TAKE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
    await attempt('carlos', d.id, 'TAKE', key, true).expect(200);
    await takeKey('carlos', d.id, key).expect(409);
  });
  it('keyed release does not authorize legacy; old unkeyed compatibility has no receipt', async () => {
    const config = app.get(ConfigService);
    config.set('DETAILED_EXECUTION_ENABLED', false);
    const d = await openDispatch();
    try {
      await take(t.carlos, d.id, vehicles.carlos).expect(200);
    } finally {
      config.set('DETAILED_EXECUTION_ENABLED', true);
    }
    expect(
      await prisma.deliveryExecution.findUnique({
        where: { dispatchId: d.id },
      }),
    ).toBeNull();
    const key = randomUUID();
    await releaseKey('carlos', d.id, key)
      .expect(409)
      .expect((r) =>
        expect(r.body.code).toBe('INDEPENDENT_RELEASE_LEGACY_UNSUPPORTED'),
      );
    await release(t.carlos, d.id).expect(200);
    expect(
      (await attempt('carlos', d.id, 'RELEASE', key).expect(200)).body.state,
    ).toBe('PENDING_OR_UNKNOWN');
  });
  it('custody and open incident reject keyed/old RELEASE without financial mutation', async () => {
    const d = await openDispatch();
    await takeKey('carlos', d.id).expect(200);
    await advance('carlos', d.id, 'TO_PICKUP');
    await advance('carlos', d.id, 'AT_PICKUP');
    await advance('carlos', d.id, 'PICKED_UP');
    const before = await entries(d.id);
    await releaseKey('carlos', d.id)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('CUSTODY_OPERATION_FORBIDDEN'));
    await release(t.carlos, d.id).expect(409);
    const e = await prisma.deliveryExecution.findUniqueOrThrow({
      where: { dispatchId: d.id },
    });
    await api()
      .post(`/api/v1/driver/dispatches/${d.id}/custody-incidents`)
      .auth(t.carlos, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.assignmentId,
        expectedRevision: e.revision,
        reasonCode: 'OTHER',
        reasonDetail: 'Incidencia sintética',
      })
      .expect(201);
    await releaseKey('carlos', d.id)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('CUSTODY_INCIDENT_OPEN'));
    await release(t.carlos, d.id).expect(409);
    expect(await entries(d.id)).toEqual(before);
  });
  it('active custody cannot be commercially suspended by existing DB guard; completion remains available', async () => {
    const d = await openDispatch();
    await takeKey('pedro', d.id).expect(200);
    await advance('pedro', d.id, 'TO_PICKUP');
    await advance('pedro', d.id, 'AT_PICKUP');
    await advance('pedro', d.id, 'PICKED_UP');
    const before = await entries(d.id);
    await expect(
      prisma.independentDriverProfile.update({
        where: { driverId: drivers.pedro },
        data: {
          status: 'SUSPENDED',
          suspendedAt: new Date(),
          reason: 'Synthetic test',
        },
      }),
    ).rejects.toThrow('INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT');
    await advance('pedro', d.id, 'TO_DROPOFF');
    await advance('pedro', d.id, 'AT_DROPOFF');
    const head = await prisma.deliveryExecution.findUniqueOrThrow({
      where: { dispatchId: d.id },
    });
    await api()
      .post(`/api/v1/driver/dispatches/${d.id}/execution-completion`)
      .auth(t.pedro, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: head.assignmentId,
        expectedRevision: head.revision,
      })
      .expect(200);
    expect(await entries(d.id)).toEqual(before);
    expect((await dispatchRow(d.id)).status).toBe('DELIVERED');
  });
  it('declared cash at pickup blocks RELEASE on server before physical custody; cash and ledger survive', async () => {
    const d = await openDispatch(true, true);
    await takeKey('bruno', d.id).expect(200);
    await advance('bruno', d.id, 'TO_PICKUP');
    await advance('bruno', d.id, 'AT_PICKUP');
    const dispatch = await prisma.dispatch.findUniqueOrThrow({
      where: { id: d.id },
      include: { deliveryQuote: true },
    });
    const terms = await prisma.deliveryShippingTerms.findUniqueOrThrow({
      where: { deliveryRequestId: dispatch.deliveryRequestId },
    });
    const e = await prisma.deliveryExecution.findUniqueOrThrow({
      where: { dispatchId: d.id },
    });
    await api()
      .post(`/api/v1/driver/dispatches/${d.id}/shipping-collection`)
      .auth(t.bruno, bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        assignmentId: e.assignmentId,
        expectedRevision: e.revision,
        quotePublicId: dispatch.deliveryQuote.publicId,
        termsHash: terms.termsHash,
        amount: dispatch.deliveryQuote.amount.toFixed(2),
        currency: 'MXN',
        receivedFrom: 'REQUESTER',
        occurredAt: new Date().toISOString(),
      })
      .expect(200);
    const before = await entries(d.id);
    await releaseKey('bruno', d.id)
      .expect(409)
      .expect((r) =>
        expect(r.body.code).toBe('SHIPPING_COLLECTION_REQUIRES_RESOLUTION'),
      );
    await release(t.bruno, d.id).expect(409);
    expect(await entries(d.id)).toEqual(before);
    expect(
      await prisma.shippingCollectionDeclaration.count({
        where: { dispatchId: d.id },
      }),
    ).toBe(1);
    expect(await activeOf(d.id)).not.toBeNull();
  });
});
