import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { seedLocalProviderAdmins } from '../scripts/local-provider-admins.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').toUpperCase();
const password = randomBytes(24).toString('base64url');
const emails = {
  adminA: `a-${run}@provider-admin.test`.toLowerCase(),
  adminB: `b-${run}@provider-admin.test`.toLowerCase(),
  noMembership: `none-${run}@provider-admin.test`.toLowerCase(),
};
const codes = { providerA: `E2E_A_${run}`, providerB: `E2E_B_${run}` };
const superAdmin = {
  id: randomUUID(),
  email: `sa-${run}@provider-admin.test`.toLowerCase(),
};
const integrationIds: string[] = [];
let app: INestApplication;
let scenario: Awaited<ReturnType<typeof seedLocalProviderAdmins>>;
type Session = { accessToken: string; refreshToken: string };
let adminA: Session, adminB: Session, noMembership: Session, sa: Session;
const api = () => request(app.getHttpServer());

async function login(email: string): Promise<Session> {
  const res = await api()
    .post('/api/v1/auth/login')
    .send({ email, password })
    .expect(200);
  expect(res.body).toMatchObject({ tokenType: 'Bearer' });
  expect(typeof res.body.accessToken).toBe('string');
  expect(typeof res.body.refreshToken).toBe('string');
  return res.body;
}
const profile = (token: string, providerId?: string) =>
  api()
    .get('/api/v1/provider/profile')
    .query(providerId ? { providerId } : {})
    .auth(token, { type: 'bearer' });

beforeAll(async () => {
  await prisma.user.create({
    data: {
      ...superAdmin,
      passwordHash: await argon2.hash(password),
      role: 'SUPER_ADMIN',
    },
  });
  // Same code path as `npm run db:seed:local-provider-admins`, isolated by random emails/codes.
  scenario = await seedLocalProviderAdmins(prisma, { password, emails, codes });
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  setup(app);
  await app.init();
  // Login is throttled to 5/min per route: authenticate every actor once.
  adminA = await login(emails.adminA);
  adminB = await login(emails.adminB);
  noMembership = await login(emails.noMembership);
  sa = await login(superAdmin.email);
}, 60000);

afterAll(async () => {
  await app?.close();
  const providerIds = [scenario?.providerA.id, scenario?.providerB.id].filter(
    Boolean,
  ) as string[];
  const userIds = [
    superAdmin.id,
    scenario?.adminA.id,
    scenario?.adminB.id,
    scenario?.noMembership.id,
  ].filter(Boolean) as string[];
  await prisma.providerMembership.deleteMany({
    where: {
      OR: [{ providerId: { in: providerIds } }, { userId: { in: userIds } }],
    },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrationIds } },
  });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.$disconnect();
});

describe.sequential(
  'PROVIDER_ADMIN → ProviderMembership → DeliveryProvider (real auth)',
  () => {
    it('seeds the local scenario idempotently with exact memberships', async () => {
      expect(scenario.membershipA.role).toBe('OWNER');
      const providers = await prisma.deliveryProvider.findMany({
        where: { code: { in: [codes.providerA, codes.providerB] } },
      });
      expect(providers.map((p) => [p.type, p.status])).toEqual([
        ['FLEET', 'ACTIVE'],
        ['FLEET', 'ACTIVE'],
      ]);
      const again = await seedLocalProviderAdmins(prisma, {
        password,
        emails,
        codes,
      });
      expect(again).toEqual(scenario);
      const memberships = await prisma.providerMembership.findMany({
        where: {
          userId: {
            in: [
              scenario.adminA.id,
              scenario.adminB.id,
              scenario.noMembership.id,
            ],
          },
        },
        select: { userId: true, providerId: true },
      });
      expect(memberships).toHaveLength(2);
      expect(memberships).toEqual(
        expect.arrayContaining([
          { userId: scenario.adminA.id, providerId: scenario.providerA.id },
          { userId: scenario.adminB.id, providerId: scenario.providerB.id },
        ]),
      );
    });

    it('refuses to reuse an email that belongs to another role', async () => {
      await expect(
        seedLocalProviderAdmins(prisma, {
          password,
          codes,
          emails: { ...emails, noMembership: superAdmin.email },
        }),
      ).rejects.toThrow(/refusing/);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: superAdmin.id } }))
          .role,
      ).toBe('SUPER_ADMIN');
    });

    it('authenticates PROVIDER_ADMIN with real login, /auth/me and refresh rotation', async () => {
      const me = await api()
        .get('/api/v1/auth/me')
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(200);
      expect(me.body).toMatchObject({
        id: scenario.adminA.id,
        email: emails.adminA,
        role: 'PROVIDER_ADMIN',
        active: true,
      });
      expect(JSON.stringify(me.body)).not.toContain('passwordHash');
      const rotated = await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: adminA.refreshToken })
        .expect(200);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: adminA.refreshToken })
        .expect(401);
      adminA = rotated.body;
      await api()
        .get('/api/v1/auth/me')
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(200);
    });

    it('Case 1: PROVIDER_ADMIN A with membership → Provider A allowed', async () => {
      for (const providerId of [undefined, scenario.providerA.id]) {
        const res = await profile(adminA.accessToken, providerId).expect(200);
        expect(res.body).toMatchObject({
          id: scenario.providerA.id,
          name: 'Rápidos de Coita',
          type: 'FLEET',
          status: 'ACTIVE',
          membershipRole: 'OWNER',
        });
      }
      const list = await api()
        .get('/api/v1/provider/profiles')
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(200);
      expect(list.body.total).toBe(1);
      expect(list.body.items[0].id).toBe(scenario.providerA.id);
      const b = await profile(adminB.accessToken).expect(200);
      expect(b.body.id).toBe(scenario.providerB.id);
    });

    it('Case 2: PROVIDER_ADMIN A → Provider B rejected; client-supplied IDs do not escalate', async () => {
      await profile(adminA.accessToken, scenario.providerB.id).expect(403);
      await profile(adminB.accessToken, scenario.providerA.id).expect(403);
      await profile(adminA.accessToken, randomUUID()).expect(403);
      await api()
        .get('/api/v1/provider/profile')
        .query({
          providerId: scenario.providerA.id,
          userId: scenario.adminB.id,
        })
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(400);
      await api()
        .get('/api/v1/provider/profiles')
        .query({ userId: scenario.adminB.id })
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(400);
      await api()
        .get(
          `/api/v1/provider/profile?providerId=${scenario.providerA.id}&providerId=${scenario.providerB.id}`,
        )
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(400);
    });

    it('Case 3: PROVIDER_ADMIN without membership → any provider rejected', async () => {
      await profile(noMembership.accessToken).expect(403);
      await profile(noMembership.accessToken, scenario.providerA.id).expect(
        403,
      );
      await profile(noMembership.accessToken, scenario.providerB.id).expect(
        403,
      );
      const list = await api()
        .get('/api/v1/provider/profiles')
        .auth(noMembership.accessToken, { type: 'bearer' })
        .expect(200);
      expect(list.body).toMatchObject({ items: [], total: 0 });
    });

    it('Case 4: PROVIDER_ADMIN → SUPER_ADMIN endpoints rejected, including B2B administration', async () => {
      const created = await api()
        .post('/api/v1/admin/integrations')
        .auth(sa.accessToken, { type: 'bearer' })
        .send({ name: 'Provider admin denial', code: `E2E_INT_${run}` })
        .expect(201);
      integrationIds.push(created.body.id);
      const credential = await api()
        .post(`/api/v1/admin/integrations/${created.body.id}/credentials`)
        .auth(sa.accessToken, { type: 'bearer' })
        .send({ scopes: ['deliveries:read'] })
        .expect(201);
      const { providerA, providerB, adminA: userA } = scenario;
      const client = created.body.id as string;
      const cred = credential.body.clientId as string;
      const denied: [string, string, object?][] = [
        ['get', '/admin/providers'],
        [
          'post',
          '/admin/providers',
          { name: 'X', code: 'DENIED_X', type: 'FLEET' },
        ],
        ['get', `/admin/providers/${providerA.id}`],
        ['patch', `/admin/providers/${providerA.id}`, { maxDrivers: 999 }],
        ['post', `/admin/providers/${providerA.id}/suspend`],
        ['post', `/admin/providers/${providerB.id}/activate`],
        ['get', `/admin/providers/${providerA.id}/members`],
        [
          'post',
          `/admin/providers/${providerB.id}/members`,
          { userId: userA.id, role: 'OWNER' },
        ],
        [
          'delete',
          `/admin/providers/${providerA.id}/members/${scenario.membershipA.id}`,
        ],
        ['get', '/users'],
      ];
      for (const prefix of ['/admin/integrations', '/integrations'])
        denied.push(
          ['get', prefix],
          ['post', prefix, { name: 'Denied', code: 'DENIED_INTEGRATION' }],
          ['get', `${prefix}/${client}`],
          ['patch', `${prefix}/${client}`, { status: 'SUSPENDED' }],
          ['post', `${prefix}/${client}/credentials`, {}],
          ['get', `${prefix}/${client}/credentials`],
          ['post', `${prefix}/${client}/credentials/${cred}/rotate`],
          ['post', `${prefix}/${client}/credentials/${cred}/revoke`],
          ['delete', `${prefix}/${client}/credentials/${cred}`],
        );
      for (const token of [adminA.accessToken, noMembership.accessToken])
        for (const [method, path, body] of denied) {
          const req = api()[method as 'get'](`/api/v1${path}`).auth(token, {
            type: 'bearer',
          });
          const res = await (body ? req.send(body) : req);
          expect({ method, path, status: res.status }).toEqual({
            method,
            path,
            status: 403,
          });
        }
      // Denied requests changed nothing.
      expect(
        await prisma.integrationClient.findUniqueOrThrow({
          where: { id: client },
        }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await prisma.integrationCredential.findMany({
          where: { clientId: client },
          select: { status: true },
        }),
      ).toEqual([{ status: 'ACTIVE' }]);
      expect(
        await prisma.deliveryProvider.findUniqueOrThrow({
          where: { id: providerA.id },
        }),
      ).toMatchObject({ status: 'ACTIVE', maxDrivers: 10 });
      expect(
        await prisma.providerMembership.count({ where: { userId: userA.id } }),
      ).toBe(1);
      expect(
        await prisma.deliveryProvider.count({ where: { code: 'DENIED_X' } }),
      ).toBe(0);
    });

    it('Case 5: SUPER_ADMIN still administers Provider A and B', async () => {
      for (const [provider, email] of [
        [scenario.providerA, emails.adminA],
        [scenario.providerB, emails.adminB],
      ] as const) {
        await api()
          .get(`/api/v1/admin/providers/${provider.id}`)
          .auth(sa.accessToken, { type: 'bearer' })
          .expect(200);
        const members = await api()
          .get(`/api/v1/admin/providers/${provider.id}/members`)
          .auth(sa.accessToken, { type: 'bearer' })
          .expect(200);
        expect(
          members.body.items.map(
            (m: { user: { email: string } }) => m.user.email,
          ),
        ).toEqual([email]);
        await api()
          .patch(`/api/v1/admin/providers/${provider.id}`)
          .auth(sa.accessToken, { type: 'bearer' })
          .send({ maxVehicles: 12 })
          .expect(200);
      }
      // A membership granted by SUPER_ADMIN is honoured immediately and revocable.
      const granted = await api()
        .post(`/api/v1/admin/providers/${scenario.providerB.id}/members`)
        .auth(sa.accessToken, { type: 'bearer' })
        .send({ userId: scenario.noMembership.id, role: 'ADMIN' })
        .expect(201);
      await profile(noMembership.accessToken, scenario.providerB.id).expect(
        200,
      );
      await profile(noMembership.accessToken, scenario.providerA.id).expect(
        403,
      );
      await api()
        .delete(
          `/api/v1/admin/providers/${scenario.providerB.id}/members/${granted.body.id}`,
        )
        .auth(sa.accessToken, { type: 'bearer' })
        .expect(204);
      await profile(noMembership.accessToken, scenario.providerB.id).expect(
        403,
      );
      // SUPER_ADMIN uses /admin; the PROVIDER_ADMIN surface stays role-restricted.
      await profile(sa.accessToken).expect(403);
    });

    it('Case 6: IntegrationClient JWT → Provider Admin endpoints rejected', async () => {
      const created = await api()
        .post('/api/v1/admin/integrations')
        .auth(sa.accessToken, { type: 'bearer' })
        .send({ name: 'Provider admin separation', code: `E2E_B2B_${run}` })
        .expect(201);
      integrationIds.push(created.body.id);
      const credential = await api()
        .post(`/api/v1/admin/integrations/${created.body.id}/credentials`)
        .auth(sa.accessToken, { type: 'bearer' })
        .send({ scopes: ['deliveries:read'] })
        .expect(201);
      const token = (
        await api()
          .post('/api/v1/integrations/token')
          .send({
            clientId: credential.body.clientId,
            clientSecret: credential.body.clientSecret,
          })
          .expect(200)
      ).body.accessToken as string;
      for (const path of [
        '/api/v1/provider/profile',
        `/api/v1/provider/profile?providerId=${scenario.providerA.id}`,
        '/api/v1/provider/profiles',
        '/api/v1/admin/providers',
        '/api/v1/auth/me',
      ])
        await api().get(path).auth(token, { type: 'bearer' }).expect(401);
      await api()
        .get('/api/v1/integrations/me')
        .auth(adminA.accessToken, { type: 'bearer' })
        .expect(401);
    });
  },
);
