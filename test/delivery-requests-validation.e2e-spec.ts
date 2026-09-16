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
const prisma = new PrismaClient({ datasourceUrl: databaseUrl });
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const password = randomBytes(24).toString('base64url');
const adminId = randomUUID();
const adminEmail = `sa-${run}@delivery-validation.test`.toLowerCase();
const clients: string[] = [];
const logs: string[] = [];
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
let token: string;
const path = '/api/v1/delivery-requests';
const api = () => request(app.getHttpServer());
const PII = {
  pickupAddress: `Restaurante ${run}, Av. Central 123`,
  dropoffAddress: `Casa ${run}, Calle 5 Poniente 42`,
  contactName: `Contacto ${run}`,
  contactPhone: '+52 961 555 0101',
};
async function bootstrap() {
  const instance = await NestFactory.create(
    (await import('../dist/app.module.js')).AppModule,
    { logger, bodyParser: false },
  );
  (await import('../dist/setup.js')).setup(instance);
  await instance.init();
  return instance;
}
const stop = (type: 'PICKUP' | 'DROPOFF', overrides = {}) => ({
  type,
  sequence: type === 'PICKUP' ? 1 : 2,
  address: type === 'PICKUP' ? PII.pickupAddress : PII.dropoffAddress,
  latitude: type === 'PICKUP' ? 16.753554 : 16.759812,
  longitude: type === 'PICKUP' ? -93.115983 : -93.109231,
  contactName: PII.contactName,
  contactPhone: PII.contactPhone,
  ...overrides,
});
const valid = (overrides: Record<string, unknown> = {}) => ({
  externalReference: `ORDER-${run}`,
  stops: [stop('PICKUP'), stop('DROPOFF')],
  packages: [
    { category: 'FOOD', description: 'Pedido preparado', quantity: 2 },
  ],
  financialContext: {
    goodsValue: '450.00',
    goodsPaymentMode: 'PREPAID',
    currency: 'MXN',
  },
  ...overrides,
});
const create = (body: unknown, key: string | null = randomUUID()) => {
  const req = api().post(path).auth(token, { type: 'bearer' });
  return (key === null ? req : req.set('Idempotency-Key', key)).send(
    body as object,
  );
};
const financial = (value: unknown, goodsPaymentMode = 'PREPAID', extra = {}) =>
  valid({
    financialContext: {
      ...(value === undefined ? {} : { goodsValue: value }),
      goodsPaymentMode,
      currency: 'MXN',
      ...extra,
    },
  });
const countForClient = () =>
  prisma.deliveryRequest.count({ where: { integrationClientId: clients[0] } });

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: adminId,
      email: adminEmail,
      passwordHash: await argon2.hash(password),
      role: 'SUPER_ADMIN',
    },
  });
  app = await bootstrap();
  const sa = (
    await api()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password })
      .expect(200)
  ).body.accessToken;
  const client = await api()
    .post('/api/v1/admin/integrations')
    .auth(sa, { type: 'bearer' })
    .send({ name: 'Delivery validation', code: `E2E_DV_${run}` })
    .expect(201);
  clients.push(client.body.id);
  const credential = await api()
    .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
    .auth(sa, { type: 'bearer' })
    .send({ scopes: ['deliveries:create', 'deliveries:read'] })
    .expect(201);
  token = (
    await api()
      .post('/api/v1/integrations/token')
      .send({
        clientId: credential.body.clientId,
        clientSecret: credential.body.clientSecret,
      })
      .expect(200)
  ).body.accessToken;
  await app.close();
}, 60000);
// A fresh application per case keeps the create throttle (60/min) out of the way.
beforeEach(async () => {
  app = await bootstrap();
});
afterEach(async () => {
  await app?.close();
});
afterAll(async () => {
  await prisma.$executeRawUnsafe(
    'DROP TRIGGER IF EXISTS e2e_force_package_failure ON "DeliveryPackage"',
  );
  await prisma.deliveryRequest.deleteMany({
    where: { integrationClientId: { in: clients } },
  });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: { in: clients } },
  });
  await prisma.integrationClient.deleteMany({ where: { id: { in: clients } } });
  await prisma.user.delete({ where: { id: adminId } });
  await prisma.$disconnect();
});

describe.sequential(
  'V1.5 DeliveryRequest creation contract and validation',
  () => {
    it('creates CREATED with MDR publicId, snapshots, packages and decimal money; hides internal ids', async () => {
      const res = await create(
        valid({ stops: [stop('DROPOFF'), stop('PICKUP')] }),
      ).expect(201);
      expect(res.headers['idempotent-replayed']).toBe('false');
      expect(res.body).toMatchObject({
        publicId: expect.stringMatching(/^MDR-\d{6,}$/),
        externalReference: `ORDER-${run}`,
        status: 'CREATED',
        cancelledAt: null,
        cancellationReason: null,
        stops: [
          { type: 'PICKUP', sequence: 1, latitude: 16.753554 },
          { type: 'DROPOFF', sequence: 2, longitude: -93.109231 },
        ],
        packages: [
          {
            category: 'FOOD',
            description: 'Pedido preparado',
            quantity: 2,
            weightKg: null,
            isFragile: false,
          },
        ],
        financialContext: {
          goodsValue: '450.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      });
      expect(Date.parse(res.body.requestedAt)).not.toBeNaN();
      for (const hidden of ['id', 'integrationClientId', 'integrationClient'])
        expect(res.body).not.toHaveProperty(hidden);
      const stored = await prisma.deliveryRequest.findUniqueOrThrow({
        where: { publicId: res.body.publicId },
        include: { financialContext: true, stops: true, packages: true },
      });
      expect(stored.integrationClientId).toBe(clients[0]);
      expect(stored.stops).toHaveLength(2);
      expect(stored.financialContext!.goodsValue!.toFixed(2)).toBe('450.00');
      const [column] = await prisma.$queryRaw<
        { data_type: string; numeric_scale: number }[]
      >`SELECT data_type, numeric_scale FROM information_schema.columns WHERE table_name = 'DeliveryFinancialContext' AND column_name = 'goodsValue'`;
      expect(column).toEqual({ data_type: 'numeric', numeric_scale: 2 });
    });

    it('requires a valid Idempotency-Key and never accepts ownership or server fields from the body', async () => {
      const before = await countForClient();
      await create(valid(), null).expect(400);
      await create(valid(), 'short').expect(400);
      await create(valid(), 'x'.repeat(256)).expect(400);
      for (const extra of [
        { integrationClientId: randomUUID() },
        { publicId: 'MDR-000001' },
        { status: 'CANCELLED' },
        { providerId: randomUUID() },
        { driverId: randomUUID() },
        { deliveryFee: '35.00' },
        { requestedAt: new Date().toISOString() },
      ])
        await create({ ...valid(), ...extra }).expect(400);
      expect(await countForClient()).toBe(before);
    });

    it('requires exactly one PICKUP (1) and one DROPOFF (2) with valid coordinates and contact data', async () => {
      const before = await countForClient();
      const invalidStops = [
        [stop('PICKUP')],
        [stop('PICKUP'), stop('DROPOFF'), stop('DROPOFF', { sequence: 2 })],
        [stop('PICKUP'), stop('PICKUP', { sequence: 2 })],
        [stop('DROPOFF', { sequence: 1 }), stop('DROPOFF')],
        [stop('PICKUP', { sequence: 2 }), stop('DROPOFF', { sequence: 1 })],
        [stop('PICKUP'), stop('DROPOFF', { sequence: 3 })],
        [stop('PICKUP', { sequence: 0 }), stop('DROPOFF')],
        [stop('PICKUP', { type: 'WAYPOINT' }), stop('DROPOFF')],
        [stop('PICKUP', { latitude: 90.5 }), stop('DROPOFF')],
        [stop('PICKUP'), stop('DROPOFF', { latitude: -91 })],
        [stop('PICKUP', { longitude: 180.1 }), stop('DROPOFF')],
        [stop('PICKUP'), stop('DROPOFF', { longitude: -181 })],
        [stop('PICKUP', { latitude: 'north' }), stop('DROPOFF')],
        [stop('PICKUP', { latitude: undefined }), stop('DROPOFF')],
        [stop('PICKUP', { address: undefined }), stop('DROPOFF')],
        [stop('PICKUP'), stop('DROPOFF', { address: '   ' })],
        [stop('PICKUP', { contactPhone: 'call me' }), stop('DROPOFF')],
        [stop('PICKUP', { contactName: '' }), stop('DROPOFF')],
        [stop('PICKUP', { restaurantId: randomUUID() }), stop('DROPOFF')],
      ];
      for (const stops of invalidStops) {
        const res = await create(valid({ stops }));
        expect({ stops: stops.length, status: res.status }).toEqual({
          stops: stops.length,
          status: 400,
        });
        expect(res.body.code).toBe('VALIDATION_ERROR');
      }
      await create(valid({ stops: 'pickup' })).expect(400);
      expect(await countForClient()).toBe(before);
      // Boundaries are valid.
      await create(
        valid({
          stops: [
            stop('PICKUP', { latitude: 90, longitude: -180 }),
            stop('DROPOFF', {
              latitude: -90,
              longitude: 180,
              instructions: 'Tocar timbre',
            }),
          ],
        }),
      ).expect(201);
    });

    it('requires at least one generic package with positive quantity, weight and dimensions', async () => {
      const before = await countForClient();
      const pkg = (overrides = {}) => ({
        category: 'PARCEL',
        description: 'Caja',
        quantity: 1,
        ...overrides,
      });
      for (const packages of [
        [],
        undefined,
        [pkg({ quantity: 0 })],
        [pkg({ quantity: 1.5 })],
        [pkg({ quantity: -2 })],
        [pkg({ weightKg: -1 })],
        [pkg({ weightKg: 0 })],
        [pkg({ lengthCm: 0 })],
        [pkg({ widthCm: -5 })],
        [pkg({ heightCm: 'tall' })],
        [pkg({ description: undefined })],
        [pkg({ description: '  ' })],
        [pkg({ category: 'BICYCLE' })],
        [pkg({ vehicleType: 'BICYCLE' })],
        [pkg({ unitPrice: '99.00' })],
        [pkg({ isFragile: 'yes' })],
      ]) {
        const res = await create(valid({ packages }));
        expect(res.status).toBe(400);
      }
      expect(await countForClient()).toBe(before);
      const multi = await create(
        valid({
          packages: [
            { category: 'FOOD', description: 'Pedido preparado', quantity: 2 },
            pkg({
              category: 'MEDICINE',
              quantity: 1,
              weightKg: 0.25,
              lengthCm: 10,
              widthCm: 8.5,
              heightCm: 4,
              isFragile: true,
              handlingInstructions: 'Mantener refrigerado',
            }),
          ],
        }),
      ).expect(201);
      expect(multi.body.packages).toHaveLength(2);
      expect(multi.body.packages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            category: 'MEDICINE',
            weightKg: 0.25,
            widthCm: 8.5,
            isFragile: true,
          }),
          expect.objectContaining({
            category: 'FOOD',
            weightKg: null,
            lengthCm: null,
          }),
        ]),
      );
    });

    it('validates PREPAID and COURIER_ADVANCE goods value with safe decimal money and ISO currency', async () => {
      const before = await countForClient();
      for (const [body, expected] of [
        [financial('450'), '450.00'],
        [financial(450), '450.00'],
        [financial(null), null],
        [financial(undefined), null],
        [financial('450', 'COURIER_ADVANCE'), '450.00'],
        [financial('0.01', 'COURIER_ADVANCE'), '0.01'],
        [financial('99.9', 'PREPAID', { currency: 'usd' }), '99.90'],
      ] as const) {
        const res = await create(body).expect(201);
        expect(res.body.financialContext.goodsValue).toBe(expected);
      }
      const created = await countForClient();
      expect(created - before).toBe(7);
      for (const body of [
        financial(null, 'COURIER_ADVANCE'),
        financial(undefined, 'COURIER_ADVANCE'),
        financial('0', 'COURIER_ADVANCE'),
        financial(0, 'COURIER_ADVANCE'),
        financial('0.00', 'PREPAID'),
        financial('-450', 'PREPAID'),
        financial('450.123', 'PREPAID'),
        financial(0.1 + 0.2, 'PREPAID'),
        financial('4.5e2', 'PREPAID'),
        financial('450', 'CASH'),
        financial('450', 'PREPAID', { currency: 'XYZ' }),
        financial('450', 'PREPAID', { currency: 'MXNN' }),
        financial('450', 'PREPAID', { currency: undefined }),
        financial('450', 'PREPAID', { deliveryFee: '30.00' }),
        valid({ financialContext: undefined }),
      ])
        await create(body).expect(400);
      expect(await countForClient()).toBe(created);
    });

    it('creates everything atomically: a failure while inserting packages leaves no rows and no consumed key', async () => {
      const marker = `FORCE_ROLLBACK_${run}`;
      await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION e2e_force_package_failure() RETURNS trigger AS $$
      BEGIN
        IF NEW.description = '${marker}' THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        'CREATE TRIGGER e2e_force_package_failure BEFORE INSERT ON "DeliveryPackage" FOR EACH ROW EXECUTE FUNCTION e2e_force_package_failure()',
      );
      const key = randomUUID();
      const before = await countForClient();
      const stopsBefore = await prisma.deliveryStop.count();
      try {
        const failed = await create(
          valid({
            packages: [
              { category: 'PARCEL', description: marker, quantity: 1 },
            ],
          }),
          key,
        ).expect(500);
        for (const value of Object.values(PII))
          expect(JSON.stringify(failed.body)).not.toContain(value);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS e2e_force_package_failure ON "DeliveryPackage"',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS e2e_force_package_failure()',
        );
      }
      expect(await countForClient()).toBe(before);
      expect(await prisma.deliveryStop.count()).toBe(stopsBefore);
      expect(
        await prisma.apiIdempotencyRecord.count({
          where: { integrationClientId: clients[0], key },
        }),
      ).toBe(0);
      // The key was not consumed by the rolled-back attempt.
      await create(valid(), key).expect(201);
    });

    it('never logs contact data, addresses or payloads', () => {
      const allLogs = logs.join('\n');
      expect(allLogs).toContain('DELIVERY_REQUEST_CREATED');
      for (const value of Object.values(PII))
        expect(allLogs).not.toContain(value);
      expect(allLogs).not.toContain('Pedido preparado');
    });
  },
);
