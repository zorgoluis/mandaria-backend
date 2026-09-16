import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase();
const PREFIX = 'E2E_PA_';
const password = randomBytes(24).toString('base64url');
const mail = (n: string) => `${n}-${run}@pricing-admin.test`.toLowerCase();
const users = {
  sa: randomUUID(),
  providerAdmin: randomUUID(),
  driver: randomUUID(),
};
const clients: string[] = [];
let app: INestApplication;
let sa: string, providerAdmin: string, driver: string, b2b: string;
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;
// This suite owns the area lon 30..31 / lat 0..1 so zone overlap checks never meet other suites.
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
const zoneBody = (suffix: string, boundary: object, extra = {}) => ({
  code: `${PREFIX}${suffix}_${run}`,
  name: `Zona ${suffix}`,
  currency: 'MXN',
  boundary,
  ...extra,
});
const bands = (amounts = ['35', '40', '50']) =>
  amounts.map((amount, i) => ({
    minDistanceMeters: i * 2000,
    maxDistanceMeters: (i + 1) * 2000,
    amount,
  }));
async function createZone(suffix: string, boundary: object) {
  return (
    await api()
      .post('/api/v1/admin/service-zones')
      .auth(sa, bearer)
      .send(zoneBody(suffix, boundary))
      .expect(201)
  ).body as { id: string; code: string };
}
async function draft(zoneId: string, extra: Record<string, unknown> = {}) {
  return (
    await api()
      .post('/api/v1/admin/rate-plans')
      .auth(sa, bearer)
      .send({
        serviceZoneId: zoneId,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 15,
        ...extra,
      })
      .expect(201)
  ).body as { id: string; version: number; status: string };
}

beforeAll(async () => {
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
  // Leftovers of an interrupted run must not block overlap checks.
  await prisma.serviceZone.updateMany({
    where: { code: { startsWith: PREFIX }, status: 'ACTIVE' },
    data: { status: 'INACTIVE' },
  });
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  setup(app);
  await app.init();
  const login = async (email: string) =>
    (
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).body.accessToken as string;
  sa = await login(mail('sa'));
  providerAdmin = await login(mail('pa'));
  driver = await login(mail('driver'));
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(sa, bearer)
    .send({ name: 'Pricing admin', code: `E2E_PAC_${run}` })
    .expect(201);
  clients.push(client.body.id);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(sa, bearer)
    .send({ scopes: ['quotes:create', 'quotes:read', 'quotes:accept'] })
    .expect(201);
  b2b = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
}, 60000);

afterAll(async () => {
  await app?.close();
  const zones = await prisma.serviceZone.findMany({
    where: { code: { endsWith: run } },
    select: { id: true },
  });
  const zoneIds = zones.map((z) => z.id);
  await prisma.rateBand.deleteMany({
    where: { ratePlan: { serviceZoneId: { in: zoneIds } } },
  });
  await prisma.ratePlan.deleteMany({
    where: { serviceZoneId: { in: zoneIds } },
  });
  await prisma.serviceZone.deleteMany({ where: { id: { in: zoneIds } } });
  await prisma.integrationClient.deleteMany({ where: { id: { in: clients } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

describe.sequential('V1.6 ServiceZones and RatePlans administration', () => {
  it('validates, creates, lists, renames and activates service zones with overlap protection', async () => {
    const path = '/api/v1/admin/service-zones';
    for (const body of [
      zoneBody('BAD1', { type: 'Point', coordinates: [30.5, 0.5] }),
      zoneBody('BAD2', {
        type: 'Polygon',
        coordinates: [
          [
            [30, 0],
            [31, 0],
            [31, 1],
            [30, 1],
          ],
        ],
      }),
      zoneBody('BAD3', {
        type: 'Polygon',
        coordinates: [
          [
            [30, 0],
            [31, 1],
            [31, 0],
            [30, 1],
            [30, 0],
          ],
        ],
      }),
      zoneBody('BAD4', square(30, 0, 31, 95)),
      zoneBody('BAD5', square(30, 0, 31, 1), { currency: 'XYZ' }),
      zoneBody('BAD6', square(30, 0, 31, 1), { code: 'bad code' }),
      zoneBody('BAD7', square(30, 0, 31, 1), { status: 'ACTIVE' }),
      { ...zoneBody('BAD8', square(30, 0, 31, 1)), boundary: undefined },
    ])
      await api().post(path).auth(sa, bearer).send(body).expect(400);
    const a = await createZone('A', square(30.0, 0.0, 30.2, 0.2));
    expect(a).toMatchObject({
      status: 'INACTIVE',
      currency: 'MXN',
      minLatitude: 0,
      maxLongitude: 30.2,
    });
    await api()
      .post(path)
      .auth(sa, bearer)
      .send(zoneBody('A', square(30.5, 0.5, 30.6, 0.6)))
      .expect(409);
    await api()
      .post(`${path}/${a.id}/activate`)
      .auth(sa, bearer)
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('ACTIVE'));
    await api().post(`${path}/${a.id}/activate`).auth(sa, bearer).expect(200);
    const overlapping = await createZone('OVER', square(30.1, 0.1, 30.3, 0.3));
    const touching = await createZone('TOUCH', square(30.2, 0.0, 30.4, 0.2));
    const nested = await createZone('NEST', square(30.05, 0.05, 30.1, 0.1));
    for (const zone of [overlapping, touching, nested])
      await api()
        .post(`${path}/${zone.id}/activate`)
        .auth(sa, bearer)
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('SERVICE_ZONE_OVERLAP'));
    const disjoint = await createZone('FAR', square(30.5, 0.5, 30.7, 0.7));
    await api()
      .post(`${path}/${disjoint.id}/activate`)
      .auth(sa, bearer)
      .expect(200);
    await api()
      .put(`${path}/${a.id}/boundary`)
      .auth(sa, bearer)
      .send({ boundary: square(30.0, 0.0, 30.25, 0.25) })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('SERVICE_ZONE_NOT_EDITABLE'));
    await api().post(`${path}/${a.id}/deactivate`).auth(sa, bearer).expect(200);
    const replaced = await api()
      .put(`${path}/${a.id}/boundary`)
      .auth(sa, bearer)
      .send({ boundary: square(30.0, 0.0, 30.15, 0.15) })
      .expect(200);
    expect(replaced.body.maxLongitude).toBe(30.15);
    await api().post(`${path}/${a.id}/activate`).auth(sa, bearer).expect(200);
    // The previously touching zone no longer touches the shrunken boundary.
    await api()
      .post(`${path}/${touching.id}/activate`)
      .auth(sa, bearer)
      .expect(200);
    await api()
      .patch(`${path}/${a.id}`)
      .auth(sa, bearer)
      .send({ name: 'Renombrada' })
      .expect(200);
    await api()
      .patch(`${path}/${a.id}`)
      .auth(sa, bearer)
      .send({ currency: 'USD', name: 'x' })
      .expect(400);
    const list = await api()
      .get(path)
      .query({ search: run, status: 'ACTIVE' })
      .auth(sa, bearer)
      .expect(200);
    expect(list.body.items.map((z: { id: string }) => z.id).sort()).toEqual(
      [a.id, disjoint.id, touching.id].sort(),
    );
    expect(list.body.items[0]).not.toHaveProperty('boundary');
    const detail = await api()
      .get(`${path}/${a.id}`)
      .auth(sa, bearer)
      .expect(200);
    expect(detail.body.boundary.type).toBe('Polygon');
    await api().get(`${path}/${randomUUID()}`).auth(sa, bearer).expect(404);
  });

  it('versions DRAFT plans, validates bands and TTL, and keeps ACTIVE/INACTIVE immutable', async () => {
    const zone = await createZone('PLAN', square(30.8, 0.8, 30.9, 0.9));
    const path = '/api/v1/admin/rate-plans';
    for (const body of [
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 0,
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: -5,
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 121,
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 10081,
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'FREIGHT',
        quoteValidityMinutes: 15,
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 15,
        calculationType: 'BASE_PLUS_DISTANCE',
      },
      {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 15,
        status: 'ACTIVE',
      },
    ])
      await api().post(path).auth(sa, bearer).send(body).expect(400);
    await api()
      .post(path)
      .auth(sa, bearer)
      .send({
        serviceZoneId: randomUUID(),
        serviceType: 'LOCAL_DELIVERY',
        quoteValidityMinutes: 15,
      })
      .expect(404);
    const v1 = await draft(zone.id, {
      bands: [
        { minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '35' },
        { minDistanceMeters: 3000, maxDistanceMeters: 4000, amount: 45 },
      ],
    });
    expect(v1).toMatchObject({
      version: 1,
      status: 'DRAFT',
      currency: 'MXN',
      calculationType: 'DISTANCE_BANDS',
    });
    const v2 = await draft(zone.id);
    expect(v2.version).toBe(2);
    const invalid = async (id: string, pattern: RegExp) => {
      const validation = await api()
        .post(`${path}/${id}/validate`)
        .auth(sa, bearer)
        .expect(200);
      expect(validation.body.valid).toBe(false);
      expect(validation.body.errors.join(' | ')).toMatch(pattern);
      await api()
        .post(`${path}/${id}/activate`)
        .auth(sa, bearer)
        .expect(422)
        .expect((r) => expect(r.body.code).toBe('RATE_PLAN_INVALID'));
    };
    await invalid(v1.id, /gap between 2000 and 3000/);
    const put = (id: string, list: object[]) =>
      api().put(`${path}/${id}/bands`).auth(sa, bearer).send({ bands: list });
    await put(v1.id, [
      { minDistanceMeters: 0, maxDistanceMeters: 2500, amount: '35' },
      { minDistanceMeters: 2000, maxDistanceMeters: 4000, amount: '40' },
    ]).expect(200);
    await invalid(v1.id, /overlap/);
    await put(v1.id, [
      { minDistanceMeters: 500, maxDistanceMeters: 2000, amount: '35' },
    ]).expect(200);
    await invalid(v1.id, /start at 0/);
    await put(v1.id, [
      {
        minDistanceMeters: 0,
        maxDistanceMeters: 2000,
        amount: '35',
        currency: 'USD',
      },
    ]).expect(200);
    await invalid(v1.id, /currency must be MXN/);
    await invalid(v2.id, /at least one band/);
    for (const list of [
      [{ minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '0' }],
      [{ minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '-1' }],
      [{ minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '1.005' }],
      [{ minDistanceMeters: 2000, maxDistanceMeters: 2000, amount: '5' }],
      [{ minDistanceMeters: 0, maxDistanceMeters: 1500.5, amount: '5' }],
      [
        { minDistanceMeters: 0, maxDistanceMeters: 1000, amount: '5' },
        { minDistanceMeters: 0, maxDistanceMeters: 2000, amount: '6' },
      ],
    ])
      await put(v1.id, list).expect(400);
    await put(v1.id, bands())
      .expect(200)
      .expect((r) =>
        expect(r.body.bands.map((b: { amount: string }) => b.amount)).toEqual([
          '35.00',
          '40.00',
          '50.00',
        ]),
      );
    await api()
      .patch(`${path}/${v1.id}`)
      .auth(sa, bearer)
      .send({ quoteValidityMinutes: 121 })
      .expect(400);
    await api()
      .patch(`${path}/${v1.id}`)
      .auth(sa, bearer)
      .send({ quoteValidityMinutes: 20 })
      .expect(200);
    await api()
      .post(`${path}/${v1.id}/validate`)
      .auth(sa, bearer)
      .expect(200)
      .expect((r) => expect(r.body).toMatchObject({ valid: true, errors: [] }));
    const active = await api()
      .post(`${path}/${v1.id}/activate`)
      .auth(sa, bearer)
      .expect(200);
    expect(active.body).toMatchObject({
      status: 'ACTIVE',
      activatedAt: expect.any(String),
      deactivatedAt: null,
    });
    await api().post(`${path}/${v1.id}/activate`).auth(sa, bearer).expect(200);
    await api()
      .patch(`${path}/${v1.id}`)
      .auth(sa, bearer)
      .send({ quoteValidityMinutes: 15 })
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('RATE_PLAN_NOT_EDITABLE'));
    await put(v1.id, bands(['1', '2', '3'])).expect(409);
    await api()
      .post(`${path}/${v2.id}/deactivate`)
      .auth(sa, bearer)
      .expect(409);

    const v3 = (
      await api().post(`${path}/${v1.id}/clone`).auth(sa, bearer).expect(201)
    ).body;
    expect(v3).toMatchObject({
      version: 3,
      status: 'DRAFT',
      quoteValidityMinutes: 20,
    });
    expect(v3.bands.map((b: { amount: string }) => b.amount)).toEqual([
      '35.00',
      '40.00',
      '50.00',
    ]);
    await put(v3.id, bands(['36', '41', '51'])).expect(200);
    await api().post(`${path}/${v3.id}/activate`).auth(sa, bearer).expect(200);
    const old = await api()
      .get(`${path}/${v1.id}`)
      .auth(sa, bearer)
      .expect(200);
    expect(old.body).toMatchObject({
      status: 'INACTIVE',
      deactivatedAt: expect.any(String),
    });
    expect(old.body.bands.map((b: { amount: string }) => b.amount)).toEqual([
      '35.00',
      '40.00',
      '50.00',
    ]);
    await api()
      .post(`${path}/${v1.id}/activate`)
      .auth(sa, bearer)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('RATE_PLAN_NOT_ACTIVATABLE'));
    await put(v1.id, bands()).expect(409);
    const history = await api()
      .get(path)
      .query({ serviceZoneId: zone.id })
      .auth(sa, bearer)
      .expect(200);
    expect(
      history.body.items.map(
        (p: { version: number; status: string }) => `${p.version}:${p.status}`,
      ),
    ).toEqual(['3:ACTIVE', '2:DRAFT', '1:INACTIVE']);
    const inactive = await api()
      .get(path)
      .query({ serviceZoneId: zone.id, status: 'INACTIVE' })
      .auth(sa, bearer)
      .expect(200);
    expect(inactive.body.total).toBe(1);
  });

  it('keeps exactly one ACTIVE plan and unique versions under concurrency, enforced in PostgreSQL', async () => {
    const zone = await createZone('CONC', square(30.3, 0.8, 30.4, 0.9));
    const path = '/api/v1/admin/rate-plans';
    const drafts = await Promise.all(
      Array.from({ length: 5 }, () =>
        api()
          .post(path)
          .auth(sa, bearer)
          .send({
            serviceZoneId: zone.id,
            serviceType: 'LOCAL_DELIVERY',
            quoteValidityMinutes: 15,
            bands: bands(),
          }),
      ),
    );
    expect(drafts.map((r) => r.status)).toEqual([201, 201, 201, 201, 201]);
    expect(drafts.map((r) => r.body.version).sort()).toEqual([1, 2, 3, 4, 5]);
    const activations = await Promise.all(
      drafts.map((d) =>
        api().post(`${path}/${d.body.id}/activate`).auth(sa, bearer),
      ),
    );
    expect(activations.every((r) => r.status === 200)).toBe(true);
    const states = await prisma.ratePlan.findMany({
      where: { serviceZoneId: zone.id },
      select: { status: true },
    });
    expect(states.filter((s) => s.status === 'ACTIVE')).toHaveLength(1);
    expect(states.filter((s) => s.status === 'INACTIVE')).toHaveLength(4);

    const activePlan = await prisma.ratePlan.findFirstOrThrow({
      where: { serviceZoneId: zone.id, status: 'ACTIVE' },
    });
    const inactivePlan = await prisma.ratePlan.findFirstOrThrow({
      where: { serviceZoneId: zone.id, status: 'INACTIVE' },
    });
    await expect(
      prisma.ratePlan.update({
        where: { id: inactivePlan.id },
        data: { quoteValidityMinutes: 30 },
      }),
    ).rejects.toThrow(/RATE_PLAN_IMMUTABLE/);
    await expect(
      prisma.ratePlan.update({
        where: { id: inactivePlan.id },
        data: { status: 'ACTIVE' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.rateBand.create({
        data: {
          ratePlanId: activePlan.id,
          minDistanceMeters: 6000,
          maxDistanceMeters: 8000,
          amount: '60',
          currency: 'MXN',
        },
      }),
    ).rejects.toThrow(/RATE_PLAN_IMMUTABLE/);
    const band = await prisma.rateBand.findFirstOrThrow({
      where: { ratePlanId: activePlan.id },
    });
    await expect(
      prisma.rateBand.update({ where: { id: band.id }, data: { amount: '1' } }),
    ).rejects.toThrow(/RATE_PLAN_IMMUTABLE/);
    const extra = await prisma.ratePlan.create({
      data: {
        serviceZoneId: zone.id,
        serviceType: 'LOCAL_DELIVERY',
        version: 99,
        quoteValidityMinutes: 15,
        currency: 'MXN',
      },
    });
    await expect(
      prisma.ratePlan.update({
        where: { id: extra.id },
        data: { status: 'ACTIVE', activatedAt: new Date() },
      }),
    ).rejects.toThrow();
    await api()
      .post(`${path}/${activePlan.id}/deactivate`)
      .auth(sa, bearer)
      .expect(200)
      .expect((r) => expect(r.body.status).toBe('INACTIVE'));
  });

  it('restricts zone, plan and quote administration to SUPER_ADMIN', async () => {
    const targets: [string, string, object?][] = [
      ['get', '/api/v1/admin/service-zones'],
      [
        'post',
        '/api/v1/admin/service-zones',
        zoneBody('X', square(30.95, 0.95, 30.99, 0.99)),
      ],
      ['get', '/api/v1/admin/rate-plans'],
      [
        'post',
        '/api/v1/admin/rate-plans',
        {
          serviceZoneId: randomUUID(),
          serviceType: 'LOCAL_DELIVERY',
          quoteValidityMinutes: 15,
        },
      ],
      ['get', '/api/v1/admin/delivery-quotes'],
    ];
    for (const [method, url, body] of targets) {
      for (const token of [providerAdmin, driver]) {
        const req = api()[method as 'get'](url).auth(token, bearer);
        expect((await (body ? req.send(body) : req)).status).toBe(403);
      }
      const req = api()[method as 'get'](url).auth(b2b, bearer);
      expect((await (body ? req.send(body) : req)).status).toBe(401);
    }
    expect(
      await prisma.serviceZone.count({ where: { code: `${PREFIX}X_${run}` } }),
    ).toBe(0);
  });
});
