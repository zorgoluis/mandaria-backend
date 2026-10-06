import 'reflect-metadata';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
} from 'vitest';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import * as argon2 from 'argon2';
import type {
  CustomerAccessMail,
  MailProvider,
} from '../src/mail/mail.types.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Isolated test database required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.MANDARIA_WEB_URL = 'https://web.mandaria.test';
process.env.MAIL_PROVIDER = 'local_outbox';
process.env.CUSTOMER_ADMISSION_ENABLED = 'true';
process.env.B2B_WEBHOOK_POLL_SECONDS = '0';
const db = new PrismaClient({ datasourceUrl: url });
const prefix = randomUUID();
const password = randomBytes(24).toString('base64url');
const messages: CustomerAccessMail[] = [];
const mail: MailProvider = {
  name: 'synthetic-memory',
  sendUserInvitation: async () => {},
  sendPartnerApplicationNotice: async () => {},
  sendCustomerAccess: async (m) => {
    messages.push(m);
  },
};
let app: INestApplication;
const api = () => request(app.getHttpServer());
const email = (label: string) => `${label}-${prefix}@example.test`;
const tokenFor = (address: string) => {
  const m = messages.findLast((m) => m.to === address);
  if (!m) throw Error('Expected synthetic mail');
  return new URLSearchParams(new URL(m.actionUrl).hash.slice(1)).get('token')!;
};
const signup = (address: string, type = 'PERSONAL') =>
  api()
    .post('/api/v1/customer-registration')
    .send({ email: address, type, displayName: 'Synthetic Customer' });
const confirm = (token: string) =>
  api().post('/api/v1/customer-registration/confirm').send({ token, password });
const login = (address: string, secret = password) =>
  api().post('/api/v1/auth/login').send({ email: address, password: secret });
async function session(address: string) {
  await signup(address).expect(202);
  await confirm(tokenFor(address)).expect(201);
  return (await login(address).expect(200)).body as {
    accessToken: string;
    refreshToken: string;
  };
}

describe('Customer identity on PostgreSQL', () => {
  beforeAll(async () => {
    await db.$connect();
  });
  beforeEach(async () => {
    const { AppModule } = await import('../dist/app.module.js');
    const { setup } = await import('../dist/setup.js');
    const { MAIL_PROVIDER } = await import('../dist/mail/mail.types.js');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(MAIL_PROVIDER)
      .useValue(mail)
      .compile();
    app = module.createNestApplication({ logger: false, bodyParser: false });
    setup(app);
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  afterAll(async () => {
    await db.$disconnect();
  });
  it('does not create a user before email verification; creates CUSTOMER, not operational privileges', async () => {
    const address = email('personal');
    await signup(address).expect(202);
    expect(await db.user.findUnique({ where: { email: address } })).toBeNull();
    await confirm(tokenFor(address)).expect(201);
    const user = await db.user.findUniqueOrThrow({
      where: { email: address },
      include: { customerAccount: true },
    });
    expect(user.role).toBe('CUSTOMER');
    expect(user.emailVerifiedAt).not.toBeNull();
    expect(user.customerAccount?.type).toBe('PERSONAL');
    const s = (await login(address).expect(200)).body;
    await api()
      .get('/api/v1/admin/providers')
      .auth(s.accessToken, { type: 'bearer' })
      .expect(403);
    const profile = await api()
      .get('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .expect(200);
    expect(Object.keys(profile.body).sort()).toEqual([
      'active',
      'businessName',
      'displayName',
      'revision',
      'type',
    ]);
  });
  it('supports BUSINESS registration; rejects role injection', async () => {
    await signup(email('business'), 'BUSINESS').expect(202);
    await confirm(tokenFor(email('business'))).expect(201);
    expect(
      (
        await db.user.findUniqueOrThrow({
          where: { email: email('business') },
          include: { customerAccount: true },
        })
      ).customerAccount?.type,
    ).toBe('BUSINESS');
    await api()
      .post('/api/v1/customer-registration')
      .send({
        email: email('forged'),
        type: 'PERSONAL',
        displayName: 'X',
        role: 'SUPER_ADMIN',
      })
      .expect(400);
  });
  it('rejects unknown, expired and reused verification tokens', async () => {
    await confirm(randomBytes(32).toString('hex')).expect(400);
    const a = email('expired');
    await signup(a).expect(202);
    await db.customerChallenge.updateMany({
      where: { email: a },
      data: { expiresAt: new Date(0) },
    });
    await confirm(tokenFor(a)).expect(410);
    const b = email('reused');
    await signup(b).expect(202);
    const token = tokenFor(b);
    await confirm(token).expect(201);
    await confirm(token).expect(400);
  });
  it('serializes concurrent confirmations to exactly one account', async () => {
    const a = email('concurrent');
    await signup(a).expect(202);
    const token = tokenFor(a);
    const responses = await Promise.all([confirm(token), confirm(token)]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(
      await db.customerAccount.count({ where: { user: { email: a } } }),
    ).toBe(1);
  });
  it('resend replaces the pending token; duplicate registered email stays generic', async () => {
    const a = email('resend');
    await signup(a).expect(202);
    const old = tokenFor(a);
    await signup(a).expect(202);
    await confirm(old).expect(400);
    await confirm(tokenFor(a)).expect(201);
    const count = messages.length;
    const response = await signup(a).expect(202);
    expect(response.body).toEqual({ status: 'ACCEPTED' });
    expect(messages.length).toBe(count);
  });
  it('reset consumes token once and invalidates both access and refresh sessions', async () => {
    const a = email('reset'),
      s = await session(a);
    await api()
      .post('/api/v1/auth/password-recovery')
      .send({ email: a })
      .expect(202);
    const token = tokenFor(a),
      newPassword = randomBytes(24).toString('base64url');
    await api()
      .post('/api/v1/auth/password-reset')
      .send({ token, password: newPassword })
      .expect(200);
    await api()
      .get('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .expect(401);
    await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: s.refreshToken })
      .expect(401);
    await login(a).expect(401);
    await login(a, newPassword).expect(200);
    await api()
      .post('/api/v1/auth/password-reset')
      .send({ token, password: newPassword })
      .expect(400);
  });
  it('unknown recovery email is indistinguishable by response and sends no message', async () => {
    const count = messages.length;
    expect(
      (
        await api()
          .post('/api/v1/auth/password-recovery')
          .send({ email: email('missing') })
          .expect(202)
      ).body,
    ).toEqual({ status: 'ACCEPTED' });
    expect(messages.length).toBe(count);
  });
  it('keeps old refresh tokens without sv valid until an explicit reset', async () => {
    const address = email('old-refresh');
    const user = await db.user.create({
      data: {
        email: address,
        role: 'DRIVER',
        passwordHash: await argon2.hash(password),
      },
    });
    const id = randomUUID();
    const token = await new JwtService().signAsync(
      { sub: user.id, jti: id, type: 'refresh' },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        algorithm: 'HS256',
        issuer: 'mandaria',
        audience: 'mandaria-refresh',
        expiresIn: 300,
      },
    );
    await db.refreshToken.create({
      data: {
        id,
        userId: user.id,
        tokenHash: createHash('sha256').update(token).digest('hex'),
        expiresAt: new Date(Date.now() + 300000),
      },
    });
    const result = await api()
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: token })
      .expect(200);
    expect(new JwtService().decode(result.body.accessToken).sv).toBe(0);
  });
  it('a reset racing refresh leaves no usable session from the old generation', async () => {
    const address = email('reset-race'),
      s = await session(address);
    await api()
      .post('/api/v1/auth/password-recovery')
      .send({ email: address })
      .expect(202);
    const [reset, refresh] = await Promise.all([
      api()
        .post('/api/v1/auth/password-reset')
        .send({
          token: tokenFor(address),
          password: randomBytes(24).toString('base64url'),
        }),
      api().post('/api/v1/auth/refresh').send({ refreshToken: s.refreshToken }),
    ]);
    expect(reset.status).toBe(200);
    expect([200, 401]).toContain(refresh.status);
    if (refresh.status === 200) {
      await api()
        .get('/api/v1/customer/profile')
        .auth(refresh.body.accessToken, { type: 'bearer' })
        .expect(401);
      await api()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: refresh.body.refreshToken })
        .expect(401);
    }
    const u = await db.user.findUniqueOrThrow({ where: { email: address } });
    expect(
      await db.refreshToken.count({ where: { userId: u.id, revokedAt: null } }),
    ).toBe(0);
  });
  it('does not store the raw token and denies inactive users or profiles', async () => {
    const address = email('inactive'),
      s = await session(address),
      token = tokenFor(address);
    const rows = await db.customerChallenge.findMany({
      where: { email: address },
    });
    expect(JSON.stringify(rows).includes(token)).toBe(false);
    const u = await db.user.findUniqueOrThrow({ where: { email: address } });
    await db.customerAccount.update({
      where: { userId: u.id },
      data: { active: false },
    });
    await api()
      .get('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .expect(403);
    await db.user.update({ where: { id: u.id }, data: { active: false } });
    await api()
      .get('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .expect(401);
  });
  it('attaches verified operational user without changing role or invalidating legacy access token', async () => {
    const a = email('driver'),
      u = await db.user.create({
        data: {
          email: a,
          role: 'DRIVER',
          passwordHash: await argon2.hash(password),
          emailVerifiedAt: new Date(),
        },
      });
    const token = await new JwtService().signAsync(
      { sub: u.id, type: 'access' },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        algorithm: 'HS256',
        issuer: 'mandaria',
        audience: 'mandaria-users',
        expiresIn: 300,
      },
    );
    await api()
      .post('/api/v1/customer/profile')
      .auth(token, { type: 'bearer' })
      .send({ type: 'PERSONAL', displayName: 'Driver Customer' })
      .expect(201);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: u.id } })).role,
    ).toBe('DRIVER');
    await api()
      .get('/api/v1/customer/profile')
      .auth(token, { type: 'bearer' })
      .expect(200);
  });
  it('requires contact verification; another account cannot consume the token', async () => {
    const a = email('verify'),
      b = email('other');
    await db.user.create({
      data: {
        email: a,
        role: 'PROVIDER_ADMIN',
        passwordHash: await argon2.hash(password),
      },
    });
    const sa = (await login(a).expect(200)).body;
    const sb = await session(b);
    await api()
      .post('/api/v1/customer/profile')
      .auth(sa.accessToken, { type: 'bearer' })
      .send({ type: 'PERSONAL', displayName: 'X' })
      .expect(403);
    await api()
      .post('/api/v1/customer/contact-verification')
      .auth(sa.accessToken, { type: 'bearer' })
      .expect(202);
    const token = tokenFor(a);
    await api()
      .post('/api/v1/customer/contact-verification/confirm')
      .auth(sb.accessToken, { type: 'bearer' })
      .send({ token })
      .expect(400);
    await api()
      .post('/api/v1/customer/contact-verification/confirm')
      .auth(sa.accessToken, { type: 'bearer' })
      .send({ token })
      .expect(200);
    await api()
      .post('/api/v1/customer/profile')
      .auth(sa.accessToken, { type: 'bearer' })
      .send({ type: 'PERSONAL', displayName: 'X' })
      .expect(201);
  });
  it('blocks admission while preserving existing profile reads and uses profile revisions', async () => {
    const s = await session(email('flag'));
    app.get(ConfigService).set('CUSTOMER_ADMISSION_ENABLED', false);
    await signup(email('disabled')).expect(503);
    const read = () =>
      api()
        .get('/api/v1/customer/profile')
        .auth(s.accessToken, { type: 'bearer' });
    await read().expect(200);
    await api()
      .patch('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .send({ expectedRevision: 1, displayName: null })
      .expect(400);
    await api()
      .patch('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .send({ expectedRevision: 1, type: 'BUSINESS' })
      .expect(400);
    await api()
      .patch('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .send({ expectedRevision: 1, displayName: 'Updated' })
      .expect(200);
    await api()
      .patch('/api/v1/customer/profile')
      .auth(s.accessToken, { type: 'bearer' })
      .send({ expectedRevision: 1, displayName: 'Stale' })
      .expect(409);
  });
});
