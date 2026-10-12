import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import { PrismaClient } from '@prisma/client';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
const url = process.env.TEST_DATABASE_URL;
if (!url || !new URL(url).pathname.endsWith('_test'))
  throw Error('Isolated test DB required');
Object.assign(process.env, {
  DATABASE_URL: url,
  NODE_ENV: 'test',
  JWT_ACCESS_SECRET: randomBytes(48).toString('hex'),
  JWT_REFRESH_SECRET: randomBytes(48).toString('hex'),
  INTEGRATION_JWT_SECRET: randomBytes(48).toString('hex'),
  MAIL_PROVIDER: 'local_outbox',
  MANDARIA_WEB_URL: 'https://web.mandaria.test',
  CUSTOMER_ADMISSION_ENABLED: 'true',
  PREQUOTE_ENABLED: 'true',
  PREQUOTE_CONVERSION_ENABLED: 'true',
  B2B_WEBHOOK_POLL_SECONDS: '0',
  DISPATCH_SEARCH_POLL_SECONDS: '0',
});
const db = new PrismaClient({ datasourceUrl: url });
let app: INestApplication;
const api = () => request(app.getHttpServer());
let admin: { id: string; token: string },
  otherAdmin: { id: string; token: string };
async function identity(
  role: 'CUSTOMER' | 'SUPER_ADMIN' | 'PROVIDER_ADMIN' = 'CUSTOMER',
) {
  const u = await db.user.create({
    data: {
      email: randomUUID() + '@business.test',
      role,
      passwordHash: 'synthetic-test-hash-not-used-for-login',
      emailVerifiedAt: new Date(),
    },
  });
  const token = await app
    .get(JwtService)
    .signAsync(
      { sub: u.id, type: 'access', sv: u.sessionVersion },
      {
        secret: process.env.JWT_ACCESS_SECRET,
        issuer: 'mandaria',
        audience: 'mandaria-users',
        expiresIn: 3600,
        algorithm: 'HS256',
      },
    );
  return { id: u.id, token };
}
async function customer() {
  const u = await identity();
  const c = await db.customerAccount.create({
    data: { userId: u.id, type: 'PERSONAL', displayName: 'Synthetic' },
  });
  return { ...u, accountId: c.id };
}
const form = (revision = 1) => ({
  expectedAccountRevision: revision,
  businessName: 'Synthetic store',
  activity: 'Food',
  city: 'Test zone',
  estimatedDeliveryVolume: '10 per week',
});
const post = (path: string, token: string, body: unknown, key = randomUUID()) =>
  api()
    .post('/api/v1/' + path)
    .auth(token, { type: 'bearer' })
    .set('Idempotency-Key', key)
    .send(body as object);
const get = (path: string, token: string) =>
  api()
    .get('/api/v1/' + path)
    .auth(token, { type: 'bearer' });
async function approved() {
  const c = await customer();
  const s = await post(
    'customer/business-applications',
    c.token,
    form(),
  ).expect(201);
  const d = await post(
    'admin/customer-business-applications/' + s.body.resourceId + '/decision',
    admin.token,
    {
      decision: 'APPROVE',
      expectedApplicationRevision: 1,
      expectedAccountRevision: 1,
    },
  ).expect(200);
  return {
    ...c,
    applicationId: s.body.resourceId as string,
    grantId: d.body.result.grantId as string,
  };
}
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  setup(app);
  await app.init();
  admin = await identity('SUPER_ADMIN');
  otherAdmin = await identity('SUPER_ADMIN');
}, 30000);
afterAll(async () => {
  await app?.close();
  await db.$disconnect();
});
describe('Business manual approval on isolated PostgreSQL', () => {
  it('blocks direct promotion and registration without reserving identity', async () => {
    const c = await customer();
    const r = await post('customer/profile/type', c.token, {
      type: 'BUSINESS',
      expectedRevision: 1,
    }).expect(409);
    expect(r.body.code).toBe('BUSINESS_APPROVAL_REQUIRED');
    expect(r.body.receipt.outcome).toBe('REJECTED');
    await api()
      .post('/api/v1/customer-registration')
      .send({
        email: randomUUID() + '@business.test',
        type: 'BUSINESS',
        displayName: 'No promotion',
      })
      .expect(409);
    await expect(
      db.customerAccount.update({
        where: { id: c.accountId },
        data: { type: 'BUSINESS', businessAccessState: 'ACTIVE' },
      }),
    ).rejects.toThrow();
  });
  it('atomically activates, replays historical approval, and exposes only public application fields', async () => {
    const c = await customer();
    const submitKey = randomUUID();
    const s = await post(
      'customer/business-applications',
      c.token,
      form(),
      submitKey,
    ).expect(201);
    expect(
      (await get('customer/capabilities', c.token)).body.businessAccess
        .canApply,
    ).toBe(false);
    const key = randomUUID(),
      path =
        'admin/customer-business-applications/' +
        s.body.resourceId +
        '/decision',
      body = {
        decision: 'APPROVE',
        expectedApplicationRevision: 1,
        expectedAccountRevision: 1,
        internalNote: 'PRIVATE_ADMIN_NOTE',
      };
    const d = await post(path, admin.token, body, key).expect(200);
    expect(d.body.result).toMatchObject({
      accountType: 'BUSINESS',
      accessState: 'ACTIVE',
      accountRevision: 2,
    });
    expect(
      (await post(path, admin.token, body, key).expect(200)).headers[
        'idempotent-replayed'
      ],
    ).toBe('true');
    const own = await get(
      'customer/business-applications/' + s.body.resourceId,
      c.token,
    ).expect(200);
    expect(JSON.stringify(own.body)).not.toContain('PRIVATE_ADMIN_NOTE');
    expect(own.body.snapshot.note).toBeNull();
    const view = await get(
      'admin/customer-business-access/' + c.accountId,
      admin.token,
    ).expect(200);
    expect(view.body.businessAccessAdministration.activeGrant.id).toBe(
      d.body.result.grantId,
    );
    const profile = await get('customer/profile', c.token).expect(200);
    expect(profile.body.customerAccountId).toBe(c.accountId);
    expect(profile.body.businessAccess.state).toBe('ACTIVE');
  });
  it('serializes simultaneous submits and administrator decisions without duplicate grants', async () => {
    const c = await customer();
    const submits = await Promise.all([
      post('customer/business-applications', c.token, form()),
      post('customer/business-applications', c.token, form()),
    ]);
    expect(submits.map((r) => r.status).sort()).toEqual([201, 409]);
    const id = submits.find((r) => r.status === 201)!.body.resourceId;
    const results = await Promise.all([
      post(
        'admin/customer-business-applications/' + id + '/decision',
        admin.token,
        {
          decision: 'APPROVE',
          expectedApplicationRevision: 1,
          expectedAccountRevision: 1,
        },
      ),
      post(
        'admin/customer-business-applications/' + id + '/decision',
        otherAdmin.token,
        {
          decision: 'REJECT',
          publicReason: 'Different decision',
          expectedApplicationRevision: 1,
          expectedAccountRevision: 1,
        },
      ),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await db.businessAccessGrant.count({
        where: { customerAccountId: c.accountId },
      }),
    ).toBeLessThanOrEqual(1);
  });
  it('records administrative rejection as APPLIED and supports corrected resubmission/withdrawal', async () => {
    const c = await customer();
    const s = await post(
      'customer/business-applications',
      c.token,
      form(),
    ).expect(201);
    const r = await post(
      'admin/customer-business-applications/' + s.body.resourceId + '/decision',
      admin.token,
      {
        decision: 'REJECT',
        expectedApplicationRevision: 1,
        expectedAccountRevision: 1,
        publicReason: 'Correct business details',
      },
    ).expect(200);
    expect(r.body.outcome).toBe('APPLIED');
    expect(r.body.result.applicationStatus).toBe('REJECTED');
    const next = await post('customer/business-applications', c.token, {
      ...form(),
      city: 'Corrected',
    }).expect(201);
    expect(next.body.resourceId).not.toBe(s.body.resourceId);
    await post(
      'customer/business-applications/' + next.body.resourceId + '/withdraw',
      c.token,
      { expectedApplicationRevision: 1 },
    ).expect(200);
    expect(
      (await get('customer/capabilities', c.token)).body.businessAccess
        .canApply,
    ).toBe(true);
  });
  it('requires SUPER_ADMIN readmission after revocation, even after descent, without activating', async () => {
    const c = await approved();
    await post(
      'admin/customer-business-access/' + c.accountId + '/revoke',
      admin.token,
      {
        grantId: c.grantId,
        expectedAccountRevision: 2,
        publicReason: 'Administrative review',
      },
    ).expect(200);
    const p = await get('customer/profile', c.token).expect(200);
    expect(p.body.type).toBe('PERSONAL');
    expect(p.body.businessAccess.reapplicationBlocked).toBe(true);
    const denied = await post(
      'customer/business-applications',
      c.token,
      form(3),
    ).expect(409);
    expect(denied.body.code).toBe('BUSINESS_REAPPLICATION_REQUIRES_ADMIN');
    const body = {
        revokedGrantId: c.grantId,
        expectedAccountRevision: 3,
        publicReason: 'May apply again',
      },
      path =
        'admin/customer-business-access/' +
        c.accountId +
        '/allow-reapplication';
    await post(path, c.token, body).expect(403);
    const key = randomUUID();
    const allow = await post(path, admin.token, body, key).expect(200);
    expect(allow.body.result).toMatchObject({
      accountType: 'PERSONAL',
      accessState: 'NONE',
      reapplicationBlocked: false,
      accountRevision: 4,
    });
    await post(path, admin.token, body, key).expect(200);
    await post('customer/business-applications', c.token, form(4)).expect(201);
    expect(
      await db.businessAccessGrant.count({
        where: { customerAccountId: c.accountId, status: 'ACTIVE' },
      }),
    ).toBe(0);
  });
  it('fences unknown attempts and does not close another actors command', async () => {
    const c = await customer(),
      key = randomUUID();
    expect(
      (
        await get(
          'customer/business-application-attempts/' + key + '?operation=SUBMIT',
          c.token,
        )
      ).body,
    ).toEqual({ state: 'NOT_OBSERVED', receipt: null });
    const close = await post(
      'customer/business-application-attempts/' + key + '/close',
      c.token,
      { operation: 'SUBMIT' },
    ).expect(200);
    expect(close.body.state).toBe('CLOSED');
    const late = await post(
      'customer/business-applications',
      c.token,
      form(),
      key,
    ).expect(409);
    expect(late.body.receipt.outcome).toBe('CLOSED');
    expect(
      await db.businessApplication.count({
        where: { customerAccountId: c.accountId },
      }),
    ).toBe(0);
    await get(
      'customer/business-application-attempts/' +
        key +
        '?operation=SUBMIT&target=null',
      c.token,
    ).expect(400);
    await post(
      'customer/business-application-attempts/' +
        randomUUID() +
        '/close?operation=SUBMIT',
      c.token,
      { operation: 'SUBMIT' },
    ).expect(400);
  });
  it('rejects ownership leaks and mismatched body keys; pagination has no fabricated totalPages', async () => {
    const c = await customer(),
      other = await customer(),
      key = randomUUID();
    const s = await post(
      'customer/business-applications',
      c.token,
      form(),
      key,
    ).expect(201);
    await get(
      'customer/business-applications/' + s.body.resourceId,
      other.token,
    ).expect(404);
    await get('admin/customer-business-applications', c.token).expect(403);
    const mismatch = await post(
      'customer/business-applications',
      c.token,
      { ...form(), city: 'Changed' },
      key,
    ).expect(409);
    expect(mismatch.body.receipt).toBeNull();
    const list = await get(
      'customer/business-applications?page=99&pageSize=1',
      c.token,
    ).expect(200);
    expect(list.body).toMatchObject({
      items: [],
      total: 1,
      page: 99,
      pageSize: 1,
    });
    expect(list.body.totalPages).toBeUndefined();
  });
  it('SQL rejects forged grants, history edits and clearing readmission without an authorized receipt', async () => {
    const c = await approved();
    await expect(
      db.businessApplication.update({
        where: { id: c.applicationId },
        data: { status: 'REJECTED' },
      }),
    ).rejects.toThrow();
    await expect(
      db.businessAccessEvent.deleteMany({
        where: { customerAccountId: c.accountId },
      }),
    ).rejects.toThrow();
    await post(
      'admin/customer-business-access/' + c.accountId + '/revoke',
      admin.token,
      {
        grantId: c.grantId,
        expectedAccountRevision: 2,
        publicReason: 'Review',
      },
    ).expect(200);
    await expect(
      db.customerAccount.update({
        where: { id: c.accountId },
        data: {
          businessReapplicationBlockedByGrantId: null,
          revision: { increment: 1 },
        },
      }),
    ).rejects.toThrow();
  });
  it('rate limits new submit/withdraw commands durably, without consuming replay or GET', async () => {
    const c = await customer(),
      key = randomUUID();
    await post('customer/business-applications', c.token, form(), key).expect(
      201,
    );
    for (let i = 0; i < 4; i++)
      await post('customer/business-applications', c.token, form()).expect(409);
    const limited = await post(
      'customer/business-applications',
      c.token,
      form(),
    ).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await post('customer/business-applications', c.token, form(), key).expect(
      201,
    );
    await get(
      'customer/business-application-attempts/' + key + '?operation=SUBMIT',
      c.token,
    ).expect(200);
  });
});
