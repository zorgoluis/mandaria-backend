import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { seedLocalProviderAdmins } from '../scripts/local-provider-admins.js';
import { FakeMailProvider } from './support/fake-mail.provider.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.MANDARIA_WEB_URL = 'https://web.mandaria.test';
process.env.MAIL_PROVIDER = 'local_outbox';
process.env.USER_INVITATION_TTL_HOURS = '24';
process.env.USER_INVITATION_RESEND_COOLDOWN_SECONDS = '60';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 16).toLowerCase();
const password = randomBytes(24).toString('base64url');
const email = (name: string) => `${name}-${run}@test.local`;
const emails = {
  adminA: email('admin-a'),
  adminB: email('admin-b'),
  noMembership: email('admin-none'),
};
const codes = {
  providerA: `E2E_INV_A_${run.toUpperCase()}`,
  providerB: `E2E_INV_B_${run.toUpperCase()}`,
};
const superAdmin = { id: randomUUID(), email: email('sa') };
const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');
const bearer = { type: 'bearer' } as const;
const mail = new FakeMailProvider();
const logs: string[] = [];
const captureLogger: LoggerService = {
  log: (m: unknown) => void logs.push(JSON.stringify(m)),
  warn: (m: unknown) => void logs.push(JSON.stringify(m)),
  error: (m: unknown) => void logs.push(JSON.stringify(m)),
  debug: () => undefined,
  verbose: () => undefined,
};
/** Every password used by invited people; none may appear in logs. */
const chosenPasswords: string[] = [];
const newPassword = () => {
  const value = randomBytes(18).toString('base64url');
  chosenPasswords.push(value);
  return value;
};
const extraProviderIds: string[] = [];
const integrationIds: string[] = [];

type Session = { accessToken: string; refreshToken: string };
let scenario: Awaited<ReturnType<typeof seedLocalProviderAdmins>>;
let sa: Session, adminA: Session, adminB: Session, noMembership: Session;
let driverSession: Session;
let app: INestApplication;
const api = () => request(app.getHttpServer());

async function bootstrap() {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { MAIL_PROVIDER } = await import('../dist/mail/mail.types.js');
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(mail)
    .setLogger(captureLogger)
    .compile();
  const instance = moduleRef.createNestApplication({
    logger: captureLogger,
    bodyParser: false,
  });
  setup(instance);
  await instance.init();
  return instance;
}
/** A fresh application per describe resets the per-IP throttles (login 5/min, activation 10/min). */
function withApp() {
  beforeAll(async () => {
    app = await bootstrap();
  });
  afterAll(async () => {
    await app?.close();
  });
}
async function login(address: string, secret = password): Promise<Session> {
  const res = await api()
    .post('/api/v1/auth/login')
    .send({ email: address, password: secret })
    .expect(200);
  return res.body;
}
const inviteAsAdmin = (providerId: string, body: object, token = sa) =>
  api()
    .post(`/api/v1/admin/providers/${providerId}/invitations`)
    .auth(token.accessToken, bearer)
    .send(body);
const inviteDriver = (token: Session, body: object, providerId?: string) =>
  api()
    .post('/api/v1/provider/driver-invitations')
    .query(providerId ? { providerId } : {})
    .auth(token.accessToken, bearer)
    .send(body);
const activate = (token: string, secret: string) =>
  api().post('/api/v1/auth/activate-account').send({ token, password: secret });
/** Moves the current token back in time, as if it had been issued long ago. */
const backdate = (id: string, hoursAgo: number, ttlHours = 24) =>
  prisma.userInvitation.update({
    where: { id },
    data: {
      tokenIssuedAt: new Date(Date.now() - hoursAgo * 3_600_000),
      expiresAt: new Date(Date.now() - (hoursAgo - ttlHours) * 3_600_000),
    },
  });
const userByEmail = (address: string) =>
  prisma.user.findUniqueOrThrow({ where: { email: address } });

beforeAll(async () => {
  await prisma.user.create({
    data: {
      ...superAdmin,
      passwordHash: await argon2.hash(password),
      role: 'SUPER_ADMIN',
    },
  });
  scenario = await seedLocalProviderAdmins(prisma, { password, emails, codes });
}, 60000);

afterAll(async () => {
  const providerIds = [
    scenario?.providerA.id,
    scenario?.providerB.id,
    ...extraProviderIds,
  ].filter(Boolean) as string[];
  const users = await prisma.user.findMany({
    where: { email: { contains: run } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  await prisma.userInvitation.deleteMany({
    where: {
      OR: [{ providerId: { in: providerIds } }, { userId: { in: userIds } }],
    },
  });
  await prisma.driver.deleteMany({
    where: {
      OR: [{ providerId: { in: providerIds } }, { userId: { in: userIds } }],
    },
  });
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

describe.sequential('Provisioning flows (real login, FakeMailProvider)', () => {
  withApp();
  const paEmail = email('provider-admin-real');
  const driverEmail = email('driver-real');
  const paPassword = newPassword();
  const driverPassword = newPassword();
  let paInvitationId: string;
  let paToken: string;
  let driverToken: string;

  beforeAll(async () => {
    // Login is throttled to 5/min per IP: authenticate fixture actors once for the whole file.
    sa = await login(superAdmin.email);
    adminA = await login(emails.adminA);
    adminB = await login(emails.adminB);
  });

  it('SUPER_ADMIN invites a PROVIDER_ADMIN: INVITED user, hashed single token, emailed link', async () => {
    const res = await inviteAsAdmin(scenario.providerA.id, {
      email: `  ${paEmail.toUpperCase()} `,
      role: 'PROVIDER_ADMIN',
      membershipRole: 'OWNER',
    }).expect(201);
    expect(res.body).toMatchObject({
      email: paEmail,
      role: 'PROVIDER_ADMIN',
      status: 'PENDING',
      providerId: scenario.providerA.id,
      provider: { id: scenario.providerA.id, code: codes.providerA },
      membershipRole: 'OWNER',
      driverName: null,
      resendCount: 0,
      createdByUserId: superAdmin.id,
      emailDelivery: 'SENT',
    });
    expect(res.body).not.toHaveProperty('tokenHash');
    expect(res.body).not.toHaveProperty('token');
    paInvitationId = res.body.id;
    const message = mail.last(paEmail);
    expect(message).toMatchObject({
      role: 'PROVIDER_ADMIN',
      providerName: scenario.providerA.name,
    });
    expect(message.activationUrl).toMatch(
      /^https:\/\/web\.mandaria\.test\/activate-account\?token=[A-Za-z0-9_-]{43}$/,
    );
    paToken = mail.tokenFor(paEmail);
    expect(JSON.stringify(res.body)).not.toContain(paToken);
    const row = await prisma.userInvitation.findUniqueOrThrow({
      where: { id: paInvitationId },
    });
    expect(row.tokenHash).toBe(sha256(paToken));
    expect(JSON.stringify(row)).not.toContain(paToken);
    expect(
      (row.expiresAt.getTime() - row.tokenIssuedAt.getTime()) / 3_600_000,
    ).toBe(24);
    const user = await userByEmail(paEmail);
    expect(user).toMatchObject({
      role: 'PROVIDER_ADMIN',
      active: false,
      passwordHash: null,
      emailVerifiedAt: null,
    });
    expect(row.userId).toBe(user.id);
    // The membership is materialized on activation, not before.
    expect(
      await prisma.providerMembership.count({ where: { userId: user.id } }),
    ).toBe(0);
    const users = await api()
      .get('/api/v1/users')
      .query({ status: 'INVITED' })
      .auth(sa.accessToken, bearer)
      .expect(200);
    const listed = users.body.find(
      (u: { email: string }) => u.email === paEmail,
    );
    expect(listed).toMatchObject({ status: 'INVITED', active: false });
    expect(JSON.stringify(users.body)).not.toContain('passwordHash');
    expect(
      users.body.every((u: { status: string }) => u.status === 'INVITED'),
    ).toBe(true);
  });

  it('activation stores an Argon2id password and creates the membership in one step', async () => {
    const res = await activate(paToken, paPassword).expect(200);
    expect(res.body).toEqual({
      status: 'ACTIVE',
      email: paEmail,
      role: 'PROVIDER_ADMIN',
    });
    const user = await userByEmail(paEmail);
    expect(user.active).toBe(true);
    expect(user.passwordHash).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(user.passwordHash!, paPassword)).toBe(true);
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(
      await prisma.providerMembership.findMany({
        where: { userId: user.id },
        select: { providerId: true, role: true },
      }),
    ).toEqual([{ providerId: scenario.providerA.id, role: 'OWNER' }]);
    expect(
      await prisma.userInvitation.findUniqueOrThrow({
        where: { id: paInvitationId },
      }),
    ).toMatchObject({ status: 'ACCEPTED', revokedAt: null });
  });

  it('the activated PROVIDER_ADMIN logs in normally: me, own provider, 403 elsewhere, refresh, logout', async () => {
    const session = await login(paEmail, paPassword);
    const me = await api()
      .get('/api/v1/auth/me')
      .auth(session.accessToken, bearer)
      .expect(200);
    expect(me.body).toMatchObject({
      email: paEmail,
      role: 'PROVIDER_ADMIN',
      active: true,
    });
    expect(JSON.stringify(me.body)).not.toContain('passwordHash');
    const profile = await api()
      .get('/api/v1/provider/profile')
      .auth(session.accessToken, bearer)
      .expect(200);
    expect(profile.body).toMatchObject({
      id: scenario.providerA.id,
      membershipRole: 'OWNER',
    });
    await api()
      .get('/api/v1/provider/profile')
      .query({ providerId: scenario.providerB.id })
      .auth(session.accessToken, bearer)
      .expect(403);
    const refreshed = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: session.refreshToken })
      .expect(200);
    await api()
      .get('/api/v1/auth/me')
      .auth(refreshed.body.accessToken, bearer)
      .expect(200);
    await api()
      .post('/api/v1/auth/logout')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(204);
    await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: refreshed.body.refreshToken })
      .expect(401);
  });

  it('the same token cannot be used twice', async () => {
    const res = await activate(paToken, newPassword()).expect(409);
    expect(res.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    const user = await userByEmail(paEmail);
    expect(await argon2.verify(user.passwordHash!, paPassword)).toBe(true);
  });

  it('PROVIDER_ADMIN A invites a DRIVER to Provider A; the payload cannot pick role or provider', async () => {
    const res = await inviteDriver(adminA, {
      email: driverEmail,
      driverName: '  Carlos Real ',
    }).expect(201);
    expect(res.body).toMatchObject({
      email: driverEmail,
      role: 'DRIVER',
      providerId: scenario.providerA.id,
      driverName: 'Carlos Real',
      membershipRole: null,
      createdByUserId: scenario.adminA.id,
      emailDelivery: 'SENT',
    });
    driverToken = mail.tokenFor(driverEmail);
    for (const extra of [
      { role: 'PROVIDER_ADMIN' },
      { role: 'SUPER_ADMIN' },
      { providerId: scenario.providerB.id },
      { membershipRole: 'OWNER' },
    ]) {
      const bad = await inviteDriver(adminA, {
        email: email('escalation'),
        driverName: 'X',
        ...extra,
      }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_ERROR');
    }
    await inviteDriver(
      adminA,
      { email: email('escalation'), driverName: 'X' },
      scenario.providerB.id,
    ).expect(403);
    expect(
      await prisma.user.count({ where: { email: email('escalation') } }),
    ).toBe(0);
  });

  it('the DRIVER activates, logs in and resolves its Driver profile in Provider A', async () => {
    const driverPasswordBody = await activate(
      driverToken,
      driverPassword,
    ).expect(200);
    expect(driverPasswordBody.body).toEqual({
      status: 'ACTIVE',
      email: driverEmail,
      role: 'DRIVER',
    });
    const user = await userByEmail(driverEmail);
    expect(
      await prisma.driver.findUniqueOrThrow({ where: { userId: user.id } }),
    ).toMatchObject({
      providerId: scenario.providerA.id,
      name: 'Carlos Real',
      status: 'PENDING',
      availability: 'OFFLINE',
    });
    driverSession = await login(driverEmail, driverPassword);
    const me = await api()
      .get('/api/v1/driver/me')
      .auth(driverSession.accessToken, bearer)
      .expect(200);
    expect(me.body).toMatchObject({
      name: 'Carlos Real',
      provider: { id: scenario.providerA.id },
    });
    const list = await api()
      .get('/api/v1/provider/drivers')
      .auth(adminA.accessToken, bearer)
      .expect(200);
    expect(
      list.body.items.some(
        (d: { user: { email: string } }) => d.user.email === driverEmail,
      ),
    ).toBe(true);
  });
});

describe.sequential('Role matrix and provider isolation', () => {
  withApp();
  let invitationA: string;
  let invitationB: string;

  it('Admin A → Provider A ✅ / Provider B ❌; Admin B → Provider B ✅ / Provider A ❌', async () => {
    invitationA = (
      await inviteDriver(
        adminA,
        { email: email('iso-a'), driverName: 'Iso A' },
        scenario.providerA.id,
      ).expect(201)
    ).body.id;
    await inviteDriver(
      adminA,
      { email: email('iso-a2'), driverName: 'Iso A2' },
      scenario.providerB.id,
    ).expect(403);
    invitationB = (
      await inviteDriver(
        adminB,
        { email: email('iso-b'), driverName: 'Iso B' },
        scenario.providerB.id,
      ).expect(201)
    ).body.id;
    await inviteDriver(
      adminB,
      { email: email('iso-b2'), driverName: 'Iso B2' },
      scenario.providerA.id,
    ).expect(403);
    expect(
      await prisma.user.count({
        where: { email: { in: [email('iso-a2'), email('iso-b2')] } },
      }),
    ).toBe(0);
  });

  it('PROVIDER_ADMIN sees and manages only DRIVER invitations of its own provider', async () => {
    const listA = await api()
      .get('/api/v1/provider/driver-invitations')
      .auth(adminA.accessToken, bearer)
      .expect(200);
    const idsA = listA.body.items.map((i: { id: string }) => i.id);
    expect(idsA).toContain(invitationA);
    expect(idsA).not.toContain(invitationB);
    expect(
      listA.body.items.every(
        (i: { providerId: string; role: string }) =>
          i.providerId === scenario.providerA.id && i.role === 'DRIVER',
      ),
    ).toBe(true);
    // The SUPER_ADMIN PROVIDER_ADMIN invitation for Provider A is not visible to its admins.
    expect(
      listA.body.items.some(
        (i: { email: string }) => i.email === email('provider-admin-real'),
      ),
    ).toBe(false);
    const foreign = `/api/v1/provider/driver-invitations/${invitationB}`;
    for (const call of [
      () => api().get(foreign),
      () => api().post(`${foreign}/resend`),
      () => api().post(`${foreign}/revoke`),
    ])
      await call().auth(adminA.accessToken, bearer).expect(404);
    const listB = await api()
      .get('/api/v1/provider/driver-invitations')
      .auth(adminB.accessToken, bearer)
      .expect(200);
    expect(listB.body.items.map((i: { id: string }) => i.id)).toEqual([
      invitationB,
    ]);
    const saList = await api()
      .get('/api/v1/admin/user-invitations')
      .query({ providerId: scenario.providerB.id })
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(saList.body.items.map((i: { id: string }) => i.id)).toContain(
      invitationB,
    );
  });

  it('DRIVER and PROVIDER_ADMIN cannot use SUPER_ADMIN invitation routes; admins without membership are refused', async () => {
    for (const session of [driverSession, adminA]) {
      await inviteAsAdmin(
        scenario.providerA.id,
        { email: email('forbidden'), role: 'DRIVER', driverName: 'X' },
        session,
      ).expect(403);
      await api()
        .get('/api/v1/admin/user-invitations')
        .auth(session.accessToken, bearer)
        .expect(403);
      await api()
        .post(`/api/v1/admin/user-invitations/${invitationA}/revoke`)
        .auth(session.accessToken, bearer)
        .expect(403);
    }
    await inviteDriver(driverSession, {
      email: email('forbidden'),
      driverName: 'X',
    }).expect(403);
    noMembership = await login(emails.noMembership);
    await inviteDriver(noMembership, {
      email: email('forbidden'),
      driverName: 'X',
    }).expect(403);
    await api()
      .get('/api/v1/provider/driver-invitations')
      .auth(noMembership.accessToken, bearer)
      .expect(403);
    expect(
      await prisma.user.count({ where: { email: email('forbidden') } }),
    ).toBe(0);
  });

  it('IntegrationClient credentials cannot invite, list, resend, revoke or read users', async () => {
    const client = await api()
      .post('/api/v1/admin/integrations')
      .auth(sa.accessToken, bearer)
      .send({ name: 'Invitation probe', code: `E2E_INV_${run.toUpperCase()}` })
      .expect(201);
    integrationIds.push(client.body.id);
    const credential = await api()
      .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
      .auth(sa.accessToken, bearer)
      .send({
        scopes: ['deliveries:create', 'deliveries:read', 'quotes:create'],
      })
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
    // Built lazily: a supertest request binds the server when it is created.
    const calls = [
      () =>
        api()
          .post(`/api/v1/admin/providers/${scenario.providerA.id}/invitations`)
          .send({ email: email('b2b'), role: 'DRIVER', driverName: 'X' }),
      () => api().get('/api/v1/admin/user-invitations'),
      () => api().get(`/api/v1/admin/user-invitations/${invitationA}`),
      () => api().post(`/api/v1/admin/user-invitations/${invitationA}/resend`),
      () => api().post(`/api/v1/admin/user-invitations/${invitationA}/revoke`),
      () =>
        api()
          .post('/api/v1/provider/driver-invitations')
          .send({ email: email('b2b'), driverName: 'X' }),
      () => api().get('/api/v1/provider/driver-invitations'),
      () => api().get('/api/v1/users'),
    ];
    for (const call of calls) await call().auth(token, bearer).expect(401);
    expect(await prisma.user.count({ where: { email: email('b2b') } })).toBe(0);
    expect(
      (
        await prisma.userInvitation.findUniqueOrThrow({
          where: { id: invitationA },
        })
      ).status,
    ).toBe('PENDING');
  });
});

describe.sequential('Invitation lifecycle and negative cases', () => {
  withApp();

  it('expired token is rejected without activating; resend rotates the token and reopens activation', async () => {
    const address = email('expired');
    const created = await inviteAsAdmin(scenario.providerB.id, {
      email: address,
      role: 'DRIVER',
      driverName: 'Expira',
    }).expect(201);
    const firstToken = mail.tokenFor(address);
    await backdate(created.body.id, 48);
    const expired = await activate(firstToken, newPassword()).expect(410);
    expect(expired.body.code).toBe('INVITATION_EXPIRED');
    const user = await userByEmail(address);
    expect(user).toMatchObject({ active: false, passwordHash: null });
    expect(await prisma.driver.count({ where: { userId: user.id } })).toBe(0);
    const expiredList = await api()
      .get('/api/v1/admin/user-invitations')
      .query({ status: 'EXPIRED', search: address.toUpperCase() })
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(expiredList.body.items).toMatchObject([
      { id: created.body.id, status: 'EXPIRED' },
    ]);
    const pendingList = await api()
      .get('/api/v1/admin/user-invitations')
      .query({ status: 'PENDING', search: address })
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(pendingList.body.total).toBe(0);

    const resent = await api()
      .post(`/api/v1/admin/user-invitations/${created.body.id}/resend`)
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(resent.body).toMatchObject({
      id: created.body.id,
      userId: user.id,
      status: 'PENDING',
      resendCount: 1,
      emailDelivery: 'SENT',
    });
    expect(new Date(resent.body.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 23 * 3_600_000,
    );
    const secondToken = mail.tokenFor(address);
    expect(secondToken).not.toBe(firstToken);
    expect(
      (
        await prisma.userInvitation.findUniqueOrThrow({
          where: { id: created.body.id },
        })
      ).tokenHash,
    ).toBe(sha256(secondToken));
    expect((await activate(firstToken, newPassword())).body.code).toBe(
      'INVITATION_TOKEN_INVALID',
    );
    const cooldown = await api()
      .post(`/api/v1/admin/user-invitations/${created.body.id}/resend`)
      .auth(sa.accessToken, bearer)
      .expect(429);
    expect(cooldown.body.code).toBe('INVITATION_RESEND_COOLDOWN');
    await activate(secondToken, newPassword()).expect(200);
    expect(await prisma.user.count({ where: { email: address } })).toBe(1);
    for (const action of ['resend', 'revoke']) {
      const res = await api()
        .post(`/api/v1/admin/user-invitations/${created.body.id}/${action}`)
        .auth(sa.accessToken, bearer)
        .expect(409);
      expect(res.body.code).toBe('INVITATION_NOT_PENDING');
    }
  });

  it('revoked token is rejected; revoke is idempotent and the email can be invited again without a second User', async () => {
    const address = email('revoked');
    const created = await inviteDriver(adminA, {
      email: address,
      driverName: 'Revocado',
    }).expect(201);
    const token = mail.tokenFor(address);
    const revoked = await api()
      .post(`/api/v1/provider/driver-invitations/${created.body.id}/revoke`)
      .auth(adminA.accessToken, bearer)
      .expect(200);
    expect(revoked.body).toMatchObject({
      status: 'REVOKED',
      revokedByUserId: scenario.adminA.id,
    });
    const again = await api()
      .post(`/api/v1/provider/driver-invitations/${created.body.id}/revoke`)
      .auth(adminA.accessToken, bearer)
      .expect(200);
    expect(again.body.revokedAt).toBe(revoked.body.revokedAt);
    expect((await activate(token, newPassword())).body.code).toBe(
      'INVITATION_REVOKED',
    );
    const resend = await api()
      .post(`/api/v1/provider/driver-invitations/${created.body.id}/resend`)
      .auth(adminA.accessToken, bearer)
      .expect(409);
    expect(resend.body.code).toBe('INVITATION_NOT_PENDING');
    const user = await userByEmail(address);
    expect(user).toMatchObject({ active: false, passwordHash: null });
    expect(await prisma.driver.count({ where: { userId: user.id } })).toBe(0);

    const reinvited = await inviteDriver(adminA, {
      email: address,
      driverName: 'Revocado Dos',
    }).expect(201);
    expect(reinvited.body.id).not.toBe(created.body.id);
    expect(reinvited.body.userId).toBe(user.id);
    expect(await prisma.user.count({ where: { email: address } })).toBe(1);
    expect(
      await prisma.userInvitation.count({ where: { userId: user.id } }),
    ).toBe(2);
    expect((await activate(token, newPassword())).body.code).toBe(
      'INVITATION_REVOKED',
    );
  });

  it('rejects duplicate pending, ACTIVE and DISABLED emails without creating users', async () => {
    const address = email('duplicate');
    await inviteAsAdmin(scenario.providerA.id, {
      email: address,
      role: 'DRIVER',
      driverName: 'Dup',
    }).expect(201);
    for (const variant of [address, address.toUpperCase()]) {
      const dup = await inviteAsAdmin(scenario.providerB.id, {
        email: variant,
        role: 'PROVIDER_ADMIN',
        membershipRole: 'ADMIN',
      }).expect(409);
      expect(dup.body.code).toBe('USER_INVITATION_PENDING');
    }
    const byProvider = await inviteDriver(adminA, {
      email: address,
      driverName: 'Dup',
    }).expect(409);
    expect(byProvider.body.code).toBe('USER_INVITATION_PENDING');
    expect(await prisma.user.count({ where: { email: address } })).toBe(1);
    expect(
      (await userByEmail(address)).role,
      'a rejected invitation never changes the pending role',
    ).toBe('DRIVER');

    for (const active of [emails.adminA, superAdmin.email]) {
      const res = await inviteAsAdmin(scenario.providerA.id, {
        email: active,
        role: 'PROVIDER_ADMIN',
        membershipRole: 'ADMIN',
      }).expect(409);
      expect(res.body.code).toBe('USER_ALREADY_ACTIVE');
    }
    expect((await userByEmail(superAdmin.email)).role).toBe('SUPER_ADMIN');

    const disabledEmail = email('disabled');
    const disabledHash = await argon2.hash(randomBytes(20).toString('hex'));
    await prisma.user.create({
      data: {
        email: disabledEmail,
        passwordHash: disabledHash,
        role: 'DRIVER',
        active: false,
      },
    });
    const disabled = await inviteDriver(adminA, {
      email: disabledEmail,
      driverName: 'Disabled',
    }).expect(409);
    expect(disabled.body.code).toBe('USER_DISABLED');
    expect(await userByEmail(disabledEmail)).toMatchObject({
      active: false,
      passwordHash: disabledHash,
    });
    const listed = await api()
      .get('/api/v1/users')
      .query({ status: 'DISABLED' })
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(
      listed.body.find((u: { email: string }) => u.email === disabledEmail),
    ).toMatchObject({ status: 'DISABLED' });
  });

  it('keeps the invitation when email delivery fails so it can be resent', async () => {
    const address = email('mail-failure');
    mail.failNext = 1;
    const created = await inviteAsAdmin(scenario.providerA.id, {
      email: address,
      role: 'PROVIDER_ADMIN',
      membershipRole: 'ADMIN',
    }).expect(201);
    expect(created.body).toMatchObject({
      status: 'PENDING',
      emailDelivery: 'FAILED',
    });
    expect(mail.to(address)).toHaveLength(0);
    await backdate(created.body.id, 1);
    const resent = await api()
      .post(`/api/v1/admin/user-invitations/${created.body.id}/resend`)
      .auth(sa.accessToken, bearer)
      .expect(200);
    expect(resent.body.emailDelivery).toBe('SENT');
    expect(mail.to(address)).toHaveLength(1);
  });

  it('pending DRIVER invitations reserve maxDrivers seats', async () => {
    const provider = await api()
      .post('/api/v1/admin/providers')
      .auth(sa.accessToken, bearer)
      .send({
        name: 'Capacidad uno',
        code: `E2E_INV_CAP_${run.toUpperCase()}`,
        type: 'FLEET',
        maxDrivers: 1,
        maxVehicles: 1,
      })
      .expect(201);
    extraProviderIds.push(provider.body.id);
    const first = await inviteAsAdmin(provider.body.id, {
      email: email('seat-1'),
      role: 'DRIVER',
      driverName: 'Seat 1',
    }).expect(201);
    const full = await inviteAsAdmin(provider.body.id, {
      email: email('seat-2'),
      role: 'DRIVER',
      driverName: 'Seat 2',
    }).expect(409);
    expect(full.body.code).toBe('PROVIDER_DRIVER_LIMIT_REACHED');
    expect(await prisma.user.count({ where: { email: email('seat-2') } })).toBe(
      0,
    );
    // PROVIDER_ADMIN invitations do not consume driver seats.
    await inviteAsAdmin(provider.body.id, {
      email: email('seat-admin'),
      role: 'PROVIDER_ADMIN',
      membershipRole: 'OWNER',
    }).expect(201);
    await api()
      .post(`/api/v1/admin/user-invitations/${first.body.id}/revoke`)
      .auth(sa.accessToken, bearer)
      .expect(200);
    await inviteAsAdmin(provider.body.id, {
      email: email('seat-2'),
      role: 'DRIVER',
      driverName: 'Seat 2',
    }).expect(201);
  });
});

describe.sequential('Validation and public activation hardening', () => {
  withApp();

  it('validates roles and role-specific fields', async () => {
    const address = email('validation');
    for (const body of [
      { email: address, role: 'SUPER_ADMIN' },
      { email: address, role: 'CUSTOMER', driverName: 'X' },
      { email: address, role: 'PROVIDER_ADMIN' },
      { email: address, role: 'PROVIDER_ADMIN', membershipRole: 'CEO' },
      {
        email: address,
        role: 'PROVIDER_ADMIN',
        membershipRole: 'ADMIN',
        driverName: 'X',
      },
      { email: address, role: 'DRIVER' },
      { email: address, role: 'DRIVER', driverName: '   ' },
      {
        email: address,
        role: 'DRIVER',
        driverName: 'X',
        membershipRole: 'OWNER',
      },
      { email: 'not-an-email', role: 'DRIVER', driverName: 'X' },
      { email: address, role: 'DRIVER', driverName: 'X', password: 'x' },
    ])
      await inviteAsAdmin(scenario.providerA.id, body).expect(400);
    await inviteAsAdmin(randomUUID(), {
      email: address,
      role: 'DRIVER',
      driverName: 'X',
    }).expect(404);
    await api()
      .post('/api/v1/admin/providers/not-a-uuid/invitations')
      .auth(sa.accessToken, bearer)
      .send({ email: address, role: 'DRIVER', driverName: 'X' })
      .expect(400);
    expect(await prisma.user.count({ where: { email: address } })).toBe(0);
  });

  it('INVITED accounts cannot log in and get exactly the error of a wrong password', async () => {
    const address = email('no-login');
    await inviteAsAdmin(scenario.providerA.id, {
      email: address,
      role: 'DRIVER',
      driverName: 'No login',
    }).expect(201);
    const invited = await api()
      .post('/api/v1/auth/login')
      .send({ email: address, password: randomBytes(20).toString('hex') })
      .expect(401);
    const wrong = await api()
      .post('/api/v1/auth/login')
      .send({ email: emails.adminA, password: randomBytes(20).toString('hex') })
      .expect(401);
    expect(invited.body.code).toBe(wrong.body.code);
    expect(invited.body.message).toBe(wrong.body.message);
  });

  it('rejects unknown tokens and passwords outside the 16-128 policy without side effects', async () => {
    const address = email('weak');
    const created = await inviteAsAdmin(scenario.providerA.id, {
      email: address,
      role: 'PROVIDER_ADMIN',
      membershipRole: 'ADMIN',
    }).expect(201);
    const token = mail.tokenFor(address);
    const unknown = await activate(
      randomBytes(32).toString('base64url'),
      newPassword(),
    ).expect(400);
    expect(unknown.body).toMatchObject({
      code: 'INVITATION_TOKEN_INVALID',
      message: 'Invalid invitation token',
    });
    for (const secret of ['x'.repeat(15), 'x'.repeat(129)]) {
      const res = await activate(token, secret).expect(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    }
    await api()
      .post('/api/v1/auth/activate-account')
      .send({ password: newPassword() })
      .expect(400);
    await api()
      .post('/api/v1/auth/activate-account')
      .send({ token, password: newPassword(), role: 'SUPER_ADMIN' })
      .expect(400);
    expect(
      await prisma.userInvitation.findUniqueOrThrow({
        where: { id: created.body.id },
      }),
    ).toMatchObject({ status: 'PENDING' });
    expect(await userByEmail(address)).toMatchObject({
      active: false,
      passwordHash: null,
      role: 'PROVIDER_ADMIN',
    });
    // Exactly 16 and 128 characters are accepted.
    await activate(token, 'y'.repeat(16)).expect(200);
  });
});

describe.sequential('Concurrency', () => {
  withApp();

  it('20 simultaneous invitations for one email create one User and one valid invitation (both routes)', async () => {
    const cases = [
      {
        address: email('race-admin'),
        send: (address: string) =>
          inviteAsAdmin(scenario.providerB.id, {
            email: address,
            role: 'PROVIDER_ADMIN',
            membershipRole: 'ADMIN',
          }),
      },
      {
        address: email('race-driver'),
        send: (address: string) =>
          inviteDriver(adminA, { email: address, driverName: 'Race' }),
      },
    ];
    for (const { address, send } of cases) {
      const responses = await Promise.all(
        Array.from({ length: 20 }, () => send(address)),
      );
      const statuses = responses.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 409)).toHaveLength(19);
      expect(
        responses
          .filter((r) => r.status === 409)
          .every((r) => r.body.code === 'USER_INVITATION_PENDING'),
      ).toBe(true);
      const users = await prisma.user.findMany({ where: { email: address } });
      expect(users).toHaveLength(1);
      expect(
        await prisma.userInvitation.count({
          where: { userId: users[0].id, status: 'PENDING' },
        }),
      ).toBe(1);
      expect(mail.to(address)).toHaveLength(1);
    }
  });

  it('simultaneous resends rotate the token exactly once', async () => {
    const address = email('race-admin');
    const invitation = await prisma.userInvitation.findFirstOrThrow({
      where: { email: address, status: 'PENDING' },
    });
    const previousToken = mail.tokenFor(address);
    await backdate(invitation.id, 1);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        api()
          .post(`/api/v1/admin/user-invitations/${invitation.id}/resend`)
          .auth(sa.accessToken, bearer),
      ),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const rejected = responses.filter((r) => r.status !== 200);
    expect(rejected).toHaveLength(9);
    expect(
      rejected.every(
        (r) => r.status === 429 && r.body.code === 'INVITATION_RESEND_COOLDOWN',
      ),
    ).toBe(true);
    expect(mail.to(address)).toHaveLength(2);
    const token = mail.tokenFor(address);
    expect(
      (
        await prisma.userInvitation.findUniqueOrThrow({
          where: { id: invitation.id },
        })
      ).tokenHash,
    ).toBe(sha256(token));
    expect(token).not.toBe(previousToken);
  });

  it('simultaneous activations of one token: one success, every other attempt rejected', async () => {
    const address = email('race-driver');
    const token = mail.tokenFor(address);
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => activate(token, newPassword())),
    );
    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    const rejected = responses.filter((r) => r.status !== 200);
    expect(
      rejected.every(
        (r) =>
          r.status === 409 && r.body.code === 'INVITATION_ALREADY_ACCEPTED',
      ),
    ).toBe(true);
    const user = await userByEmail(address);
    expect(user.active).toBe(true);
    expect(await prisma.driver.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.userInvitation.count({
        where: { userId: user.id, status: 'ACCEPTED' },
      }),
    ).toBe(1);
  });
});

describe.sequential('Rate limits', () => {
  withApp();

  it('throttles activation (10/min), invitation creation (20/min) and resend (10/min) per IP', async () => {
    const statuses = async (count: number, send: () => request.Test) => {
      const result: number[] = [];
      for (let i = 0; i < count; i++) result.push((await send()).status);
      return result;
    };
    const activation = await statuses(11, () =>
      activate(randomBytes(32).toString('base64url'), newPassword()),
    );
    expect(activation.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(activation[10]).toBe(429);
    const creation = await statuses(21, () =>
      inviteAsAdmin(scenario.providerA.id, { email: 'invalid' }),
    );
    expect(creation.slice(0, 20).every((s) => s === 400)).toBe(true);
    expect(creation[20]).toBe(429);
    const missing = randomUUID();
    const resend = await statuses(11, () =>
      api()
        .post(`/api/v1/admin/user-invitations/${missing}/resend`)
        .auth(sa.accessToken, bearer),
    );
    expect(resend.slice(0, 10).every((s) => s === 404)).toBe(true);
    expect(resend[10]).toBe(429);
  });
});

describe('Database invariants', () => {
  it('rejects active users without password, a second PENDING invitation and edits of resolved invitations', async () => {
    await expect(
      prisma.user.create({
        data: {
          email: email('db-active'),
          role: 'DRIVER',
          active: true,
          passwordHash: null,
        },
      }),
    ).rejects.toThrow();
    const pending = await prisma.userInvitation.findFirstOrThrow({
      where: { email: email('no-login'), status: 'PENDING' },
    });
    const copy = {
      userId: pending.userId,
      email: pending.email,
      role: pending.role,
      providerId: pending.providerId,
      membershipRole: pending.membershipRole,
      driverName: pending.driverName,
      expiresAt: pending.expiresAt,
      tokenIssuedAt: pending.tokenIssuedAt,
      createdByUserId: pending.createdByUserId,
    };
    await expect(
      prisma.userInvitation.create({
        data: { ...copy, tokenHash: sha256(randomUUID()) },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.userInvitation.update({
        where: { id: pending.id },
        data: { providerId: scenario.providerB.id },
      }),
    ).rejects.toThrow(/USER_INVITATION_IMMUTABLE/);
    const accepted = await prisma.userInvitation.findFirstOrThrow({
      where: { email: email('provider-admin-real'), status: 'ACCEPTED' },
    });
    await expect(
      prisma.userInvitation.update({
        where: { id: accepted.id },
        data: { status: 'PENDING', acceptedAt: null },
      }),
    ).rejects.toThrow(/USER_INVITATION_IMMUTABLE/);
    await expect(
      prisma.userInvitation.create({
        data: {
          ...copy,
          role: 'SUPER_ADMIN',
          status: 'REVOKED',
          revokedAt: new Date(),
          tokenHash: sha256(randomUUID()),
        },
      }),
    ).rejects.toThrow();
  });
});

describe('Audit', () => {
  it('records provisioning events without tokens, hashes, passwords, emails or JWTs', () => {
    const events = new Set(
      logs.flatMap((line) => {
        const match = /"event":"([A-Z_]+)"/.exec(line);
        return match ? [match[1]] : [];
      }),
    );
    for (const event of [
      'USER_INVITED',
      'USER_INVITATION_RESENT',
      'USER_INVITATION_REVOKED',
      'USER_INVITATION_ACCEPTED',
      'USER_ACTIVATED',
      'PROVIDER_MEMBER_ADDED',
      'DRIVER_CREATED',
      'USER_INVITATION_EMAIL_SENT',
      'USER_INVITATION_EMAIL_FAILED',
      'USER_ACTIVATION_REJECTED',
    ])
      expect(events, event).toContain(event);
    expect(
      logs.some(
        (line) =>
          line.includes('"USER_INVITED"') &&
          line.includes('"targetUserId"') &&
          line.includes('"providerId"') &&
          line.includes('"actorId"'),
      ),
    ).toBe(true);
    const joined = logs.join('\n');
    const secrets = [
      ...mail.tokens(),
      ...mail.tokens().map(sha256),
      ...chosenPasswords,
      password,
      sa.accessToken,
      adminA.refreshToken,
      'activate-account?token',
      '$argon2id$',
    ];
    for (const secret of secrets)
      expect(joined.includes(secret), 'secret leaked to logs').toBe(false);
    expect(joined).not.toContain(`@test.local`);
  });
});
