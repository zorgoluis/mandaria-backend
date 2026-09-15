import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

process.env.DATABASE_URL = 'postgresql://localhost/mandaria_test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.CORS_ORIGINS = 'http://localhost:5173';
const query = vi.fn().mockResolvedValue([{ value: 1 }]);
let app: INestApplication;
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { PrismaService } = await import('../dist/prisma/prisma.service.js');
  const { setup } = await import('../dist/setup.js');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(PrismaService)
    .useValue({
      $queryRaw: query,
      user: { findUnique: vi.fn().mockResolvedValue(null) },
    })
    .compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  setup(app);
  await app.init();
});
afterAll(async () => {
  await app?.close();
});
it('serves health and Swagger through the configured routes', async () => {
  await request(app.getHttpServer()).get('/health').expect(200);
  const docs = await request(app.getHttpServer()).get('/docs-json').expect(200);
  expect(docs.body.paths['/api/v1/auth/login']).toBeDefined();
  expect(
    docs.body.components.securitySchemes['integration-bearer'],
  ).toBeDefined();
});
it('enforces authentication and rejects unexpected DTO properties', async () => {
  await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
  await request(app.getHttpServer()).get('/api/v1/users').expect(401);
  const result = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({
      email: 'valid@example.test',
      password: 'do-not-leak',
      role: 'SUPER_ADMIN',
    })
    .expect(400);
  expect(result.body.code).toBe('VALIDATION_ERROR');
  expect(JSON.stringify(result.body)).not.toContain('do-not-leak');
});
it('sanitizes database failures and bounds request bodies', async () => {
  query.mockRejectedValueOnce(new Error('SQL secret'));
  const result = await request(app.getHttpServer()).get('/health').expect(503);
  expect(JSON.stringify(result.body)).not.toContain('SQL');
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .send({ content: 'a'.repeat(20000) })
    .expect(413);
  await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('Content-Type', 'application/json')
    .send('{')
    .expect(400);
});
it('applies Helmet and only allows configured CORS origins', async () => {
  const allowed = await request(app.getHttpServer())
    .get('/health')
    .set('Origin', 'http://localhost:5173')
    .expect(200);
  expect(allowed.headers['access-control-allow-origin']).toBe(
    'http://localhost:5173',
  );
  expect(allowed.headers['x-content-type-options']).toBe('nosniff');
  const denied = await request(app.getHttpServer())
    .get('/health')
    .set('Origin', 'https://unknown.example')
    .expect(200);
  expect(denied.headers['access-control-allow-origin']).toBeUndefined();
});
