import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication, LoggerService } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';
import request from 'supertest';
import { FakeMailProvider } from './support/fake-mail.provider.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))
  throw new Error('Dedicated TEST_DATABASE_URL ending in _test required');
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = 'test';
process.env.JWT_ACCESS_SECRET = randomBytes(48).toString('hex');
process.env.JWT_REFRESH_SECRET = randomBytes(48).toString('hex');
process.env.INTEGRATION_JWT_SECRET = randomBytes(48).toString('hex');
process.env.MANDARIA_WEB_URL = 'https://app.mandaria.test';
process.env.MAIL_PROVIDER = 'local_outbox';
process.env.CORS_ORIGINS =
  'https://mandaria.com.mx,https://app.mandaria.com.mx';
// One nginx in front: the client IP comes from X-Forwarded-For, so each test can act as its own
// client and the 5/10 min limit is checked per IP rather than shared by every caller.
process.env.TRUST_PROXY_HOPS = '1';
process.env.PARTNER_APPLICATIONS_NOTIFY_EMAIL = 'operaciones@mandaria.test';

const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 12).toLowerCase();
const password = randomBytes(24).toString('base64url');
const mail = new FakeMailProvider();
const logs: string[] = [];
const captureLogger: LoggerService = {
  log: (m: unknown) => void logs.push(JSON.stringify(m)),
  warn: (m: unknown) => void logs.push(JSON.stringify(m)),
  error: (m: unknown) => void logs.push(JSON.stringify(m)),
  debug: () => undefined,
  verbose: () => undefined,
};
const users = {
  sa: { id: randomUUID(), email: `sa-${run}@test.local`, role: 'SUPER_ADMIN' },
  pa: {
    id: randomUUID(),
    email: `pa-${run}@test.local`,
    role: 'PROVIDER_ADMIN',
  },
} as const;
const providerIds: string[] = [];
let ipCounter = 0;
/** A distinct documentation-range client address per call site. */
const nextIp = () => `198.51.100.${++ipCounter}`;
let phoneCounter = 0;
/** Unique 10-digit phones for this run. */
const nextPhone = () =>
  `9${String(Date.now() % 1e5).padStart(5, '0')}${String(++phoneCounter).padStart(4, '0')}`;
const email = (name: string) => `${name}-${run}@solicitudes.test`;
const individual = (overrides: object = {}) => ({
  type: 'INDIVIDUAL',
  contactName: 'Ana López',
  phone: nextPhone(),
  email: email(`ind-${++phoneCounter}`),
  city: 'Tuxtla Gutiérrez',
  vehicleType: 'MOTORCYCLE',
  privacyAccepted: true,
  privacyNoticeVersion: '2026-10',
  ...overrides,
});
const fleet = (overrides: object = {}) =>
  individual({
    type: 'FLEET',
    vehicleType: 'CAR',
    fleetName: 'Mensajería del Sur',
    fleetUnits: 5,
    email: email(`fleet-${++phoneCounter}`),
    ...overrides,
  });

let app: INestApplication;
const api = () => request(app.getHttpServer());
const post = (body: object, ip = nextIp()) =>
  api()
    .post('/api/v1/public/partner-applications')
    .set('X-Forwarded-For', ip)
    .send(body);
type Session = { accessToken: string };
let sa: Session;
let pa: Session;

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
const login = async (address: string): Promise<Session> =>
  (
    await api()
      .post('/api/v1/auth/login')
      .set('X-Forwarded-For', nextIp())
      .send({ email: address, password })
      .expect(200)
  ).body;
const admin = (token = sa) => ({
  get: (path: string) =>
    api()
      .get(`/api/v1/admin/partner-applications${path}`)
      .auth(token.accessToken, { type: 'bearer' }),
  post: (path: string, body: object) =>
    api()
      .post(`/api/v1/admin/partner-applications${path}`)
      .auth(token.accessToken, { type: 'bearer' })
      .send(body),
});
const status = (reference: string, body: object) =>
  admin().post(`/${reference}/status`, body);
const rowOf = (reference: string) =>
  prisma.partnerApplication.findUniqueOrThrow({
    where: { publicId: reference },
  });

beforeAll(async () => {
  const passwordHash = await argon2.hash(password);
  for (const user of Object.values(users))
    await prisma.user.create({ data: { ...user, passwordHash } });
  app = await bootstrap();
  sa = await login(users.sa.email);
  pa = await login(users.pa.email);
}, 60000);

afterAll(async () => {
  await app?.close();
  const where = { email: { contains: run } };
  await prisma.partnerApplication.deleteMany({ where });
  const invited = await prisma.user.findMany({ where, select: { id: true } });
  await prisma.userInvitation.deleteMany({
    where: {
      OR: [
        { providerId: { in: providerIds } },
        { userId: { in: invited.map((u) => u.id) } },
      ],
    },
  });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.user.deleteMany({ where });
  await prisma.$disconnect();
});

describe.sequential('public capture', () => {
  it('202 for a new application: SOC reference, lead only, internal notice without personal data', async () => {
    const body = fleet();
    const userCount = await prisma.user.count();
    const providerCount = await prisma.deliveryProvider.count();
    const res = await post(body).expect(202);
    expect(res.body).toEqual({
      reference: expect.stringMatching(/^SOC-\d{6,}$/),
      status: 'RECEIVED',
    });
    expect(res.headers['x-request-id']).toBeTruthy();
    const row = await rowOf(res.body.reference);
    expect(row).toMatchObject({
      type: 'FLEET',
      status: 'RECEIVED',
      phone: body.phone,
      email: body.email,
      fleetName: 'Mensajería del Sur',
      fleetUnits: 5,
      source: 'LANDING',
      submissionCount: 1,
      privacyNoticeVersion: '2026-10',
    });
    // A lead never creates accounts or providers.
    expect(await prisma.user.count()).toBe(userCount);
    expect(await prisma.deliveryProvider.count()).toBe(providerCount);
    await new Promise((r) => setTimeout(r, 50));
    expect(mail.notices.at(-1)).toEqual({
      to: 'operaciones@mandaria.test',
      reference: res.body.reference,
      type: 'FLEET',
      city: 'Tuxtla Gutiérrez',
    });
  });

  it('202 duplicate by phone or by email: same reference, submissionCount grows, no new notice', async () => {
    const body = individual();
    const first = (await post(body).expect(202)).body.reference;
    const notices = mail.notices.length;
    const second = await post({
      ...body,
      email: email('other-address'),
    }).expect(202);
    expect(second.body).toEqual({ reference: first, status: 'RECEIVED' });
    expect((await rowOf(first)).submissionCount).toBe(2);
    const third = await post({ ...body, phone: nextPhone() }).expect(202);
    expect(third.body.reference).toBe(first);
    const row = await rowOf(first);
    expect(row.submissionCount).toBe(3);
    expect(row.lastSubmittedAt.getTime()).toBeGreaterThanOrEqual(
      row.createdAt.getTime(),
    );
    expect(mail.notices.length).toBe(notices);
  });

  it('two simultaneous identical submissions produce one row', async () => {
    const body = individual();
    const [a, b] = await Promise.all([post(body), post(body)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    expect(a.body.reference).toBe(b.body.reference);
    expect(
      await prisma.partnerApplication.count({ where: { phone: body.phone } }),
    ).toBe(1);
    expect((await rowOf(a.body.reference)).submissionCount).toBe(2);
  });

  it('closed or older than 30 days does not absorb: a new reference is issued', async () => {
    const body = individual();
    const old = (await post(body).expect(202)).body.reference;
    const past = new Date(Date.now() - 31 * 86_400_000);
    await prisma.partnerApplication.update({
      where: { publicId: old },
      data: { createdAt: past, lastSubmittedAt: past },
    });
    const fresh = (await post(body).expect(202)).body.reference;
    expect(fresh).not.toBe(old);
    await status(fresh, { status: 'DISCARDED', reviewNote: 'Prueba' }).expect(
      200,
    );
    const again = (await post(body).expect(202)).body.reference;
    expect(again).not.toBe(fresh);
    expect((await rowOf(old)).submissionCount).toBe(1);
  });

  it.each([
    ['type', { type: 'COMPANY' }],
    ['contactName', { contactName: 'A' }],
    ['phone', { phone: '96112345' }],
    ['email', { email: 'not-an-email' }],
    ['city', { city: 'X' }],
    ['vehicleType', { vehicleType: 'VAN' }],
    ['fleetName', { fleetName: 'Flota' }],
    ['fleetUnits', { fleetUnits: 3 }],
    ['privacyAccepted', { privacyAccepted: false }],
    ['privacyNoticeVersion', { privacyNoticeVersion: 'x'.repeat(21) }],
    ['unknown', { referrer: 'facebook' }],
  ])('400 VALIDATION_ERROR for %s', async (field, patch) => {
    const body = individual(patch);
    const res = await post(body).expect(400);
    expect(res.body).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(res.body.errors.join(' ')).toContain(
      field === 'unknown' ? 'referrer' : field,
    );
    expect(
      await prisma.partnerApplication.count({ where: { phone: body.phone } }),
    ).toBe(0);
  });

  it('400 for FLEET without fleet data and for an oversized body (413)', async () => {
    const res = await post(
      fleet({ fleetName: undefined, fleetUnits: undefined }),
    ).expect(400);
    expect(res.body.errors.join(' ')).toMatch(
      /fleetName.*fleetUnits|fleetUnits.*fleetName/s,
    );
    await post(individual({ contactName: 'x'.repeat(17_000) })).expect(413);
  });

  it('honeypot: 202 with a well-formed reference, nothing persisted, body never logged', async () => {
    const body = individual({
      website: 'https://spam.example',
      phone: '9990001111',
      contactName: 'Bot Spammer',
    });
    const before = logs.length;
    const res = await post(body).expect(202);
    expect(res.body).toEqual({
      reference: expect.stringMatching(/^SOC-\d{6}$/),
      status: 'RECEIVED',
    });
    expect(
      await prisma.partnerApplication.count({
        where: {
          OR: [
            { email: body.email },
            { publicId: res.body.reference, phone: body.phone },
          ],
        },
      }),
    ).toBe(0);
    const recent = logs.slice(before).join('\n');
    expect(recent).toContain('PARTNER_APPLICATION_HONEYPOT');
    for (const secret of [
      body.email,
      body.phone,
      'Bot Spammer',
      'spam.example',
    ])
      expect(recent).not.toContain(secret);
    // Even an otherwise invalid body gets the decoy answer.
    await post({ website: 'x', phone: 'nope' }).expect(202);
  });

  it('429 on the sixth submission from the same IP within 10 minutes; another IP is unaffected', async () => {
    const ip = nextIp();
    for (let i = 0; i < 5; i++) await post(individual(), ip).expect(202);
    const blocked = await post(individual(), ip).expect(429);
    expect(blocked.body).toMatchObject({ code: 'HTTP_429' });
    await post(individual(), nextIp()).expect(202);
  });

  it('logs never contain names, phones, emails or bodies', async () => {
    const all = logs.join('\n');
    expect(all).not.toContain('Ana López');
    expect(all).not.toContain('Mensajería del Sur');
    expect(all).not.toMatch(/solicitudes\.test/);
    expect(all).not.toMatch(/"phone"/);
  });

  it('CORS preflight from the landing origin is allowed; an unknown origin is not', async () => {
    const preflight = (origin: string) =>
      api()
        .options('/api/v1/public/partner-applications')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');
    const ok = await preflight('https://mandaria.com.mx');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(
      'https://mandaria.com.mx',
    );
    expect(ok.headers['access-control-allow-methods']).toContain('POST');
    expect(ok.headers['access-control-allow-headers']).toContain(
      'content-type',
    );
    const denied = await preflight('https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('PostgreSQL enforces the fleet CHECK and the reference format', async () => {
    const base = {
      publicId: `SOC-9${String(Date.now()).slice(-8)}`,
      contactName: 'Ana',
      phone: nextPhone(),
      email: email('db-check'),
      city: 'Tuxtla',
      vehicleType: 'CAR' as const,
      privacyNoticeVersion: '2026-10',
      privacyAcceptedAt: new Date(),
    };
    for (const data of [
      { ...base, type: 'FLEET' as const },
      { ...base, type: 'FLEET' as const, fleetName: 'Flota', fleetUnits: 1 },
      {
        ...base,
        type: 'INDIVIDUAL' as const,
        fleetName: 'Flota',
        fleetUnits: 3,
      },
      { ...base, type: 'INDIVIDUAL' as const, publicId: 'XYZ-1' },
      { ...base, type: 'INDIVIDUAL' as const, phone: '12345' },
      { ...base, type: 'INDIVIDUAL' as const, email: 'Upper@Test.Local' },
    ])
      await expect(prisma.partnerApplication.create({ data })).rejects.toThrow(
        /check constraint/i,
      );
  });
});

describe.sequential('admin review', () => {
  let fleetRef: string;
  let fleetEmail: string;
  let individualRef: string;

  beforeAll(async () => {
    const f = fleet({ fleetName: `Flota Admin ${run}` });
    fleetEmail = f.email;
    fleetRef = (await post(f).expect(202)).body.reference;
    individualRef = (
      await post(individual({ contactName: `Persona ${run}` })).expect(202)
    ).body.reference;
  });

  it('401 without token and 403 for a non SUPER_ADMIN', async () => {
    await api().get('/api/v1/admin/partner-applications').expect(401);
    await api()
      .post(`/api/v1/admin/partner-applications/${fleetRef}/status`)
      .send({ status: 'CONTACTED' })
      .expect(401);
    for (const res of [
      await admin(pa).get(''),
      await admin(pa).get(`/${fleetRef}`),
      await admin(pa).post(`/${fleetRef}/status`, { status: 'CONTACTED' }),
      await admin(pa).post(`/${fleetRef}/links`, { providerId: randomUUID() }),
    ])
      expect(res.status).toBe(403);
  });

  it('lists with pagination and filters by status, type and q', async () => {
    const page = await admin().get('?pageSize=2').expect(200);
    expect(page.body).toMatchObject({ page: 1, pageSize: 2 });
    expect(page.body.items.length).toBeLessThanOrEqual(2);
    expect(page.body.total).toBeGreaterThanOrEqual(2);
    const byName = await admin()
      .get(`?q=${encodeURIComponent(`flota admin ${run}`)}`)
      .expect(200);
    expect(
      byName.body.items.map((i: { reference: string }) => i.reference),
    ).toEqual([fleetRef]);
    const byRef = await admin().get(`?q=${fleetRef.toLowerCase()}`).expect(200);
    expect(byRef.body.items[0].reference).toBe(fleetRef);
    const byEmail = await admin().get(`?q=${fleetEmail}`).expect(200);
    expect(byEmail.body.total).toBe(1);
    const fleets = await admin()
      .get(`?type=FLEET&status=RECEIVED&q=${run}`)
      .expect(200);
    expect(
      fleets.body.items.every(
        (i: { type: string; status: string }) =>
          i.type === 'FLEET' && i.status === 'RECEIVED',
      ),
    ).toBe(true);
    await admin().get('?status=OPEN').expect(400);
  });

  it('detail returns the full application; unknown or malformed references are 404', async () => {
    const res = await admin().get(`/${fleetRef.toLowerCase()}`).expect(200);
    expect(res.body).toMatchObject({
      reference: fleetRef,
      type: 'FLEET',
      status: 'RECEIVED',
      email: fleetEmail,
      submissionCount: 1,
      providerId: null,
      invitationId: null,
      allowedTransitions: ['CONTACTED', 'REJECTED', 'DISCARDED'],
    });
    expect(res.body).not.toHaveProperty('id');
    for (const ref of ['SOC-999999999', 'nope'])
      expect((await admin().get(`/${ref}`).expect(404)).body.code).toBe(
        'PARTNER_APPLICATION_NOT_FOUND',
      );
  });

  it('valid and invalid transitions', async () => {
    const invalid = async (ref: string, body: object) =>
      expect((await status(ref, body).expect(409)).body.code).toBe(
        'PARTNER_APPLICATION_INVALID_TRANSITION',
      );
    await invalid(fleetRef, { status: 'APPROVED', reviewNote: 'directo' });
    await invalid(fleetRef, { status: 'RECEIVED' });
    const contacted = await status(fleetRef, {
      status: 'CONTACTED',
    }).expect(200);
    expect(contacted.body).toMatchObject({
      status: 'CONTACTED',
      statusChangedByUserId: users.sa.id,
      reviewNote: null,
    });
    expect(contacted.body.statusChangedAt).toBeTruthy();
    await invalid(fleetRef, { status: 'APPROVED' });
    const approved = await status(fleetRef, {
      status: 'APPROVED',
      reviewNote: 'Llamada de validación correcta',
    }).expect(200);
    expect(approved.body).toMatchObject({
      status: 'APPROVED',
      allowedTransitions: ['REJECTED'],
    });
    await invalid(fleetRef, { status: 'CONTACTED' });
    await status(fleetRef, { status: 'NOPE' }).expect(400);
    await status('SOC-999999999', { status: 'CONTACTED' }).expect(404);
    await status(individualRef, {
      status: 'REJECTED',
      reviewNote: 'Fuera de zona',
    }).expect(200);
    await invalid(individualRef, { status: 'CONTACTED' });
  });

  it('links: only on APPROVED, provider FLEET, invitation with the same email', async () => {
    const linkInvalid = async (ref: string, body: object) =>
      expect(
        (await admin().post(`/${ref}/links`, body).expect(409)).body.code,
      ).toBe('PARTNER_APPLICATION_LINK_INVALID');
    const providers = await Promise.all(
      (['FLEET', 'INDEPENDENT'] as const).map((type, i) =>
        prisma.deliveryProvider.create({
          data: {
            name: `Socio ${type} ${run}`,
            code: `E2E_SOC_${i}_${run.toUpperCase()}`,
            type,
            status: 'ACTIVE',
            maxDrivers: 10,
            maxVehicles: 10,
          },
        }),
      ),
    );
    providerIds.push(...providers.map((p) => p.id));
    const [fleetProvider, independentProvider] = providers;
    const invite = async (address: string) =>
      (
        await api()
          .post(`/api/v1/admin/providers/${fleetProvider.id}/invitations`)
          .auth(sa.accessToken, { type: 'bearer' })
          .send({
            email: address,
            role: 'PROVIDER_ADMIN',
            membershipRole: 'OWNER',
          })
          .expect(201)
      ).body.id as string;
    const matching = await invite(fleetEmail);
    const other = await invite(email('someone-else'));

    await admin().post(`/${fleetRef}/links`, {}).expect(400);
    await linkInvalid(individualRef, { invitationId: matching });
    await linkInvalid(fleetRef, { providerId: randomUUID() });
    await linkInvalid(fleetRef, { providerId: independentProvider.id });
    await linkInvalid(fleetRef, { invitationId: randomUUID() });
    await linkInvalid(fleetRef, { invitationId: other });
    const linked = await admin()
      .post(`/${fleetRef}/links`, {
        providerId: fleetProvider.id,
        invitationId: matching,
      })
      .expect(200);
    expect(linked.body).toMatchObject({
      status: 'APPROVED',
      providerId: fleetProvider.id,
      invitationId: matching,
    });
    // Linking changed nothing in the provider or the invitation.
    expect(
      await prisma.userInvitation.findUniqueOrThrow({
        where: { id: matching },
      }),
    ).toMatchObject({ status: 'PENDING', email: fleetEmail });
    // APPROVED -> REJECTED needs a note and keeps the links.
    await status(fleetRef, { status: 'REJECTED' }).expect(409);
    const rejected = await status(fleetRef, {
      status: 'REJECTED',
      reviewNote: 'Desistió',
    }).expect(200);
    expect(rejected.body).toMatchObject({
      status: 'REJECTED',
      providerId: fleetProvider.id,
      invitationId: matching,
      allowedTransitions: [],
    });
    await linkInvalid(fleetRef, { providerId: fleetProvider.id });
  });
});
