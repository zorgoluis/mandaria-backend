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
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('A dedicated TEST_DATABASE_URL ending in _test is required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_ACCESS_TOKEN_EXPIRES_IN = '3600';
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const jwt = new JwtService();
const adminId = randomUUID();
const driverId = randomUUID();
const clients: string[] = [];
const secrets: string[] = [];
const logs: string[] = [];
const capture = (...messages: unknown[]) => {
  logs.push(JSON.stringify(messages));
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
let adminToken: string;
let driverToken: string;
type Credentials = {
  clientId: string;
  clientSecret: string;
  integrationId: string;
};

beforeAll(async () => {
  await prisma.user.createMany({
    data: [
      {
        id: adminId,
        email: `${adminId}@b2b.test`,
        passwordHash: 'not-a-login-fixture',
        role: 'SUPER_ADMIN',
      },
      {
        id: driverId,
        email: `${driverId}@b2b.test`,
        passwordHash: 'not-a-login-fixture',
        role: 'DRIVER',
      },
    ],
  });
  const sign = (id: string) =>
    jwt.signAsync(
      { sub: id, type: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        issuer: 'mandaria',
        audience: 'mandaria-users',
        expiresIn: 3600,
        algorithm: 'HS256',
      },
    );
  adminToken = await sign(adminId);
  driverToken = await sign(driverId);
});
beforeEach(async () => {
  // Fresh limiter per case, including a dedicated real 429 test.
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, { logger, bodyParser: false });
  setup(app);
  await app.init();
});
afterEach(async () => {
  await app?.close();
});
afterAll(async () => {
  await prisma.integrationClient.deleteMany({ where: { id: { in: clients } } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, driverId] } } });
  await prisma.$disconnect();
});

async function create(
  scopes: string[] = ['deliveries:read'],
  expiresAt?: string,
) {
  const client = await request(app.getHttpServer())
    .post('/api/v1/admin/integrations')
    .auth(adminToken, { type: 'bearer' })
    .send({
      name: 'B2B E2E',
      code: `TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`,
    })
    .expect(201);
  clients.push(client.body.id);
  const credential = await request(app.getHttpServer())
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(adminToken, { type: 'bearer' })
    .send({ scopes, ...(expiresAt ? { expiresAt } : {}) })
    .expect(201);
  secrets.push(credential.body.clientSecret);
  expect(Object.keys(credential.body).sort()).toEqual([
    'clientId',
    'clientSecret',
    'integrationId',
  ]);
  expect(credential.headers['cache-control']).toBe('no-store');
  return credential.body as Credentials;
}
async function exchange(c: Credentials, status = 200) {
  return request(app.getHttpServer())
    .post('/api/v1/integrations/token')
    .send({ clientId: c.clientId, clientSecret: c.clientSecret })
    .expect(status);
}
async function me(token: string, status = 200) {
  return request(app.getHttpServer())
    .get('/api/v1/integrations/me')
    .auth(token, { type: 'bearer' })
    .expect(status);
}
async function state(c: Credentials, status: string) {
  await request(app.getHttpServer())
    .patch(`/api/v1/admin/integrations/${c.integrationId}`)
    .auth(adminToken, { type: 'bearer' })
    .send({ status })
    .expect(204);
}

describe('B2B Client Credentials with real PostgreSQL', () => {
  it('preserves legacy administrative aliases and maps INACTIVE to SUSPENDED', async () => {
    const client = await request(app.getHttpServer())
      .post('/api/v1/integrations')
      .auth(adminToken, { type: 'bearer' })
      .send({
        name: 'Legacy administrative caller',
        code: `TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`,
      })
      .expect(201);
    clients.push(client.body.id);
    const credential = await request(app.getHttpServer())
      .post(`/api/v1/integrations/${client.body.id}/credentials`)
      .auth(adminToken, { type: 'bearer' })
      .expect(201);
    secrets.push(credential.body.clientSecret);
    const list = await request(app.getHttpServer())
      .get('/api/v1/integrations')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(
      list.body.find((c: { id: string }) => c.id === client.body.id)
        .credentials,
    ).toHaveLength(1);
    await request(app.getHttpServer())
      .patch(`/api/v1/integrations/${client.body.id}`)
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'INACTIVE' })
      .expect(204);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/admin/integrations/${client.body.id}`)
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    expect(detail.body.status).toBe('SUSPENDED');
    await request(app.getHttpServer())
      .delete(
        `/api/v1/integrations/${client.body.id}/credentials/${credential.body.clientId}`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
  });
  it('issues a bounded token with identity, credential and scopes; persists only hash and lastUsedAt', async () => {
    const c = await create();
    const token = await exchange(c);
    expect(Object.keys(token.body).sort()).toEqual([
      'accessToken',
      'expiresIn',
      'tokenType',
    ]);
    expect(token.body.expiresIn).toBe(3600);
    const payload = jwt.decode(token.body.accessToken);
    expect(payload).toMatchObject({
      sub: c.integrationId,
      credentialId: c.clientId,
      principalType: 'integration',
      scopes: ['deliveries:read'],
    });
    expect(payload.exp - payload.iat).toBe(3600);
    const result = await me(token.body.accessToken);
    expect(result.body.id).toBe(c.integrationId);
    expect(JSON.stringify(result.body).includes('secretHash')).toBe(false);
    const stored = await prisma.integrationCredential.findUniqueOrThrow({
      where: { id: c.clientId },
    });
    expect(stored.secretHash.length).toBe(64);
    expect(stored.secretHash === c.clientSecret).toBe(false);
    expect(stored.lastUsedAt).not.toBeNull();
  });
  it('uses identical generic errors for unknown IDs, bad secrets, revoked credentials and suspended clients', async () => {
    const c = await create();
    const results = [
      await exchange({ ...c, clientId: randomUUID() }, 401),
      await exchange(
        { ...c, clientSecret: randomBytes(32).toString('base64url') },
        401,
      ),
    ];
    await state(c, 'SUSPENDED');
    results.push(await exchange(c, 401));
    await state(c, 'ACTIVE');
    await request(app.getHttpServer())
      .post(
        `/api/v1/admin/integrations/${c.integrationId}/credentials/${c.clientId}/revoke`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    results.push(await exchange(c, 401));
    expect(new Set(results.map((r) => r.body.message)).size).toBe(1);
    expect(results.every((r) => r.body.code === 'HTTP_401')).toBe(true);
  });
  it('rejects expired tokens and tokens with wrong audience, key or principal type', async () => {
    const c = await create();
    const claims = {
      sub: c.integrationId,
      credentialId: c.clientId,
      scopes: ['deliveries:read'],
      principalType: 'integration',
      type: 'integration_access',
    };
    const options = {
      secret: process.env.INTEGRATION_JWT_SECRET,
      issuer: 'mandaria',
      audience: 'mandaria-integrations',
      expiresIn: 60,
      algorithm: 'HS256' as const,
    };
    await me(await jwt.signAsync(claims, { ...options, expiresIn: -1 }), 401);
    await me(
      await jwt.signAsync(claims, { ...options, audience: 'mandaria-users' }),
      401,
    );
    await me(
      await jwt.signAsync(claims, {
        ...options,
        secret: process.env.JWT_ACCESS_SECRET,
      }),
      401,
    );
    await me(
      await jwt.signAsync({ ...claims, principalType: 'user' }, options),
      401,
    );
  });
  it('strictly separates human and integration authorization', async () => {
    const c = await create();
    const token = (await exchange(c)).body.accessToken;
    await me(adminToken, 401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .auth(token, { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .auth(token, { type: 'bearer' })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/admin/integrations')
      .auth(driverToken, { type: 'bearer' })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/admin/integrations')
      .auth(driverToken, { type: 'bearer' })
      .send({ name: 'forbidden', code: 'FORBIDDEN' })
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/integrations')
      .auth(adminToken, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/integrations/me')
      .set('x-api-key', `${c.clientId}.${c.clientSecret}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });
  it('lists safe credential metadata and has no secret recovery endpoint', async () => {
    const c = await create();
    for (const path of [
      '/api/v1/admin/integrations',
      `/api/v1/admin/integrations/${c.integrationId}`,
      `/api/v1/admin/integrations/${c.integrationId}/credentials`,
    ]) {
      const result = await request(app.getHttpServer())
        .get(path)
        .auth(adminToken, { type: 'bearer' })
        .expect(200);
      const json = JSON.stringify(result.body);
      expect(json.includes('secretHash')).toBe(false);
      expect(json.includes('clientSecret')).toBe(false);
      expect(json.includes(c.clientSecret)).toBe(false);
    }
    await request(app.getHttpServer())
      .get(
        `/api/v1/admin/integrations/${c.integrationId}/credentials/${c.clientId}/secret`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(404);
  });
  it('suspends already-issued tokens immediately and permits reactivation', async () => {
    const c = await create();
    const token = (await exchange(c)).body.accessToken;
    await state(c, 'SUSPENDED');
    await me(token, 401);
    await exchange(c, 401);
    await state(c, 'ACTIVE');
    await me(token);
    await exchange(c);
  });
  it('rotates with overlap; revocation rejects both old credentials and old tokens', async () => {
    const a = await create();
    const tokenA = (await exchange(a)).body.accessToken;
    const rotated = await request(app.getHttpServer())
      .post(
        `/api/v1/admin/integrations/${a.integrationId}/credentials/${a.clientId}/rotate`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(201);
    const b = rotated.body as Credentials;
    secrets.push(b.clientSecret);
    expect(b.clientId !== a.clientId).toBe(true);
    expect(b.clientSecret !== a.clientSecret).toBe(true);
    const tokenB = (await exchange(b)).body.accessToken;
    await me(tokenA);
    await me(tokenB);
    await request(app.getHttpServer())
      .post(
        `/api/v1/admin/integrations/${a.integrationId}/credentials/${a.clientId}/revoke`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(204);
    await exchange(a, 401);
    await me(tokenA, 401);
    await me(tokenB);
    await request(app.getHttpServer())
      .post(
        `/api/v1/admin/integrations/${a.integrationId}/credentials/${a.clientId}/rotate`,
      )
      .auth(adminToken, { type: 'bearer' })
      .expect(409);
  });
  it('makes integration revocation terminal and denies all tokens and issuance', async () => {
    const c = await create();
    const token = (await exchange(c)).body.accessToken;
    await state(c, 'REVOKED');
    await me(token, 401);
    await exchange(c, 401);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/integrations/${c.integrationId}`)
      .auth(adminToken, { type: 'bearer' })
      .send({ status: 'ACTIVE' })
      .expect(409);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/${c.integrationId}/credentials`)
      .auth(adminToken, { type: 'bearer' })
      .send({})
      .expect(409);
  });
  it('rejects expired credentials for token issuance and previously emitted tokens', async () => {
    const c = await create([], new Date(Date.now() + 60000).toISOString());
    const result = await exchange(c);
    expect(result.body.expiresIn).toBeLessThanOrEqual(60);
    await prisma.integrationCredential.update({
      where: { id: c.clientId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await exchange(c, 401);
    await me(result.body.accessToken, 401);
  });
  it('enforces scopes and rejects unsupported scopes or past expiration', async () => {
    const allowed = await create(['deliveries:read']);
    const denied = await create([]);
    await request(app.getHttpServer())
      .get('/api/v1/integrations/scope-check')
      .auth((await exchange(allowed)).body.accessToken, { type: 'bearer' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/integrations/scope-check')
      .auth((await exchange(denied)).body.accessToken, { type: 'bearer' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/${allowed.integrationId}/credentials`)
      .auth(adminToken, { type: 'bearer' })
      .send({ scopes: ['admin:*'] })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/integrations/${allowed.integrationId}/credentials`)
      .auth(adminToken, { type: 'bearer' })
      .send({ expiresAt: '2000-01-01T00:00:00Z' })
      .expect(400);
  });
  it('binds credential mutations to their owning integration', async () => {
    const a = await create();
    const b = await create();
    for (const action of ['rotate', 'revoke']) {
      await request(app.getHttpServer())
        .post(
          `/api/v1/admin/integrations/${a.integrationId}/credentials/${b.clientId}/${action}`,
        )
        .auth(adminToken, { type: 'bearer' })
        .expect(404);
    }
    await exchange(b);
  });
  it('throttles token exchange and does not disclose secrets in errors', async () => {
    const c = await create();
    const wrong = { ...c, clientSecret: randomBytes(32).toString('base64url') };
    for (let i = 0; i < 10; i++) await exchange(wrong, 401);
    const result = await exchange(wrong, 429);
    expect(JSON.stringify(result.body).includes(wrong.clientSecret)).toBe(
      false,
    );
  });
  it('documents separate schemes and never logs generated secrets', async () => {
    const c = await create();
    await exchange(c);
    const docs = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(docs.body.components.securitySchemes.bearer.scheme).toBe('bearer');
    expect(
      docs.body.components.securitySchemes['integration-bearer'].scheme,
    ).toBe('bearer');
    expect(
      docs.body.paths['/api/v1/integrations/token'].post.responses['200'],
    ).toBeDefined();
    const allLogs = logs.join('\n');
    expect(secrets.some((secret) => allLogs.includes(secret))).toBe(false);
    for (const event of [
      'INTEGRATION_CREATED',
      'CREDENTIAL_CREATED',
      'CREDENTIAL_ROTATED',
      'CREDENTIAL_REVOKED',
      'INTEGRATION_AUTH_SUCCESS',
      'INTEGRATION_AUTH_FAILED',
      'INTEGRATION_SUSPENDED',
      'INTEGRATION_ACTIVATED',
    ])
      expect(allLogs.includes(event)).toBe(true);
  });
});
