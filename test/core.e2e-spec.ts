import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) {
  throw new Error(
    'TEST_DATABASE_URL must point to a dedicated database whose name ends in _test; apply migrations first',
  );
}
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.CORS_ORIGINS = 'http://localhost:5173';
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const suffix = randomUUID();
const adminEmail = `admin-${suffix}@example.test`;
const driverEmail = `driver-${suffix}@example.test`;
const password = randomBytes(24).toString('base64url');
let app: INestApplication;
let accessToken: string;
let refreshToken: string;

const bearer = () => `Bearer ${accessToken}`;

beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const passwordHash = await argon2.hash(password);
  await prisma.user.createMany({
    data: [
      { email: adminEmail, passwordHash, role: 'SUPER_ADMIN' },
      { email: driverEmail, passwordHash, role: 'DRIVER' },
    ],
  });
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  setup(app);
  await app.init();
}, 30000);

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [adminEmail, driverEmail] } },
  });
  await app?.close();
  await prisma.$disconnect();
});

describe.sequential('Core with real PostgreSQL', () => {
  it('health checks PostgreSQL; Swagger is available', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok', database: 'up' });
    const docs = await request(app.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(docs.body.paths['/api/v1/auth/login']).toBeDefined();
    await request(app.getHttpServer()).get('/docs/').expect(200);
  });
  it('denies unauthenticated and malformed requests', async () => {
    await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    const invalid = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password, injected: true })
      .expect(400);
    expect(invalid.body.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(invalid.body)).not.toContain(password);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'incorrect' })
      .expect(401);
  });
  it('logs in and exposes only public user data', async () => {
    const result = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password })
      .expect(200);
    accessToken = result.body.accessToken;
    refreshToken = result.body.refreshToken;
    const me = await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', bearer())
      .expect(200);
    expect(me.body.email).toBe(adminEmail);
    expect(me.body.passwordHash).toBeUndefined();
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', bearer())
      .expect(200);
    const stored = await prisma.refreshToken.findFirstOrThrow({
      where: { userId: me.body.id },
    });
    expect(stored.tokenHash).not.toBe(refreshToken);
    expect(stored.tokenHash).toHaveLength(64);
  });
  it('enforces roles using current database state', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: driverEmail, password })
      .expect(200);
    await request(app.getHttpServer())
      .get('/api/v1/users')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(403);
    await prisma.user.update({
      where: { email: driverEmail },
      data: { active: false },
    });
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${login.body.accessToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: login.body.refreshToken })
      .expect(401);
  });
  it('atomically rotates refresh; rejects reuse and logout revokes replacement', async () => {
    const concurrent = await Promise.all(
      [1, 2].map(() =>
        request(app.getHttpServer())
          .post('/api/v1/auth/refresh')
          .send({ refreshToken }),
      ),
    );
    expect(concurrent.map((r) => r.status).sort()).toEqual([200, 401]);
    const next = concurrent.find((r) => r.status === 200)!.body;
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken })
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${next.refreshToken}`)
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: next.refreshToken })
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .send({ refreshToken: next.refreshToken })
      .expect(204);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: next.refreshToken })
      .expect(401);
  });
  it('returns sanitized 503 when the database query fails', async () => {
    const { PrismaService } = await import('../dist/prisma/prisma.service.js');
    const spy = vi
      .spyOn(app.get(PrismaService), '$queryRaw')
      .mockRejectedValueOnce(new Error('sensitive SQL and credentials'));
    try {
      const result = await request(app.getHttpServer())
        .get('/health')
        .expect(503);
      expect(JSON.stringify(result.body)).not.toContain('sensitive');
    } finally {
      spy.mockRestore();
    }
  });
  it('limits body size, rejects malformed JSON and throttles authentication', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ content: 'a'.repeat(20000) })
      .expect(413);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: 'incorrect' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password })
      .expect(429);
  });
});
