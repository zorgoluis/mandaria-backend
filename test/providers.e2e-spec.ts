import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, LoggerService } from '@nestjs/common';
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
process.env.DEFAULT_FLEET_MAX_DRIVERS = '10';
process.env.DEFAULT_FLEET_MAX_VEHICLES = '10';
process.env.DEFAULT_INDEPENDENT_MAX_DRIVERS = '1';
process.env.DEFAULT_INDEPENDENT_MAX_VEHICLES = '2';
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const adminId = randomUUID(),
  userA = randomUUID(),
  userB = randomUUID(),
  driverId = randomUUID();
const password = randomBytes(24).toString('base64url');
const providerIds: string[] = [],
  integrationIds: string[] = [],
  secrets: string[] = [password],
  logs: string[] = [];
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
let app: INestApplication;
let adminToken: string, tokenA: string;
const email = (id: string) => `${id}@providers.test`;
const api = () => request(app.getHttpServer());
const adminPath = '/api/v1/admin/providers';
beforeAll(async () => {
  const passwordHash = await argon2.hash(password);
  await prisma.user.createMany({
    data: [
      { id: adminId, email: email(adminId), passwordHash, role: 'SUPER_ADMIN' },
      { id: userA, email: email(userA), passwordHash, role: 'PROVIDER_ADMIN' },
      { id: userB, email: email(userB), passwordHash, role: 'PROVIDER_ADMIN' },
      { id: driverId, email: email(driverId), passwordHash, role: 'DRIVER' },
    ],
  });
});
beforeEach(async () => {
  await prisma.user.updateMany({
    where: { id: { in: [userA, userB] } },
    data: { active: true, role: 'PROVIDER_ADMIN' },
  });
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, { logger, bodyParser: false });
  setup(app);
  await app.init();
  adminToken = await login(adminId);
  tokenA = await login(userA);
});
afterEach(async () => {
  await app?.close();
});
afterAll(async () => {
  await prisma.providerMembership.deleteMany({
    where: { providerId: { in: providerIds } },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrationIds } },
  });
  await prisma.user.deleteMany({
    where: { id: { in: [adminId, userA, userB, driverId] } },
  });
  await prisma.$disconnect();
});
async function login(id: string) {
  return (
    await api()
      .post('/api/v1/auth/login')
      .send({ email: email(id), password })
      .expect(200)
  ).body.accessToken as string;
}
async function create(data: Record<string, unknown> = {}) {
  const response = await api()
    .post(adminPath)
    .auth(adminToken, { type: 'bearer' })
    .send({
      name: 'Provider fixture',
      code: `TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`,
      type: 'FLEET',
      ...data,
    })
    .expect(201);
  providerIds.push(response.body.id);
  return response.body;
}
async function add(providerId: string, userId = userA, role = 'ADMIN') {
  return (
    await api()
      .post(`${adminPath}/${providerId}/members`)
      .auth(adminToken, { type: 'bearer' })
      .send({ userId, role })
      .expect(201)
  ).body;
}
async function integrationToken() {
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(adminToken, { type: 'bearer' })
    .send({
      name: 'Provider isolation test',
      code: `TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    })
    .expect(201);
  integrationIds.push(client.body.id);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(adminToken, { type: 'bearer' })
    .send({ scopes: ['deliveries:read'] })
    .expect(201);
  secrets.push(credential.body.clientSecret);
  const response = await api()
    .post('/api/v1/integrations/token')
    .send({
      clientId: credential.body.clientId,
      clientSecret: credential.body.clientSecret,
    })
    .expect(200);
  return response.body.accessToken as string;
}

describe('Delivery providers with real PostgreSQL', () => {
  it('creates FLEET and INDEPENDENT in PENDING with configured defaults', async () => {
    const fleet = await create();
    expect(fleet).toMatchObject({
      type: 'FLEET',
      status: 'PENDING',
      maxDrivers: 10,
      maxVehicles: 10,
    });
    const independent = await create({ type: 'INDEPENDENT' });
    expect(independent).toMatchObject({
      type: 'INDEPENDENT',
      status: 'PENDING',
      maxDrivers: 1,
      maxVehicles: 2,
    });
    expect(fleet.id).not.toBe(independent.id);
  });
  it('normalizes code and name, supports custom limits and rejects duplicate code', async () => {
    const code = `NORMAL_${randomUUID().replaceAll('-', '')}`;
    const created = await create({
      name: '  Rápidos de Coita  ',
      code: ` ${code.toLowerCase()} `,
      maxDrivers: 23,
      maxVehicles: 30,
    });
    expect(created).toMatchObject({
      name: 'Rápidos de Coita',
      code: code.toUpperCase(),
      maxDrivers: 23,
      maxVehicles: 30,
    });
    await api()
      .post(adminPath)
      .auth(adminToken, { type: 'bearer' })
      .send({ name: 'Duplicate', code, type: 'FLEET' })
      .expect(409);
    const partial = await create({ type: 'INDEPENDENT', maxDrivers: 5 });
    expect(partial.maxVehicles).toBe(2);
  });
  it('rejects invalid fields, limits, enum values and unknown keys', async () => {
    for (const body of [
      { name: '' },
      { name: '   ' },
      { code: 'bad code' },
      { type: 'OTHER' },
      { maxDrivers: 0 },
      { maxVehicles: -1 },
      { maxVehicles: 10001 },
      { maxDrivers: 1.5 },
      { maxDrivers: '2' },
      { maxDrivers: null },
      { name: null },
      { status: 'ACTIVE' },
      { integrationClientId: randomUUID() },
    ]) {
      await api()
        .post(adminPath)
        .auth(adminToken, { type: 'bearer' })
        .send({ name: 'Invalid', code: 'INVALID', type: 'FLEET', ...body })
        .expect(400);
    }
    await api()
      .post(adminPath)
      .auth(adminToken, { type: 'bearer' })
      .send({})
      .expect(400);
    await api()
      .get(`${adminPath}/not-a-uuid`)
      .auth(adminToken, { type: 'bearer' })
      .expect(400);
    await api()
      .get(`${adminPath}/${randomUUID()}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
  });
  it('paginates deterministically and combines type, status and search filters', async () => {
    const marker = randomUUID();
    const a = await create({ name: `Search ${marker} Alpha` });
    await create({ name: `Search ${marker} Beta`, type: 'INDEPENDENT' });
    await api()
      .post(`${adminPath}/${a.id}/activate`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const first = await api()
      .get(adminPath)
      .query({ search: marker, page: 1, pageSize: 1 })
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const second = await api()
      .get(adminPath)
      .query({ search: marker, page: 2, pageSize: 1 })
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(first.body).toMatchObject({
      total: 2,
      totalPages: 2,
      page: 1,
      pageSize: 1,
    });
    expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
    const filtered = await api()
      .get(adminPath)
      .query({ search: marker.toUpperCase(), type: 'FLEET', status: 'ACTIVE' })
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(filtered.body.total).toBe(1);
    expect(filtered.body.items[0].id).toBe(a.id);
    for (const query of [
      { page: 0 },
      { pageSize: 101 },
      { page: 'bad' },
      { pageSize: 1.5 },
      { type: 'OTHER' },
      { status: 'INVALID' },
      { unknown: 'value' },
    ])
      await api()
        .get(adminPath)
        .query(query)
        .auth(adminToken, { type: 'bearer' })
        .expect(400);
  });
  it('updates limits and metadata while rejecting type and status changes through PATCH', async () => {
    const p = await create();
    const result = await api()
      .patch(`${adminPath}/${p.id}`)
      .auth(adminToken, { type: 'bearer' })
      .send({ name: 'Updated', maxDrivers: 8, maxVehicles: 9 })
      .expect(200);
    expect(result.body).toMatchObject({
      id: p.id,
      name: 'Updated',
      maxDrivers: 8,
      maxVehicles: 9,
      status: 'PENDING',
      type: 'FLEET',
    });
    for (const body of [
      {},
      { status: 'ACTIVE' },
      { type: 'INDEPENDENT' },
      { maxDrivers: 0 },
      { maxVehicles: null },
    ])
      await api()
        .patch(`${adminPath}/${p.id}`)
        .auth(adminToken, { type: 'bearer' })
        .send(body)
        .expect(400);
    await api()
      .delete(`${adminPath}/${p.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
  });
  it('validates explicit transitions and preserves provider on suspension', async () => {
    const p = await create();
    await api()
      .post(`${adminPath}/${p.id}/suspend`)
      .auth(adminToken, { type: 'bearer' })
      .expect(409);
    await api()
      .post(`${adminPath}/${p.id}/activate`)
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'INVALID' })
      .expect(400);
    for (const action of [
      'activate',
      'activate',
      'suspend',
      'suspend',
      'activate',
    ]) {
      const result = await api()
        .post(`${adminPath}/${p.id}/${action}`)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      expect(result.body.status).toBe(
        action === 'activate' ? 'ACTIVE' : 'SUSPENDED',
      );
    }
    expect(await prisma.deliveryProvider.count({ where: { id: p.id } })).toBe(
      1,
    );
  });
  it('denies all administrative provider operations to PROVIDER_ADMIN and DRIVER', async () => {
    const p = await create();
    const driverToken = await login(driverId);
    for (const token of [tokenA, driverToken]) {
      await api().get(adminPath).auth(token, { type: 'bearer' }).expect(403);
      await api()
        .post(adminPath)
        .auth(token, { type: 'bearer' })
        .send({ name: 'Unauthorized', code: 'UNAUTHORIZED', type: 'FLEET' })
        .expect(403);
      await api()
        .patch(`${adminPath}/${p.id}`)
        .auth(token, { type: 'bearer' })
        .send({ maxDrivers: 100 })
        .expect(403);
      await api()
        .post(`${adminPath}/${p.id}/activate`)
        .auth(token, { type: 'bearer' })
        .expect(403);
      await api()
        .post(`${adminPath}/${p.id}/members`)
        .auth(token, { type: 'bearer' })
        .send({ userId: userA, role: 'OWNER' })
        .expect(403);
    }
    await api()
      .get('/api/v1/admin/integrations')
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
  });
  it('rejects integration access tokens from both provider surfaces', async () => {
    const token = await integrationToken();
    await api().get(adminPath).auth(token, { type: 'bearer' }).expect(401);
    await api()
      .get('/api/v1/provider/profile')
      .auth(token, { type: 'bearer' })
      .expect(401);
    await api()
      .get('/api/v1/provider/profiles')
      .auth(token, { type: 'bearer' })
      .expect(401);
    await api().get(adminPath).expect(401);
  });
  it('supports multiple administrators and rejects duplicated membership even concurrently', async () => {
    const p = await create();
    await add(p.id, userA, 'OWNER');
    await add(p.id, userB, 'ADMIN');
    const list = await api()
      .get(`${adminPath}/${p.id}/members`)
      .auth(adminToken, { type: 'bearer' })
      .query({ pageSize: 1 })
      .expect(200);
    expect(list.body).toMatchObject({ total: 2, totalPages: 2 });
    expect(JSON.stringify(list.body).includes('passwordHash')).toBe(false);
    expect(list.body.items[0].user.role).toBe('PROVIDER_ADMIN');
    await api()
      .post(`${adminPath}/${p.id}/members`)
      .auth(adminToken, { type: 'bearer' })
      .send({ userId: userA, role: 'ADMIN' })
      .expect(409);
    const other = await create();
    const simultaneous = await Promise.all(
      [1, 2].map(() =>
        api()
          .post(`${adminPath}/${other.id}/members`)
          .auth(adminToken, { type: 'bearer' })
          .send({ userId: userA, role: 'ADMIN' }),
      ),
    );
    expect(simultaneous.map((r) => r.status).sort()).toEqual([201, 409]);
  });
  it('requires an eligible existing user and keeps global role separate', async () => {
    const p = await create();
    for (const id of [adminId, driverId])
      await api()
        .post(`${adminPath}/${p.id}/members`)
        .auth(adminToken, { type: 'bearer' })
        .send({ userId: id, role: 'ADMIN' })
        .expect(409);
    await prisma.user.update({ where: { id: userB }, data: { active: false } });
    await api()
      .post(`${adminPath}/${p.id}/members`)
      .auth(adminToken, { type: 'bearer' })
      .send({ userId: userB, role: 'ADMIN' })
      .expect(409);
    await api()
      .post(`${adminPath}/${p.id}/members`)
      .auth(adminToken, { type: 'bearer' })
      .send({ userId: randomUUID(), role: 'ADMIN' })
      .expect(404);
    await api()
      .post(`${adminPath}/${p.id}/members`)
      .auth(adminToken, { type: 'bearer' })
      .send({ userId: userA, role: 'DRIVER' })
      .expect(400);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: driverId } })).role,
    ).toBe('DRIVER');
  });
  it('allows own profile and explicitly returns 403 for Provider A admin requesting Provider B', async () => {
    const a = await create(),
      b = await create();
    await add(a.id, userA);
    await add(b.id, userB);
    const result = await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: a.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(200);
    expect(result.body).toMatchObject({
      id: a.id,
      limits: { maxDrivers: 10, maxVehicles: 10 },
      membershipRole: 'ADMIN',
    });
    expect(Object.keys(result.body).sort()).toEqual([
      'code',
      'id',
      'limits',
      'membershipRole',
      'name',
      'status',
      'type',
    ]);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: b.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: randomUUID() })
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: 'invalid' })
      .auth(tokenA, { type: 'bearer' })
      .expect(400);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: a.id, userId: userB })
      .auth(tokenA, { type: 'bearer' })
      .expect(400);
    await api()
      .get(`${adminPath}/${b.id}`)
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
  });
  it('supports multi-provider selection without silently choosing a membership', async () => {
    // Isolate memberships for this case; remove only this suite user associations.
    await prisma.providerMembership.deleteMany({ where: { userId: userA } });
    await api()
      .get('/api/v1/provider/profile')
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
    const a = await create();
    await add(a.id);
    await api()
      .get('/api/v1/provider/profile')
      .auth(tokenA, { type: 'bearer' })
      .expect(200);
    const b = await create();
    await add(b.id);
    await api()
      .get('/api/v1/provider/profile')
      .auth(tokenA, { type: 'bearer' })
      .expect(409);
    const list = await api()
      .get('/api/v1/provider/profiles')
      .auth(tokenA, { type: 'bearer' })
      .expect(200);
    expect(list.body.total).toBe(2);
    expect(new Set(list.body.items.map((p: { id: string }) => p.id))).toEqual(
      new Set([a.id, b.id]),
    );
  });
  it('retiring a membership leaves User intact and invalidates access for the existing JWT', async () => {
    const a = await create(),
      b = await create();
    const membership = await add(a.id);
    await api()
      .delete(`${adminPath}/${b.id}/members/${membership.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: a.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(200);
    await api()
      .delete(`${adminPath}/${a.id}/members/${membership.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    expect(
      await prisma.user.count({
        where: { id: userA, active: true, role: 'PROVIDER_ADMIN' },
      }),
    ).toBe(1);
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: a.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
  });
  it('checks current global role/active state and allows read-only suspended profiles', async () => {
    const p = await create();
    await add(p.id);
    await api()
      .post(`${adminPath}/${p.id}/activate`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    await api()
      .post(`${adminPath}/${p.id}/suspend`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    const result = await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: p.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(200);
    expect(result.body.status).toBe('SUSPENDED');
    await prisma.user.update({
      where: { id: userA },
      data: { role: 'DRIVER' },
    });
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: p.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(403);
    await prisma.user.update({
      where: { id: userA },
      data: { role: 'PROVIDER_ADMIN', active: false },
    });
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: p.id })
      .auth(tokenA, { type: 'bearer' })
      .expect(401);
  });
  it('documents every provider operation, parameters, errors and human permissions without secrets', async () => {
    const docs = (await api().get('/docs-json').expect(200)).body;
    for (const [path, operations] of Object.entries(docs.paths) as [
      string,
      Record<
        string,
        {
          description: string;
          security: unknown[];
          responses: Record<string, unknown>;
        }
      >,
    ][]) {
      if (!path.includes('/providers') && !path.includes('/provider/'))
        continue;
      for (const operation of Object.values(operations)) {
        expect(operation.description.length).toBeGreaterThan(60);
        expect(operation.security).toEqual([{ bearer: [] }]);
        for (const status of ['400', '401', '403', '429'])
          expect(operation.responses[status]).toBeDefined();
      }
    }
    expect(
      docs.paths[`${adminPath}/{id}`].patch.responses['409'],
    ).toBeDefined();
    expect(
      docs.components.schemas.CreateProviderDto.properties.code.example,
    ).toBe('RAPIDOS_COITA');
    const allLogs = logs.join('\n');
    for (const event of [
      'PROVIDER_CREATED',
      'PROVIDER_UPDATED',
      'PROVIDER_ACTIVATED',
      'PROVIDER_SUSPENDED',
      'PROVIDER_MEMBER_ADDED',
      'PROVIDER_MEMBER_REMOVED',
      'PROVIDER_LIMITS_CHANGED',
    ])
      expect(allLogs.includes(event)).toBe(true);
    expect(secrets.some((secret) => allLogs.includes(secret))).toBe(false);
  });
});
