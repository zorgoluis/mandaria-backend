import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import type { Prisma } from '@prisma/client';
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
process.env.MAIL_PROVIDER = 'local_outbox';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_CPOL_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@credit-policies.test`.toLowerCase();
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
const userIds: string[] = [];
const clientIds: string[] = [];
const t: Record<string, string> = {};
let providerId = '';
let app: INestApplication;
/**
 * The app listens on a real ephemeral port and every request targets its URL: supertest bound to
 * the server object opens and closes it per request, which breaks requests created before others
 * finish (ECONNREFUSED) and interleaved concurrent chains (ECONNRESET).
 */
let baseUrl = '';
const api = () => request(baseUrl);
const bearer = { type: 'bearer' } as const;
const BASE = '/api/v1/admin/credit-policies';

async function bootstrap() {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
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
/** A fresh app per block resets the in-memory throttler (100/min per IP). */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}
/**
 * The credit policy tables of the test database belong to this suite: policies are global per
 * serviceType + actorType, so every block starts from none. Removing them uses the documented
 * test-only switch, which only works in databases whose name ends in _test.
 */
async function purgePolicies() {
  await prisma.$transaction([
    prisma.$executeRawUnsafe(
      `SET LOCAL mandaria.ledger_purge = 'test-fixtures'`,
    ),
    // V1.10-C: frozen dispatch costs reference policies (RESTRICT), so they go first.
    prisma.dispatchCreditSnapshot.deleteMany({}),
    prisma.creditPolicyRange.deleteMany({}),
    prisma.creditPolicy.deleteMany({}),
  ]);
}
const perKm = (creditsPerKm = 1, minimumCredits = 3) => ({
  calculationType: 'PER_KM',
  creditsPerKm,
  minimumCredits,
});
const RANGES = [
  { minDistanceMeters: 0, maxDistanceMeters: 3000, credits: 3 },
  { minDistanceMeters: 3000, maxDistanceMeters: 5000, credits: 5 },
  { minDistanceMeters: 5000, maxDistanceMeters: 10000, credits: 8 },
  { minDistanceMeters: 10000, maxDistanceMeters: null, credits: 15 },
];
const create = (body: object, token = t.sa) =>
  api().post(BASE).auth(token, bearer).send(body);
const version = (id: string, body: object, token = t.sa) =>
  api().post(`${BASE}/${id}/versions`).auth(token, bearer).send(body);
const calc = (actorType: string, distanceMeters: unknown, token = t.sa) =>
  api()
    .get(`${BASE}/calculation`)
    .query({ serviceType: 'LOCAL_DELIVERY', actorType, distanceMeters })
    .auth(token, bearer);
const policiesOf = (actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER') =>
  prisma.creditPolicy.findMany({
    where: { serviceType: 'LOCAL_DELIVERY', actorType },
    include: { ranges: { orderBy: { position: 'asc' } } },
    orderBy: { version: 'asc' },
  });
/** Refused by PostgreSQL: returns the guard/constraint that said no, or ACCEPTED. */
async function refused(fn: () => Promise<unknown>) {
  try {
    await fn();
    return 'ACCEPTED';
  } catch (error) {
    const m = String((error as Error).message);
    return (
      /(CREDIT_POLICY_[A-Z_]+|CreditPolicy[A-Za-z_]*_(check|key)|Unique constraint|23514|23505)/.exec(
        m,
      )?.[0] ?? 'refused'
    );
  }
}

beforeAll(async () => {
  await purgePolicies();
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
  t.saId = await user('sa', 'SUPER_ADMIN');
  const provider = await prisma.deliveryProvider.create({
    data: {
      name: `CPOL ${run}`,
      code: `${PREFIX}${run}`,
      type: 'FLEET',
      status: 'ACTIVE',
      maxDrivers: 5,
      maxVehicles: 5,
    },
  });
  providerId = provider.id;
  await prisma.providerMembership.create({
    data: {
      providerId,
      userId: await user('admin', 'PROVIDER_ADMIN'),
      role: 'OWNER',
    },
  });
  await prisma.driver.create({
    data: {
      providerId,
      userId: await user('driver', 'DRIVER'),
      name: 'driver',
      status: 'ACTIVE',
    },
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
  t.driver = await login('driver');
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(t.sa, bearer)
    .send({ name: 'Credit policies client', code: `${PREFIX}CLIENT_${run}` })
    .expect(201);
  clientIds.push(client.body.id);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(t.sa, bearer)
    .send({ scopes: ['deliveries:read'] })
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
  await app.close();
}, 180000);

afterAll(async () => {
  await purgePolicies();
  // Leave the global baseline that the suites opening Dispatches rely on (V1.10-C).
  await ensureTestCreditPolicies(prisma);
  await prisma.driver.deleteMany({ where: { providerId } });
  await prisma.providerMembership.deleteMany({ where: { providerId } });
  await prisma.deliveryProvider.deleteMany({ where: { id: providerId } }); // empty account cascades
  await prisma.integrationCredential.deleteMany({
    where: { clientId: { in: clientIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: clientIds } },
  });
  await prisma.refreshToken.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
}, 120000);

describe.sequential('V1.10-B authorization and missing policies', () => {
  withApp();

  it('only SUPER_ADMIN reaches credit policies; providers, drivers and B2B never read the rules', async () => {
    const id = randomUUID();
    const routes = (token: string | undefined) => {
      const auth = (r: request.Test) => (token ? r.auth(token, bearer) : r);
      return [
        auth(api().get(BASE)),
        auth(api().get(`${BASE}/${id}`)),
        auth(
          api().get(`${BASE}/calculation`).query({
            serviceType: 'LOCAL_DELIVERY',
            actorType: 'PROVIDER',
            distanceMeters: 1,
          }),
        ),
        auth(
          api()
            .post(BASE)
            .send({
              serviceType: 'LOCAL_DELIVERY',
              actorType: 'PROVIDER',
              ...perKm(),
            }),
        ),
        auth(api().post(`${BASE}/${id}/versions`).send(perKm())),
      ];
    };
    for (const [token, status] of [
      [t.admin, 403],
      [t.driver, 403],
      [t.b2b, 401],
      [undefined, 401],
    ] as const)
      for (const r of routes(token))
        expect((await r).status, String(token ? 'token' : 'anonymous')).toBe(
          status,
        );
    expect(await prisma.creditPolicy.count()).toBe(0);
  });

  it('fails closed without an ACTIVE policy: CREDIT_POLICY_UNAVAILABLE, never 0 credits', async () => {
    for (const actor of ['PROVIDER', 'INDEPENDENT_DRIVER']) {
      const res = await calc(actor, 6240).expect(409);
      expect(res.body.code).toBe('CREDIT_POLICY_UNAVAILABLE');
    }
  });

  it('exposes no PATCH, PUT or DELETE for policies', async () => {
    const id = randomUUID();
    for (const r of [
      api().patch(`${BASE}/${id}`).auth(t.sa, bearer).send({ creditsPerKm: 5 }),
      api().put(`${BASE}/${id}`).auth(t.sa, bearer).send(perKm()),
      api().delete(`${BASE}/${id}`).auth(t.sa, bearer),
      api().delete(BASE).auth(t.sa, bearer),
    ])
      expect((await r).status).toBe(404);
  });
});

describe.sequential('V1.10-B create, validate and calculate', () => {
  withApp();
  let providerPolicy = '';

  it('creates version 1 ACTIVE, decided by the server, attributed to the SUPER_ADMIN', async () => {
    const res = await create({
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'PROVIDER',
      ...perKm(),
      reason: 'Lanzamiento',
    }).expect(201);
    providerPolicy = res.body.id;
    expect(res.body).toMatchObject({
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'PROVIDER',
      version: 1,
      status: 'ACTIVE',
      calculationType: 'PER_KM',
      creditsPerKm: 1,
      minimumCredits: 3,
      flatCredits: null,
      ranges: [],
      effectiveUntil: null,
      reason: 'Lanzamiento',
      createdByUserId: t.saId,
    });
    expect(Date.parse(res.body.effectiveFrom)).not.toBeNaN();
    expect(JSON.stringify(res.body)).not.toMatch(/currency|MXN/);
    const again = await create({
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'PROVIDER',
      ...perKm(9, 9),
    }).expect(409);
    expect(again.body.code).toBe('CREDIT_POLICY_EXISTS');
    expect(await policiesOf('PROVIDER')).toHaveLength(1);
  });

  it('never trusts version, status, author, dates or ids from the client', async () => {
    const base = {
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'INDEPENDENT_DRIVER',
      ...perKm(),
    };
    for (const forged of [
      { version: 7 },
      { status: 'INACTIVE' },
      { createdByUserId: randomUUID() },
      { effectiveFrom: '2020-01-01T00:00:00Z' },
      { effectiveUntil: '2030-01-01T00:00:00Z' },
      { id: randomUUID() },
      { actorType: 'DRIVER' },
      { serviceType: 'FREIGHT' },
      { calculationType: 'PER_MINUTE' },
    ])
      expect(
        (await create({ ...base, ...forged })).status,
        JSON.stringify(forged),
      ).toBe(400);
    expect(await policiesOf('INDEPENDENT_DRIVER')).toHaveLength(0);
  });

  it('rejects ambiguous or invalid economics instead of normalizing them', async () => {
    const base = {
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'INDEPENDENT_DRIVER',
    };
    const cases: object[] = [
      { ...perKm(), flatCredits: 50 },
      { ...perKm(), ranges: RANGES },
      { calculationType: 'PER_KM', creditsPerKm: 1 },
      { calculationType: 'PER_KM', creditsPerKm: 0, minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 1.5, minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: '1', minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 1_000_001, minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 2 ** 53, minimumCredits: 3 },
      { calculationType: 'FLAT', flatCredits: 0 },
      { calculationType: 'FLAT', flatCredits: 5, minimumCredits: 1 },
      { calculationType: 'FLAT', flatCredits: 5, ranges: RANGES },
      { calculationType: 'DISTANCE_RANGE' },
      { calculationType: 'DISTANCE_RANGE', ranges: [] },
      { calculationType: 'DISTANCE_RANGE', ranges: RANGES, creditsPerKm: 1 },
      {
        calculationType: 'DISTANCE_RANGE',
        ranges: [
          RANGES[0],
          { ...RANGES[1], minDistanceMeters: 2500 },
          RANGES[2],
          RANGES[3],
        ],
      },
      {
        calculationType: 'DISTANCE_RANGE',
        ranges: [RANGES[0], RANGES[2], RANGES[3]],
      },
      { calculationType: 'DISTANCE_RANGE', ranges: RANGES.slice(0, 3) },
      {
        calculationType: 'DISTANCE_RANGE',
        ranges: [{ ...RANGES[0], minDistanceMeters: 1 }, ...RANGES.slice(1)],
      },
      {
        calculationType: 'DISTANCE_RANGE',
        ranges: [{ minDistanceMeters: 0, credits: 3 }],
      },
      {
        calculationType: 'DISTANCE_RANGE',
        ranges: Array.from({ length: 51 }, (_, i) => ({
          minDistanceMeters: i,
          maxDistanceMeters: i === 50 ? null : i + 1,
          credits: 1,
        })),
      },
      { ...perKm(), reason: 'no' },
      { ...perKm(), reason: 'línea\ninyectada' },
    ];
    for (const body of cases) {
      const res = await create({ ...base, ...body });
      expect(res.status, JSON.stringify(body).slice(0, 120)).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    expect(await policiesOf('INDEPENDENT_DRIVER')).toHaveLength(0);
  });

  it('calculates from the canonical distance through the API: 1 credit/km, minimum 3', async () => {
    for (const [meters, credits] of [
      [0, 3],
      [1, 3],
      [999, 3],
      [1000, 3],
      [1001, 3],
      [6240, 7],
    ]) {
      const res = await calc('PROVIDER', meters).expect(200);
      expect(res.body, `${meters} m`).toMatchObject({
        policyId: providerPolicy,
        policyVersion: 1,
        credits,
      });
    }
    expect((await calc('PROVIDER', 6240).expect(200)).body).toMatchObject({
      calculationType: 'PER_KM',
      distanceMeters: 6240,
      distanceKm: '6.240',
      billableKm: 7,
      calculatedCredits: 7,
      minimumCredits: 3,
      minimumApplied: false,
    });
    // The other actor has no policy yet: independent of the provider one.
    expect((await calc('INDEPENDENT_DRIVER', 6240).expect(409)).body.code).toBe(
      'CREDIT_POLICY_UNAVAILABLE',
    );
  });

  it('rejects invalid distances and duplicated parameters', async () => {
    for (const bad of [
      '-1',
      '1.5',
      'abc',
      '1e20',
      '',
      ' 7',
      '2147483648',
      'NaN',
      'Infinity',
    ])
      expect((await calc('PROVIDER', bad)).status, JSON.stringify(bad)).toBe(
        400,
      );
    const duplicated = await api()
      .get(
        `${BASE}/calculation?serviceType=LOCAL_DELIVERY&actorType=PROVIDER&distanceMeters=1&distanceMeters=2`,
      )
      .auth(t.sa, bearer);
    expect(duplicated.status).toBe(400);
    const twoActors = await api()
      .get(
        `${BASE}/calculation?serviceType=LOCAL_DELIVERY&actorType=PROVIDER&actorType=INDEPENDENT_DRIVER&distanceMeters=1`,
      )
      .auth(t.sa, bearer);
    expect(twoActors.status).toBe(400);
    expect((await calc('DRIVER', 100)).status).toBe(400);
  });

  it('refuses a result above the per-service credit limit', async () => {
    const huge = await create({
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'INDEPENDENT_DRIVER',
      ...perKm(1_000_000, 0),
    }).expect(201);
    expect(
      (await calc('INDEPENDENT_DRIVER', 1000).expect(200)).body.credits,
    ).toBe(1_000_000);
    expect((await calc('INDEPENDENT_DRIVER', 1001).expect(422)).body.code).toBe(
      'CREDIT_COST_OUT_OF_RANGE',
    );
    await version(huge.body.id, perKm(1, 3)).expect(201);
  });

  it('returns the full configuration, ranges included, and 404/400 for unknown or malformed ids', async () => {
    const res = await api()
      .get(`${BASE}/${providerPolicy}`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(res.body.id).toBe(providerPolicy);
    await api().get(`${BASE}/${randomUUID()}`).auth(t.sa, bearer).expect(404);
    await api().get(`${BASE}/not-a-uuid`).auth(t.sa, bearer).expect(400);
  });
});

describe.sequential('V1.10-B versioning and history', () => {
  withApp();

  it('v1 -> v2 -> v3 -> v4 keeps every version, exactly one ACTIVE, contiguous effective dates', async () => {
    const [v1] = await policiesOf('PROVIDER');
    const snapshot = (p: Awaited<ReturnType<typeof policiesOf>>[number]) => ({
      id: p.id,
      version: p.version,
      calculationType: p.calculationType,
      creditsPerKm: p.creditsPerKm,
      minimumCredits: p.minimumCredits,
      flatCredits: p.flatCredits,
      ranges: p.ranges.map((r) => [
        r.position,
        r.minDistanceMeters,
        r.maxDistanceMeters,
        r.credits,
      ]),
      effectiveFrom: p.effectiveFrom.toISOString(),
      createdByUserId: p.createdByUserId,
      reason: p.reason,
    });
    const before = snapshot(v1);
    const v2 = await version(v1.id, {
      ...perKm(2, 3),
      reason: 'Sube la tarifa',
    }).expect(201);
    expect(v2.body).toMatchObject({
      version: 2,
      status: 'ACTIVE',
      creditsPerKm: 2,
      actorType: 'PROVIDER',
    });
    const v3 = await version(v2.body.id, {
      calculationType: 'FLAT',
      flatCredits: 5,
    }).expect(201);
    expect(v3.body).toMatchObject({
      version: 3,
      calculationType: 'FLAT',
      flatCredits: 5,
      creditsPerKm: null,
      minimumCredits: null,
    });
    const v4 = await version(v3.body.id, {
      calculationType: 'DISTANCE_RANGE',
      ranges: [...RANGES].reverse(),
    }).expect(201);
    expect(
      v4.body.ranges.map(
        (r: { position: number; minDistanceMeters: number }) => [
          r.position,
          r.minDistanceMeters,
        ],
      ),
    ).toEqual([
      [1, 0],
      [2, 3000],
      [3, 5000],
      [4, 10000],
    ]);
    const history = await policiesOf('PROVIDER');
    expect(history.map((p) => [p.version, p.status])).toEqual([
      [1, 'INACTIVE'],
      [2, 'INACTIVE'],
      [3, 'INACTIVE'],
      [4, 'ACTIVE'],
    ]);
    // The historical payload of v1 is untouched; only its status/effectiveUntil record the supersession.
    expect(snapshot(history[0])).toEqual(before);
    for (let i = 0; i < 3; i += 1)
      expect(history[i].effectiveUntil?.toISOString()).toBe(
        history[i + 1].effectiveFrom.toISOString(),
      );
    expect(history[3].effectiveUntil).toBeNull();
    const list = await api()
      .get(BASE)
      .query({ actorType: 'PROVIDER', pageSize: 100 })
      .auth(t.sa, bearer)
      .expect(200);
    expect(list.body.items.map((p: { version: number }) => p.version)).toEqual([
      4, 3, 2, 1,
    ]);
    const active = await api()
      .get(BASE)
      .query({ actorType: 'PROVIDER', status: 'ACTIVE' })
      .auth(t.sa, bearer)
      .expect(200);
    expect(active.body.total).toBe(1);
    const detail = await api()
      .get(`${BASE}/${history[0].id}`)
      .auth(t.sa, bearer)
      .expect(200);
    expect(detail.body).toMatchObject({
      version: 1,
      status: 'INACTIVE',
      creditsPerKm: 1,
      minimumCredits: 3,
    });
  });

  it('never versions from a superseded version; the ACTIVE one keeps working', async () => {
    const [v1, , , v4] = await policiesOf('PROVIDER');
    const stale = await version(v1.id, perKm(9, 9)).expect(409);
    expect(stale.body.code).toBe('CREDIT_POLICY_VERSION_CONFLICT');
    await version(randomUUID(), perKm()).expect(404);
    await version(v4.id, { ...perKm(), version: 9 }).expect(400);
    await version(v4.id, { ...perKm(), serviceType: 'LOCAL_DELIVERY' }).expect(
      400,
    );
    await version(v4.id, {
      ...perKm(),
      actorType: 'INDEPENDENT_DRIVER',
    }).expect(400);
    expect(await policiesOf('PROVIDER')).toHaveLength(4);
  });

  it('resolves the ACTIVE version: range boundaries through the API', async () => {
    for (const [meters, credits, position] of [
      [0, 3, 1],
      [2999, 3, 1],
      [3000, 5, 2],
      [3001, 5, 2],
      [5000, 8, 3],
      [5001, 8, 3],
      [10000, 15, 4],
      [2_147_483_647, 15, 4],
    ]) {
      const res = await calc('PROVIDER', meters).expect(200);
      expect(res.body, `${meters} m`).toMatchObject({
        policyVersion: 4,
        calculationType: 'DISTANCE_RANGE',
        credits,
        rangePosition: position,
      });
    }
  });
});

describe.sequential('V1.10-B concurrency', () => {
  withApp();

  it('10 simultaneous new versions from the same ACTIVE: 1 applies, 9 conflict, versions stay unique', async () => {
    const active = (await policiesOf('PROVIDER')).at(-1)!;
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => version(active.id, perKm(i + 1, 3))),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    const conflicts = results.filter((r) => r.status === 409);
    expect(conflicts).toHaveLength(9);
    for (const r of conflicts)
      expect(r.body.code).toBe('CREDIT_POLICY_VERSION_CONFLICT');
    const history = await policiesOf('PROVIDER');
    expect(history.map((p) => p.version)).toEqual([1, 2, 3, 4, 5]);
    expect(history.filter((p) => p.status === 'ACTIVE')).toHaveLength(1);
  });

  it('10 simultaneous chains of 3 versions each still produce contiguous versions and one ACTIVE', async () => {
    const chain = async () => {
      for (let step = 0; step < 3; step += 1) {
        const current = (
          await api()
            .get(BASE)
            .query({ actorType: 'PROVIDER', status: 'ACTIVE' })
            .auth(t.sa, bearer)
        ).body.items[0];
        await version(current.id, perKm(step + 1, 3));
      }
    };
    await Promise.all(Array.from({ length: 10 }, chain));
    const history = await policiesOf('PROVIDER');
    expect(history.map((p) => p.version)).toEqual(history.map((_, i) => i + 1));
    expect(history.filter((p) => p.status === 'ACTIVE')).toHaveLength(1);
  });

  it('simultaneous initial creations for a new combination: exactly one version 1', async () => {
    await purgeActor('INDEPENDENT_DRIVER');
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        create({
          serviceType: 'LOCAL_DELIVERY',
          actorType: 'INDEPENDENT_DRIVER',
          ...perKm(),
        }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    expect(
      (await policiesOf('INDEPENDENT_DRIVER')).map((p) => [
        p.version,
        p.status,
      ]),
    ).toEqual([[1, 'ACTIVE']]);
  });
});

async function purgeActor(actorType: 'PROVIDER' | 'INDEPENDENT_DRIVER') {
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

describe.sequential('V1.10-B database guarantees', () => {
  const baseRow = (
    over: object = {},
  ): Prisma.CreditPolicyUncheckedCreateInput => ({
    version: 0,
    serviceType: 'LOCAL_DELIVERY' as const,
    actorType: 'PROVIDER' as const,
    calculationType: 'PER_KM' as const,
    creditsPerKm: 1,
    minimumCredits: 3,
    effectiveFrom: new Date(),
    createdByUserId: t.saId,
    ...over,
  });

  it('refuses every invalid policy written directly in SQL', async () => {
    const history = await policiesOf('PROVIDER');
    const active = history.at(-1)!;
    const next = active.version + 1;
    const outcome: Record<string, string> = {
      'second ACTIVE': await refused(() =>
        prisma.creditPolicy.create({ data: baseRow({ version: next }) }),
      ),
      'duplicate version': await refused(() =>
        prisma.creditPolicy.create({
          data: baseRow({ version: active.version }),
        }),
      ),
      'version 0': await refused(() =>
        prisma.creditPolicy.create({
          data: baseRow({ version: 0, actorType: 'INDEPENDENT_DRIVER' }),
        }),
      ),
      'version -1': await refused(() =>
        prisma.creditPolicy.create({
          data: baseRow({ version: -1, actorType: 'INDEPENDENT_DRIVER' }),
        }),
      ),
      'skipped version': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({ data: baseRow({ version: next + 1 }) }),
        ]),
      ),
      'born INACTIVE': await refused(() =>
        prisma.creditPolicy.create({
          data: baseRow({
            version: next,
            status: 'INACTIVE',
            effectiveUntil: new Date(),
          }),
        }),
      ),
      // NULL rate on an ACTIVE row: only the explicit IS NOT NULL in the CHECK stops it.
      'PER_KM without rate': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { actorType: 'INDEPENDENT_DRIVER', status: 'ACTIVE' },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.$executeRawUnsafe(
            `INSERT INTO "CreditPolicy" (id,"serviceType","actorType",version,status,"calculationType","minimumCredits","effectiveFrom","createdByUserId")
             SELECT gen_random_uuid(),'LOCAL_DELIVERY','INDEPENDENT_DRIVER',max(version)+1,'ACTIVE','PER_KM',3,now(),'${t.saId}'
               FROM "CreditPolicy" WHERE "actorType" = 'INDEPENDENT_DRIVER'`,
          ),
        ]),
      ),
      'PER_KM with flatCredits': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({
            data: baseRow({ version: next, flatCredits: 50 }),
          }),
        ]),
      ),
      'FLAT with minimum': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({
            data: baseRow({
              version: next,
              calculationType: 'FLAT',
              creditsPerKm: null,
              flatCredits: 5,
            }),
          }),
        ]),
      ),
      'PER_KM rate 0': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({
            data: baseRow({ version: next, creditsPerKm: 0 }),
          }),
        ]),
      ),
      'credits above limit': await refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({
            data: baseRow({ version: next, creditsPerKm: 1_000_001 }),
          }),
        ]),
      ),
    };
    const rangePolicy = (
      ranges: {
        position: number;
        minDistanceMeters: number;
        maxDistanceMeters: number | null;
        credits: number;
      }[],
    ) =>
      refused(() =>
        prisma.$transaction([
          prisma.creditPolicy.updateMany({
            where: { id: active.id },
            data: { status: 'INACTIVE', effectiveUntil: new Date() },
          }),
          prisma.creditPolicy.create({
            data: baseRow({
              version: next,
              calculationType: 'DISTANCE_RANGE',
              creditsPerKm: null,
              minimumCredits: null,
              ranges: { create: ranges },
            }),
          }),
        ]),
      );
    outcome['DISTANCE_RANGE without ranges'] = await rangePolicy([]);
    outcome['overlapping ranges'] = await rangePolicy([
      {
        position: 1,
        minDistanceMeters: 0,
        maxDistanceMeters: 5000,
        credits: 3,
      },
      {
        position: 2,
        minDistanceMeters: 4000,
        maxDistanceMeters: null,
        credits: 5,
      },
    ]);
    outcome['gap between ranges'] = await rangePolicy([
      {
        position: 1,
        minDistanceMeters: 0,
        maxDistanceMeters: 5000,
        credits: 3,
      },
      {
        position: 2,
        minDistanceMeters: 7000,
        maxDistanceMeters: null,
        credits: 5,
      },
    ]);
    outcome['first range after 0'] = await rangePolicy([
      {
        position: 1,
        minDistanceMeters: 1,
        maxDistanceMeters: null,
        credits: 3,
      },
    ]);
    outcome['closed last range'] = await rangePolicy([
      {
        position: 1,
        minDistanceMeters: 0,
        maxDistanceMeters: 5000,
        credits: 3,
      },
    ]);
    outcome['range credits 0'] = await rangePolicy([
      {
        position: 1,
        minDistanceMeters: 0,
        maxDistanceMeters: null,
        credits: 0,
      },
    ]);
    outcome['range on a PER_KM policy'] = await refused(() =>
      prisma.creditPolicyRange.create({
        data: {
          creditPolicyId: history[0].id,
          position: 1,
          minDistanceMeters: 0,
          maxDistanceMeters: null,
          credits: 3,
        },
      }),
    );
    // v4 of the versioning block is the DISTANCE_RANGE one: a range appended later breaks the chain.
    const withRanges = history.find(
      (p) => p.calculationType === 'DISTANCE_RANGE',
    )!;
    outcome['range appended to an existing policy'] = await refused(() =>
      prisma.creditPolicyRange.create({
        data: {
          creditPolicyId: withRanges.id,
          position: withRanges.ranges.length + 1,
          minDistanceMeters: 20000,
          maxDistanceMeters: null,
          credits: 20,
        },
      }),
    );
    outcome['edit economics of a version'] = await refused(() =>
      prisma.creditPolicy.update({
        where: { id: history[0].id },
        data: { creditsPerKm: 5 },
      }),
    );
    outcome['edit economics of the ACTIVE version'] = await refused(() =>
      prisma.creditPolicy.update({
        where: { id: active.id },
        data: { minimumCredits: 0 },
      }),
    );
    outcome['reactivate an INACTIVE version'] = await refused(() =>
      prisma.$transaction([
        prisma.creditPolicy.updateMany({
          where: { id: active.id },
          data: { status: 'INACTIVE', effectiveUntil: new Date() },
        }),
        prisma.creditPolicy.update({
          where: { id: history[0].id },
          data: { status: 'ACTIVE', effectiveUntil: null },
        }),
      ]),
    );
    outcome['change author'] = await refused(() =>
      prisma.creditPolicy.update({
        where: { id: history[0].id },
        data: { createdByUserId: t.saId, reason: 'reescrita' },
      }),
    );
    outcome['edit a range'] = await refused(() =>
      prisma.creditPolicyRange.update({
        where: { id: withRanges.ranges[0].id },
        data: { credits: 99 },
      }),
    );
    outcome['delete a policy'] = await refused(() =>
      prisma.creditPolicy.delete({ where: { id: history[0].id } }),
    );
    outcome['delete a range'] = await refused(() =>
      prisma.creditPolicyRange.delete({
        where: { id: withRanges.ranges[0].id },
      }),
    );
    outcome['truncate policies'] = await refused(() =>
      prisma.$executeRawUnsafe(`TRUNCATE "CreditPolicy" CASCADE`),
    );
    outcome['delete with another switch value'] = await refused(() =>
      prisma.$transaction([
        prisma.$executeRawUnsafe(`SET LOCAL mandaria.ledger_purge = 'please'`),
        prisma.creditPolicy.delete({ where: { id: history[0].id } }),
      ]),
    );
    const accepted = Object.entries(outcome).filter(
      ([, v]) => v === 'ACCEPTED',
    );
    expect(accepted, JSON.stringify(outcome, null, 1)).toEqual([]);
    // Nothing changed.
    const after = await policiesOf('PROVIDER');
    expect(
      after.map((p) => [
        p.id,
        p.version,
        p.status,
        p.creditsPerKm,
        p.ranges.length,
      ]),
    ).toEqual(
      history.map((p) => [
        p.id,
        p.version,
        p.status,
        p.creditsPerKm,
        p.ranges.length,
      ]),
    );
  });
});

describe.sequential(
  'V1.10-B calculations never touch accounts or the ledger',
  () => {
    withApp();

    it('many calculations leave every balance and every ledger entry exactly as they were', async () => {
      const snapshot = async () => ({
        accounts: await prisma.creditAccount.findMany({
          select: { id: true, balance: true, updatedAt: true },
          orderBy: { id: 'asc' },
        }),
        entries: await prisma.creditLedgerEntry.count(),
        awards: await prisma.creditLedgerEntry.count({
          where: { type: { in: ['SERVICE_AWARD', 'SERVICE_REFUND'] } },
        }),
        maxSequence: (
          await prisma.creditLedgerEntry.aggregate({ _max: { sequence: true } })
        )._max.sequence,
      });
      const before = await snapshot();
      for (const meters of [0, 1, 999, 1001, 3000, 6240, 10000, 123456])
        for (const actor of ['PROVIDER', 'INDEPENDENT_DRIVER'])
          await calc(actor, meters).expect(200);
      expect(await snapshot()).toEqual(before);
    });
  },
);

describe('V1.10-B audit', () => {
  it('logs who created each version and its full configuration, without secrets', () => {
    const text = logs.join('\n');
    expect(text).toContain('CREDIT_POLICY_CREATED');
    expect(text).toContain('CREDIT_POLICY_VERSIONED');
    const line = logs.find((l) => l.includes('CREDIT_POLICY_VERSIONED'))!;
    for (const field of [
      'policyId',
      'version',
      'previousPolicyId',
      'previousVersion',
      'calculationType',
      'actorUserId',
      'effectiveFrom',
    ])
      expect(line).toContain(field);
    expect(line).toContain(t.saId);
    for (const secret of [
      password,
      t.sa,
      t.admin,
      t.driver,
      t.b2b,
      t.clientSecret,
    ])
      expect(text).not.toContain(secret);
  });
});
