import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import sharp from 'sharp';
import { VerificationService } from '../dist/verification/verification.service.js';
import { VerificationNotifications } from '../dist/verification/verification-notifications.js';
import type { DriverVerificationMail } from '../dist/mail/mail.types.js';
import type { CATEGORIES } from '../dist/verification/verification-rules.js';
import { digest } from '../dist/verification/verification-rules.js';
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  !new URL(url).pathname.endsWith('_test') ||
  new URL(url).port !== '55439'
)
  throw new Error('Dedicated verification cluster required');
process.env.DATABASE_URL = url;
process.env.NODE_ENV = 'test';
process.env.DRIVER_VERIFICATION_LOCAL_ENABLED = 'true';
process.env.MAIL_PROVIDER = 'local_outbox';
for (const name of [
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'INTEGRATION_JWT_SECRET',
])
  process.env[name] = randomBytes(48).toString('hex');
const db = new PrismaClient({ datasourceUrl: url });
const objects = new Map<string, Buffer>();
const messages: DriverVerificationMail[] = [];
let mailFail = false;
const storage = {
  async uploadUrl(key: string) {
    return 'https://synthetic.invalid/' + key;
  },
  async read(key: string) {
    const b = objects.get(key);
    if (!b) throw new Error('Missing');
    return b;
  },
  async write(key: string, b: Buffer) {
    objects.set(key, Buffer.from(b));
  },
  async remove(key: string) {
    objects.delete(key);
  },
};
const mail = {
  name: 'fake',
  async sendUserInvitation() {},
  async sendPartnerApplicationNotice() {},
  async sendDriverVerification(message: DriverVerificationMail) {
    if (mailFail) throw new Error('controlled failure');
    messages.push(message);
  },
};
let app: INestApplication;
let service: VerificationService;
let notices: VerificationNotifications;
let png: Buffer;
let admin: string,
  representative: string,
  otherRepresentative: string,
  fleetDriver: string,
  independent: string,
  provider: string,
  otherProvider: string,
  driverId: string,
  independentId: string,
  vehicleId: string;
let identityCase: string, unitCase: string;
const bearer = { type: 'bearer' } as const;
const email = () => `verification-${randomUUID()}@example.test`;
const token = (userId: string) =>
  app.get(JwtService).sign(
    { sub: userId, type: 'access' },
    {
      secret: process.env.JWT_ACCESS_SECRET,
      issuer: 'mandaria',
      audience: 'mandaria-users',
      expiresIn: '1h',
    },
  );
const accept = async (
  userId: string,
  scope: 'DRIVER' | 'FLEET',
  providerId?: string,
) => {
  const terms = await service.terms(userId, { scope, providerId });
  return service.acceptTerms(userId, randomUUID(), {
    scope,
    providerId,
    version: terms.version,
    hash: terms.hash,
    accepted: true,
    method: 'WEB_CHECKBOX_BUTTON',
  });
};
const identity = {
  fullName: 'Persona Sintética',
  contactPhone: '0000000000',
  operatingCity: 'Ciudad sintética',
  documentType: 'INE',
};
const unit = {
  declaredOwnerName: 'Titular Sintético',
  ownershipEvidenceType: 'OWNED',
  serialNumber: 'SYNTHETIC-001',
};
async function addFiles(
  userId: string,
  id: string,
  categories: (typeof CATEGORIES)[number][],
) {
  for (const category of categories) {
    const c = await service.getCase(userId, id);
    const upload = await service.upload(userId, randomUUID(), id, {
      expectedVersion: c.revision,
      category,
    });
    const a = await db.verificationAttachment.findUniqueOrThrow({
      where: { id: upload.id },
    });
    objects.set(a.quarantineKey, png);
    await service.complete(
      userId,
      randomUUID(),
      id,
      upload.id,
      upload.revision,
    );
  }
}
async function submitIdentity(
  userId: string,
  resourceId: string,
  license?: object,
) {
  const c = await service.createCase(userId, randomUUID(), {
    subjectType: 'DRIVER_IDENTITY',
    subjectId: resourceId,
  });
  await service.updateCase(userId, randomUUID(), c.id, {
    expectedVersion: c.revision,
    data: { ...identity, ...(license ? { license } : {}) },
  });
  await addFiles(userId, c.id, [
    'FACE_PHOTO',
    'INE_FRONT',
    'INE_BACK',
    ...(license ? ['LICENSE' as const] : []),
  ]);
  const current = await service.getCase(userId, c.id);
  return service.transition(
    userId,
    randomUUID(),
    c.id,
    current.revision,
    'SUBMIT',
  );
}
async function approve(id: string) {
  const c = await service.getCase(admin, id);
  const data = c.data as Record<string, unknown>;
  return service.decide(admin, randomUUID(), id, {
    expectedVersion: c.revision,
    decision: 'APPROVE',
    checklistVersion: 'LOCAL-TEST-1',
    passedChecks:
      c.subjectType === 'DRIVER_IDENTITY'
        ? [
            'IDENTITY_MATCH',
            'LEGIBLE',
            ...(data.license
              ? ['LICENSE_HOLDER', 'LICENSE_VALIDITY', 'LICENSE_CATEGORY']
              : []),
          ]
        : ['UNIT_MATCH', 'LEGIBLE', 'AUTHORIZED_USE'],
  });
}
async function eligible(d: string, v: string, local = true) {
  return db.$transaction(async (tx) => {
    if (local)
      await tx.$executeRaw`SELECT set_config('mandaria.verification_environment','LOCAL_TEST',true)`;
    const [r] = await tx.$queryRaw<
      { code: string | null }[]
    >`SELECT verification_eligibility(${d}::uuid,${v}::uuid) code`;
    return r.code;
  });
}
beforeAll(async () => {
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  const { MAIL_PROVIDER } = await import('../dist/mail/mail.types.js');
  const { VERIFICATION_STORAGE } =
    await import('../dist/verification/verification-storage.js');
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(mail)
    .overrideProvider(VERIFICATION_STORAGE)
    .useValue(storage)
    .compile();
  app = module.createNestApplication({ logger: false, bodyParser: false });
  setup(app);
  await app.init();
  service = app.get(VerificationService);
  notices = app.get(VerificationNotifications);
  notices.onModuleDestroy();
  png = await sharp({
    create: { width: 16, height: 16, channels: 3, background: '#55aacc' },
  })
    .png()
    .toBuffer();
  const user = async (role: 'SUPER_ADMIN' | 'PROVIDER_ADMIN' | 'DRIVER') =>
    (
      await db.user.create({
        data: {
          email: email(),
          passwordHash: 'synthetic-unusable-hash',
          role,
          active: true,
          emailVerifiedAt: new Date(),
        },
      })
    ).id;
  admin = await user('SUPER_ADMIN');
  representative = await user('PROVIDER_ADMIN');
  otherRepresentative = await user('PROVIDER_ADMIN');
  fleetDriver = await user('DRIVER');
  for (const [actor, other] of [
    [representative, false],
    [otherRepresentative, true],
  ] as const) {
    const p = await db.deliveryProvider.create({
      data: {
        name: 'Synthetic fleet',
        code: randomUUID(),
        type: 'FLEET',
        status: 'ACTIVE',
        maxDrivers: 10,
        maxVehicles: 10,
      },
    });
    await db.providerMembership.create({
      data: { userId: actor, providerId: p.id, role: 'OWNER' },
    });
    if (other) otherProvider = p.id;
    else provider = p.id;
  }
  driverId = (
    await db.driver.create({
      data: {
        providerId: provider,
        userId: fleetDriver,
        name: 'Synthetic driver',
        status: 'ACTIVE',
      },
    })
  ).id;
  vehicleId = (
    await db.vehicle.create({
      data: {
        providerId: provider,
        identifier: randomUUID().slice(0, 20).toUpperCase(),
        type: 'MOTORCYCLE',
        plate: 'SYNTHETIC',
        status: 'ACTIVE',
      },
    })
  ).id;
}, 30000);
afterAll(async () => {
  await db.verificationPolicy.update({
    where: { id: 1 },
    data: { enabled: false },
  });
  await app?.close();
  await db.$disconnect();
});
describe('Documentary onboarding / real PostgreSQL + controlled image and mail ports', () => {
  it('registers publicly without creating an identity before confirmation; consumes challenge only once', async () => {
    const address = email();
    await request(app.getHttpServer())
      .post('/api/v1/independent-driver-registrations')
      .send({ email: address })
      .expect(202);
    expect(await db.user.findUnique({ where: { email: address } })).toBeNull();
    const message = messages.find((m) => m.to === address)!;
    expect(message.token).toBeTruthy();
    const body = {
      token: message.token,
      password: randomBytes(20).toString('hex'),
      name: 'Synthetic independent',
    };
    await request(app.getHttpServer())
      .post('/api/v1/independent-driver-registrations/confirm')
      .send(body)
      .expect(200);
    const u = await db.user.findUniqueOrThrow({
      where: { email: address },
      include: { driver: { include: { independentProfile: true } } },
    });
    independent = u.id;
    independentId = u.driver!.id;
    expect(u.driver).toMatchObject({
      providerId: null,
      status: 'PENDING',
      availability: 'OFFLINE',
      independentProfile: { status: 'PENDING' },
    });
    await request(app.getHttpServer())
      .post('/api/v1/independent-driver-registrations/confirm')
      .send({ ...body, password: 'Different-long-password' })
      .expect(200);
    expect(
      (await db.user.findUniqueOrThrow({ where: { id: independent } }))
        .passwordHash,
    ).toBe(u.passwordHash);
  });
  it('rejects mass assignment and pending operational access; provider null is explicit', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/independent-driver-registrations')
      .send({ email: email(), role: 'SUPER_ADMIN' })
      .expect(400);
    const self = await request(app.getHttpServer())
      .get('/api/v1/driver/me')
      .auth(token(independent), bearer)
      .expect(200);
    expect(self.body.provider).toBeNull();
    await request(app.getHttpServer())
      .get('/api/v1/driver/dispatches/available')
      .auth(token(independent), bearer)
      .expect(409);
    await request(app.getHttpServer())
      .patch('/api/v1/driver/availability')
      .auth(token(independent), bearer)
      .send({ availability: 'AVAILABLE' })
      .expect(409);
  });
  it('requires personal acceptance and forbids representative impersonation', async () => {
    await expect(
      service.createCase(representative, randomUUID(), {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: driverId,
      }),
    ).rejects.toThrow('TERMS_ACCEPTANCE_REQUIRED');
    await expect(
      service.terms(representative, { scope: 'DRIVER' }),
    ).rejects.toThrow('VERIFICATION_FORBIDDEN');
    await accept(representative, 'FLEET', provider);
    await expect(
      service.createCase(representative, randomUUID(), {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: driverId,
      }),
    ).rejects.toThrow('TERMS_ACCEPTANCE_REQUIRED');
    await accept(fleetDriver, 'DRIVER');
    await accept(independent, 'DRIVER');
  });
  it('requires explicit true/current hash, records immutable test text, replays and recovers receipt', async () => {
    const terms = await service.terms(independent, { scope: 'DRIVER' });
    expect(terms.text).toContain('SIN VIGENCIA CONTRACTUAL');
    const key = randomUUID();
    const dto = {
      scope: 'DRIVER' as const,
      version: terms.version,
      hash: terms.hash,
      accepted: true as const,
      method: 'WEB_CHECKBOX_BUTTON' as const,
    };
    await request(app.getHttpServer())
      .post('/api/v1/verification-terms/accept')
      .auth(token(independent), bearer)
      .set('Idempotency-Key', key)
      .send({ ...dto, accepted: false })
      .expect(400);
    const result = await service.acceptTerms(independent, key, dto);
    expect(await service.acceptTerms(independent, key, dto)).toEqual(result);
    expect(
      await service.attempt(independent, key, {
        operation: 'ACCEPT_TERMS',
        target: 'DRIVER',
      }),
    ).toMatchObject({ state: 'APPLIED', result: { id: result.id } });
    await expect(
      service.acceptTerms(independent, randomUUID(), {
        ...dto,
        hash: 'a'.repeat(64),
      }),
    ).rejects.toThrow('TERMS_VERSION_CONFLICT');
    expect(
      (await service.acceptance(independent, result.id)).contractuallyEffective,
    ).toBe(false);
    await expect(
      db.verificationTerms.update({
        where: { version: terms.version },
        data: { text: 'changed' },
      }),
    ).rejects.toThrow('VERIFICATION_IMMUTABLE');
  });
  it('changes presented term version with explicit reacceptance, without rewriting old receipts', async () => {
    const pol = await db.verificationPolicy.findUniqueOrThrow({
      where: { id: 1 },
    });
    const terms = await service.terms(independent, { scope: 'DRIVER' });
    const next = terms.version + '-' + randomUUID();
    await db.verificationTerms.create({
      data: {
        version: next,
        scope: 'DRIVER',
        environment: 'LOCAL_TEST',
        text: terms.text + '\nNueva prueba',
        hash: digest(terms.text + '\nNueva prueba'),
      },
    });
    await db.verificationPolicy.update({
      where: { id: 1 },
      data: { driverTermsVersion: next },
    });
    await expect(
      service.acceptTerms(independent, randomUUID(), {
        scope: 'DRIVER',
        version: terms.version,
        hash: terms.hash,
        accepted: true,
        method: 'WEB_CHECKBOX_BUTTON',
      }),
    ).rejects.toThrow('TERMS_VERSION_CONFLICT');
    await accept(independent, 'DRIVER');
    await db.verificationPolicy.update({
      where: { id: 1 },
      data: { driverTermsVersion: pol.driverTermsVersion },
    });
  });
  it('scopes dossiers to resources and providers and closes a missing command before late arrival', async () => {
    await expect(
      service.createCase(otherRepresentative, randomUUID(), {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: driverId,
      }),
    ).rejects.toThrow('VERIFICATION_NOT_FOUND');
    const key = randomUUID();
    expect(
      await service.attempt(
        independent,
        key,
        { operation: 'CREATE_CASE', target: independentId },
        true,
      ),
    ).toEqual({ state: 'CLOSED_NO_EFFECTS' });
    await expect(
      service.createCase(independent, key, {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: independentId,
      }),
    ).rejects.toThrow('VERIFICATION_ATTEMPT_CLOSED');
  });
  it('serializes creation across different keys and rejects a second open case', async () => {
    const calls = await Promise.allSettled([
      service.createCase(independent, randomUUID(), {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: independentId,
      }),
      service.createCase(independent, randomUUID(), {
        subjectType: 'DRIVER_IDENTITY',
        subjectId: independentId,
      }),
    ]);
    expect(calls.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const c = calls.find((x) => x.status === 'fulfilled')!;
    if (c.status !== 'fulfilled') throw new Error();
    identityCase = c.value.id;
    await expect(
      service.getCase(otherRepresentative, identityCase),
    ).rejects.toThrow('VERIFICATION_NOT_FOUND');
  });
  it('enforces data/version validation and rejects arbitrary upload keys over HTTP', async () => {
    await expect(
      service.updateCase(independent, randomUUID(), identityCase, {
        expectedVersion: 1,
        data: { ...identity, approved: true },
      }),
    ).rejects.toThrow('VERIFICATION_DATA_INVALID');
    await service.updateCase(independent, randomUUID(), identityCase, {
      expectedVersion: 1,
      data: identity,
    });
    await expect(
      service.updateCase(independent, randomUUID(), identityCase, {
        expectedVersion: 1,
        data: identity,
      }),
    ).rejects.toThrow('VERIFICATION_VERSION_CONFLICT');
    await request(app.getHttpServer())
      .post(`/api/v1/verification-cases/${identityCase}/uploads`)
      .auth(token(independent), bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedVersion: 2,
        category: 'INE_FRONT',
        objectKey: 'other/person',
      })
      .expect(400);
  });
  it('rejects invalid bytes and non-owner finalize/access; normalizes server bytes and hashes', async () => {
    const a = await service.upload(independent, randomUUID(), identityCase, {
      expectedVersion: 2,
      category: 'FACE_PHOTO',
    });
    const row = await db.verificationAttachment.findUniqueOrThrow({
      where: { id: a.id },
    });
    objects.set(row.quarantineKey, Buffer.from('<html>evil</html>'));
    await expect(
      service.complete(
        independent,
        randomUUID(),
        identityCase,
        a.id,
        a.revision,
      ),
    ).rejects.toThrow('VERIFICATION_FILE_INVALID');
    objects.set(row.quarantineKey, png);
    await expect(
      service.complete(
        otherRepresentative,
        randomUUID(),
        identityCase,
        a.id,
        a.revision,
      ),
    ).rejects.toThrow('VERIFICATION_NOT_FOUND');
    const key = randomUUID();
    const completed = await service.complete(
      independent,
      key,
      identityCase,
      a.id,
      a.revision,
    );
    expect(
      await service.complete(independent, key, identityCase, a.id, a.revision),
    ).toEqual(completed);
    const saved = await db.verificationAttachment.findUniqueOrThrow({
      where: { id: a.id },
    });
    expect(saved.sourceHash).toBe(digest(png));
    expect(saved.hash).toBe(digest(objects.get(saved.objectKey)!));
    expect(saved.mime).toBe('image/png');
    await expect(
      service.attachment(otherRepresentative, identityCase, a.id),
    ).rejects.toThrow('VERIFICATION_NOT_FOUND');
    expect(await service.attachment(independent, identityCase, a.id)).toEqual(
      objects.get(saved.objectKey),
    );
  });
  it('requires a full dossier, freezes submitted data and exposes review only to SUPER_ADMIN', async () => {
    let c = await service.getCase(independent, identityCase);
    await expect(
      service.transition(
        independent,
        randomUUID(),
        identityCase,
        c.revision,
        'SUBMIT',
      ),
    ).rejects.toThrow('VERIFICATION_DOCUMENTS_PENDING');
    await addFiles(independent, identityCase, ['INE_FRONT', 'INE_BACK']);
    c = await service.getCase(independent, identityCase);
    const sub = await service.transition(
      independent,
      randomUUID(),
      identityCase,
      c.revision,
      'SUBMIT',
    );
    await expect(
      service.updateCase(independent, randomUUID(), identityCase, {
        expectedVersion: sub.revision,
        data: identity,
      }),
    ).rejects.toThrow('VERIFICATION_CASE_NOT_DRAFT');
    await request(app.getHttpServer())
      .post(`/api/v1/admin/verification-cases/${identityCase}/decision`)
      .auth(token(independent), bearer)
      .set('Idempotency-Key', randomUUID())
      .send({
        expectedVersion: sub.revision,
        decision: 'APPROVE',
        checklistVersion: 'LOCAL-TEST-1',
        passedChecks: ['IDENTITY_MATCH', 'LEGIBLE'],
      })
      .expect(403);
  });
  it('approves identity once, leaves availability OFFLINE, keeps immutable history and durable notification despite failed mail', async () => {
    const result = await approve(identityCase);
    expect(result.status).toBe('APPROVED');
    const d = await db.driver.findUniqueOrThrow({
      where: { id: independentId },
      include: { independentProfile: true },
    });
    expect(d).toMatchObject({
      status: 'ACTIVE',
      availability: 'OFFLINE',
      independentProfile: { status: 'APPROVED' },
    });
    mailFail = true;
    for (let batch = 0; batch < 20; batch++) {
      await notices.flush();
      if (
        (
          await db.verificationNotice.findFirstOrThrow({
            where: { caseId: identityCase },
          })
        ).attempts > 0
      )
        break;
    }
    mailFail = false;
    expect(
      await db.verificationNotice.findFirst({
        where: { caseId: identityCase },
      }),
    ).toMatchObject({
      status: 'PENDING',
      errorCode: 'MAIL_ACCEPTANCE_UNCONFIRMED',
    });
    expect((await service.getCase(independent, identityCase)).status).toBe(
      'APPROVED',
    );
    await expect(
      db.verificationCase.update({
        where: { id: identityCase },
        data: { data: {} },
      }),
    ).rejects.toThrow('VERIFICATION_CASE_IMMUTABLE');
  });
  it('creates a pending unit without circular operational approval and distinguishes all three ownership modes', async () => {
    const v = await service.createVehicle(independent, randomUUID(), {
      identifier: randomUUID().slice(0, 20).toUpperCase(),
      type: 'BICYCLE',
    });
    expect(v.status).toBe('INACTIVE');
    const c = await service.createCase(independent, randomUUID(), {
      subjectType: 'VEHICLE',
      subjectId: v.id,
    });
    unitCase = c.id;
    await service.updateCase(independent, randomUUID(), c.id, {
      expectedVersion: 1,
      data: unit,
    });
    await addFiles(independent, c.id, ['REGISTRATION_CARD', 'OWNERSHIP_PROOF']);
    const current = await service.getCase(independent, c.id);
    await service.transition(
      independent,
      randomUUID(),
      c.id,
      current.revision,
      'SUBMIT',
    );
    await approve(c.id);
    expect(await eligible(independentId, v.id)).toBeNull();
    expect(await eligible(independentId, v.id, false)).toBe(
      'VERIFICATION_TEST_RECEIPT_NOT_OPERATIONAL',
    );
    for (const ownershipEvidenceType of ['RENTED', 'BORROWED']) {
      const data = { ...unit, ownershipEvidenceType };
      const dataTypes =
        await import('../dist/verification/verification-rules.js');
      expect(dataTypes.categories(false, data)).toContain(
        ownershipEvidenceType === 'RENTED'
          ? 'RENTAL_CONTRACT'
          : 'OWNER_AUTHORIZATION',
      );
    }
  });
  it('preserves disabled legacy and durably blocks existing resources at activation without grandfathering', async () => {
    expect(await eligible(driverId, vehicleId)).toBeNull();
    const pol = await db.verificationPolicy.findUniqueOrThrow({
      where: { id: 1 },
    });
    await service.activation(admin, randomUUID(), {
      enabled: true,
      expectedVersion: pol.revision,
    });
    expect(await eligible(driverId, vehicleId)).toBe(
      'VERIFICATION_REVIEW_REQUIRED',
    );
  });
  it('separately reviews fleet identity and unit; a motorized pair without a license remains blocked', async () => {
    const c = await submitIdentity(representative, driverId);
    await approve(c.id);
    expect(await eligible(driverId, vehicleId)).toBe(
      'VERIFICATION_REVIEW_REQUIRED',
    );
    const v = await service.createCase(representative, randomUUID(), {
      subjectType: 'VEHICLE',
      subjectId: vehicleId,
    });
    await service.updateCase(representative, randomUUID(), v.id, {
      expectedVersion: 1,
      data: { ...unit, ownershipEvidenceType: 'RENTED' },
    });
    await addFiles(representative, v.id, [
      'REGISTRATION_CARD',
      'RENTAL_CONTRACT',
    ]);
    const cv = await service.getCase(representative, v.id);
    await service.transition(
      representative,
      randomUUID(),
      v.id,
      cv.revision,
      'SUBMIT',
    );
    await approve(v.id);
    expect(await eligible(driverId, vehicleId)).toBe('LICENSE_REQUIRED');
  });
  it('checks reviewer-confirmed license categories and preserves prior approval during renewal draft', async () => {
    const c = await submitIdentity(representative, driverId, {
      issuer: 'Synthetic',
      category: 'Synthetic category',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      vehicleTypes: ['CAR'],
    });
    await approve(c.id);
    expect(await eligible(driverId, vehicleId)).toBe(
      'LICENSE_CATEGORY_MISMATCH',
    );
    const next = await submitIdentity(representative, driverId, {
      issuer: 'Synthetic',
      category: 'Synthetic category',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      vehicleTypes: ['MOTORCYCLE'],
    });
    await approve(next.id);
    expect(await eligible(driverId, vehicleId)).toBeNull();
    const draft = await service.createCase(representative, randomUUID(), {
      subjectType: 'DRIVER_IDENTITY',
      subjectId: driverId,
    });
    expect(await eligible(driverId, vehicleId)).toBeNull();
    await service.transition(
      representative,
      randomUUID(),
      draft.id,
      1,
      'WITHDRAW',
    );
  });
  it('invalidates material edits and does not let test evidence authorize a production writer', async () => {
    expect(await eligible(driverId, vehicleId, false)).toBe(
      'VERIFICATION_TEST_RECEIPT_NOT_OPERATIONAL',
    );
    await db.vehicle.update({
      where: { id: vehicleId },
      data: { plate: 'CHANGED' },
    });
    expect(await eligible(driverId, vehicleId)).toBe(
      'VERIFICATION_REVALIDATION_REQUIRED',
    );
    await db.vehicle.update({
      where: { id: vehicleId },
      data: { plate: 'SYNTHETIC' },
    });
  });
  it('rechecks membership before replay and redacts reviewer-only notes', async () => {
    const c = await service.createCase(representative, randomUUID(), {
      subjectType: 'DRIVER_IDENTITY',
      subjectId: driverId,
    });
    await service.updateCase(representative, randomUUID(), c.id, {
      expectedVersion: 1,
      data: identity,
    });
    await addFiles(representative, c.id, [
      'FACE_PHOTO',
      'INE_FRONT',
      'INE_BACK',
    ]);
    let view = await service.getCase(representative, c.id);
    await service.transition(
      representative,
      randomUUID(),
      c.id,
      view.revision,
      'SUBMIT',
    );
    view = await service.getCase(admin, c.id);
    const key = randomUUID();
    await service.decide(admin, key, c.id, {
      expectedVersion: view.revision,
      decision: 'REJECT',
      checklistVersion: 'LOCAL-TEST-1',
      passedChecks: [],
      publicReason: 'Synthetic correction required',
      internalNote: 'ADMIN ONLY',
    });
    const publicView = await service.getCase(representative, c.id);
    expect(publicView).not.toHaveProperty('internalNote');
    expect(publicView).not.toHaveProperty('reviewerId');
    const terms = await service.terms(representative, {
      scope: 'FLEET',
      providerId: provider,
    });
    const k = randomUUID();
    const dto = {
      scope: 'FLEET' as const,
      providerId: provider,
      version: terms.version,
      hash: terms.hash,
      accepted: true as const,
      method: 'WEB_CHECKBOX_BUTTON' as const,
    };
    await service.acceptTerms(representative, k, dto);
    await db.providerMembership.deleteMany({
      where: { userId: representative, providerId: provider },
    });
    await expect(service.acceptTerms(representative, k, dto)).rejects.toThrow(
      'VERIFICATION_NOT_FOUND',
    );
    await db.providerMembership.create({
      data: { userId: representative, providerId: provider, role: 'OWNER' },
    });
  });
  it('serializes the durable cut behind an already admitted resource transaction', async () => {
    await db.verificationPolicy.update({
      where: { id: 1 },
      data: { enabled: false },
    });
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r)),
      release = new Promise<void>((r) => (unlock = r));
    const admission = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT verification_eligibility(${driverId}::uuid,${vehicleId}::uuid)`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await ready;
    const pol = await db.verificationPolicy.findUniqueOrThrow({
      where: { id: 1 },
    });
    let finished = false;
    const activation = service
      .activation(admin, randomUUID(), {
        enabled: true,
        expectedVersion: pol.revision,
      })
      .then(() => {
        finished = true;
      });
    await new Promise((r) => setTimeout(r, 75));
    expect(finished).toBe(false);
    unlock();
    await admission;
    await activation;
    expect(finished).toBe(true);
  });
  it('rejects direct malformed ownership and deletion of immutable receipts', async () => {
    await expect(
      db.verificationSubject.create({
        data: { driverId: randomUUID(), providerId: otherProvider },
      }),
    ).rejects.toThrow();
    const receipt = await db.verificationAcceptance.findFirstOrThrow({
      where: { userId: independent },
    });
    await expect(
      db.verificationAcceptance.delete({ where: { id: receipt.id } }),
    ).rejects.toThrow('VERIFICATION_IMMUTABLE');
    const c = await service.getCase(independent, unitCase);
    expect(c.attachments.every((a) => !('objectKey' in a))).toBe(true);
  });
});

describe('Verification expiry, scope and review races', () => {
  it('does not adopt a fleet identity into the same person’s independent dossier', async () => {
    const p = await db.independentDriverProfile.create({
      data: {
        driverId,
        status: 'APPROVED',
        approvedAt: new Date(),
        approvedByUserId: admin,
      },
    });
    const v = await service.createVehicle(fleetDriver, randomUUID(), {
      identifier: 'DUAL-' + randomUUID().slice(0, 10).toUpperCase(),
      type: 'BICYCLE',
    });
    expect(await eligible(driverId, v.id)).toBe('VERIFICATION_REVIEW_REQUIRED');
    const own = await service.createCase(fleetDriver, randomUUID(), {
      subjectType: 'DRIVER_IDENTITY',
      subjectId: driverId,
    });
    const view = await service.getCase(fleetDriver, own.id);
    expect(view.scope).toEqual({
      providerId: null,
      independentProfileId: p.id,
    });
    await expect(service.getCase(representative, own.id)).rejects.toThrow(
      'VERIFICATION_NOT_FOUND',
    );
    await service.transition(fleetDriver, randomUUID(), own.id, 1, 'WITHDRAW');
  });
  it('reviews borrowed units independently, and never lifts an administrative maintenance status', async () => {
    const v = await service.createVehicle(independent, randomUUID(), {
      identifier: 'BORROW-' + randomUUID().slice(0, 10).toUpperCase(),
      type: 'BICYCLE',
    });
    const c = await service.createCase(independent, randomUUID(), {
      subjectType: 'VEHICLE',
      subjectId: v.id,
    });
    await service.updateCase(independent, randomUUID(), c.id, {
      expectedVersion: 1,
      data: { ...unit, ownershipEvidenceType: 'BORROWED' },
    });
    await addFiles(independent, c.id, [
      'REGISTRATION_CARD',
      'OWNER_AUTHORIZATION',
    ]);
    const current = await service.getCase(independent, c.id);
    await service.transition(
      independent,
      randomUUID(),
      c.id,
      current.revision,
      'SUBMIT',
    );
    await db.vehicle.update({
      where: { id: v.id },
      data: { status: 'MAINTENANCE' },
    });
    await approve(c.id);
    expect(
      (await db.vehicle.findUniqueOrThrow({ where: { id: v.id } })).status,
    ).toBe('MAINTENANCE');
  });
  it('allows exactly one review when decisions race, with one immutable result and outbox per recipient', async () => {
    const draft = await service.createCase(independent, randomUUID(), {
      subjectType: 'DRIVER_IDENTITY',
      subjectId: independentId,
    });
    await service.updateCase(independent, randomUUID(), draft.id, {
      expectedVersion: 1,
      data: identity,
    });
    await addFiles(independent, draft.id, [
      'FACE_PHOTO',
      'INE_FRONT',
      'INE_BACK',
    ]);
    const c = await service.getCase(independent, draft.id);
    const sub = await service.transition(
      independent,
      randomUUID(),
      draft.id,
      c.revision,
      'SUBMIT',
    );
    const dto = {
      expectedVersion: sub.revision,
      decision: 'APPROVE' as const,
      checklistVersion: 'LOCAL-TEST-1',
      passedChecks: ['IDENTITY_MATCH', 'LEGIBLE'],
    };
    const results = await Promise.allSettled([
      service.decide(admin, randomUUID(), draft.id, dto),
      service.decide(admin, randomUUID(), draft.id, dto),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      await db.verificationNotice.count({ where: { caseId: draft.id } }),
    ).toBe(1);
  });
  it('evaluates license expiry after waiting for a resource lock, in UTC independently of database timezone', async () => {
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const submitted = await submitIdentity(representative, driverId, {
      issuer: 'Synthetic',
      category: 'Synthetic',
      expiresAt,
      vehicleTypes: ['MOTORCYCLE'],
    });
    await approve(submitted.id);
    expect(await eligible(driverId, vehicleId)).toBeNull();
    let unlock!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((r) => (locked = r)),
      release = new Promise<void>((r) => (unlock = r));
    const held = db.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Driver" WHERE id=${driverId}::uuid FOR UPDATE`;
        locked();
        await release;
      },
      { timeout: 10000 },
    );
    await ready;
    const pending = eligible(driverId, vehicleId);
    await new Promise((r) =>
      setTimeout(
        r,
        Math.max(0, new Date(expiresAt).getTime() - Date.now()) + 50,
      ),
    );
    unlock();
    await held;
    expect(await pending).toBe('LICENSE_EXPIRED');
  }, 15000);
});

describe('Existing accounts verify email without registration or password replacement', () => {
  it('binds verification to the authenticated account and preserves credentials and identity', async () => {
    const before = await db.user.findUniqueOrThrow({
      where: { id: otherRepresentative },
    });
    await db.user.update({
      where: { id: otherRepresentative },
      data: { emailVerifiedAt: null },
    });
    await expect(
      service.terms(otherRepresentative, {
        scope: 'FLEET',
        providerId: otherProvider,
      }),
    ).rejects.toThrow('VERIFICATION_EMAIL_REQUIRED');
    await request(app.getHttpServer())
      .post('/api/v1/verification-email/request')
      .auth(token(otherRepresentative), bearer)
      .send({})
      .expect(202);
    const message = messages.findLast(
      (m) => m.to === before.email && m.kind === 'EMAIL_VERIFICATION',
    )!;
    await expect(
      service.confirmEmail(representative, message.token!),
    ).rejects.toThrow('REGISTRATION_INVALID');
    await request(app.getHttpServer())
      .post('/api/v1/verification-email/confirm')
      .auth(token(otherRepresentative), bearer)
      .send({ token: message.token })
      .expect(200);
    await service.confirmEmail(otherRepresentative, message.token!);
    const after = await db.user.findUniqueOrThrow({
      where: { id: otherRepresentative },
    });
    expect(after.emailVerifiedAt).toBeTruthy();
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.role).toBe(before.role);
  });
});
