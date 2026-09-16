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
const mail = (name: string) => `${name}-${run}@delivery-b2b.test`.toLowerCase();
const users = {
  sa: randomUUID(),
  providerAdmin: randomUUID(),
  driver: randomUUID(),
};
const clientIds: Record<string, string> = {};
const secrets: string[] = [password];
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
const human: Record<'sa' | 'providerAdmin' | 'driver', string> = {
  sa: '',
  providerAdmin: '',
  driver: '',
};
const b2b: Record<string, string> = {};
const path = '/api/v1/delivery-requests';
const admin = '/api/v1/admin/delivery-requests';
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;
async function bootstrap() {
  const instance = await NestFactory.create(
    (await import('../dist/app.module.js')).AppModule,
    { logger, bodyParser: false },
  );
  (await import('../dist/setup.js')).setup(instance);
  await instance.init();
  return instance;
}
const body = (overrides: Record<string, unknown> = {}, dropoff = {}) => ({
  externalReference: `ORDER-${run}`,
  stops: [
    {
      type: 'PICKUP',
      sequence: 1,
      address: 'Restaurante Centro, Av. Central 123',
      latitude: 16.753554,
      longitude: -93.115983,
      contactName: 'Restaurante',
      contactPhone: '9611000001',
    },
    {
      type: 'DROPOFF',
      sequence: 2,
      address: 'Cliente, Calle 5 Poniente 42',
      latitude: 16.759812,
      longitude: -93.109231,
      contactName: 'Cliente Final',
      contactPhone: '9611000002',
      ...dropoff,
    },
  ],
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
const create = (
  token: string,
  key: string = randomUUID(),
  payload: object = body(),
) =>
  api()
    .post(path)
    .auth(token, bearer)
    .set('Idempotency-Key', key)
    .send(payload);
const getOwn = (token: string, publicId: string) =>
  api().get(`${path}/${publicId}`).auth(token, bearer);
const cancel = (token: string, publicId: string, reason = 'Cliente canceló') =>
  api().post(`${path}/${publicId}/cancel`).auth(token, bearer).send({ reason });

beforeAll(async () => {
  const passwordHash = await argon2.hash(password);
  await prisma.user.createMany({
    data: [
      { id: users.sa, email: mail('sa'), passwordHash, role: 'SUPER_ADMIN' },
      {
        id: users.providerAdmin,
        email: mail('provider-admin'),
        passwordHash,
        role: 'PROVIDER_ADMIN',
      },
      { id: users.driver, email: mail('driver'), passwordHash, role: 'DRIVER' },
    ],
  });
  app = await bootstrap();
  for (const [name, email] of [
    ['sa', mail('sa')],
    ['providerAdmin', mail('provider-admin')],
    ['driver', mail('driver')],
  ] as const)
    human[name] = (
      await api()
        .post('/api/v1/auth/login')
        .send({ email, password })
        .expect(200)
    ).body.accessToken;
  const client = async (name: string) => {
    const res = await api()
      .post('/api/v1/admin/integrations')
      .auth(human.sa, bearer)
      .send({ name: `Delivery ${name}`, code: `E2E_DR_${name}_${run}` })
      .expect(201);
    clientIds[name] = res.body.id;
    return res.body.id as string;
  };
  const token = async (clientId: string, scopes: string[]) => {
    const credential = await api()
      .post(`/api/v1/admin/integrations/${clientId}/credentials`)
      .auth(human.sa, bearer)
      .send({ scopes })
      .expect(201);
    secrets.push(credential.body.clientSecret);
    return (
      await api()
        .post('/api/v1/integrations/token')
        .send({
          clientId: credential.body.clientId,
          clientSecret: credential.body.clientSecret,
        })
        .expect(200)
    ).body.accessToken as string;
  };
  const all = ['deliveries:create', 'deliveries:read', 'deliveries:cancel'];
  b2b.A = await token(await client('A'), all);
  b2b.B = await token(await client('B'), all);
  const scoped = await client('C');
  b2b.createOnly = await token(scoped, ['deliveries:create']);
  b2b.readOnly = await token(scoped, ['deliveries:read']);
  b2b.cancelOnly = await token(scoped, ['deliveries:cancel']);
  b2b.quotesOnly = await token(scoped, ['quotes:create']);
  b2b.D = await token(await client('D'), all);
  secrets.push(...Object.values(b2b));
  await app.close();
}, 90000);
beforeEach(async () => {
  app = await bootstrap();
});
afterEach(async () => {
  await app?.close();
});
afterAll(async () => {
  const ids = Object.values(clientIds);
  await prisma.deliveryRequest.deleteMany({
    where: { integrationClientId: { in: ids } },
  });
  await prisma.apiIdempotencyRecord.deleteMany({
    where: { integrationClientId: { in: ids } },
  });
  await prisma.integrationClient.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: Object.values(users) } } });
  await prisma.$disconnect();
});

describe.sequential(
  'V1.5 DeliveryRequests — B2B idempotency, isolation, scopes and admin',
  () => {
    it('generates unique MDR publicIds under concurrent creation', async () => {
      const results = await Promise.all(
        Array.from({ length: 20 }, () => create(b2b.A)),
      );
      expect(results.map((r) => r.status)).toEqual(Array(20).fill(201));
      const ids = results.map((r) => r.body.publicId as string);
      expect(new Set(ids).size).toBe(20);
      for (const id of ids) expect(id).toMatch(/^MDR-\d{6,}$/);
    });

    it('same key + same payload replays the same request; equivalent normalization also replays', async () => {
      const key = `same-${randomUUID()}`;
      const first = await create(b2b.A, key).expect(201);
      const again = await create(b2b.A, key).expect(200);
      expect(again.headers['idempotent-replayed']).toBe('true');
      expect(again.body).toEqual(first.body);
      const equivalent = body({
        financialContext: {
          goodsValue: 450,
          goodsPaymentMode: 'PREPAID',
          currency: 'mxn',
        },
      }) as ReturnType<typeof body>;
      equivalent.stops.reverse();
      const normalized = await create(b2b.A, key, equivalent).expect(200);
      expect(normalized.body.publicId).toBe(first.body.publicId);
      expect(
        await prisma.apiIdempotencyRecord.count({
          where: { integrationClientId: clientIds.A, key },
        }),
      ).toBe(1);
      const record = await prisma.apiIdempotencyRecord.findFirstOrThrow({
        where: { integrationClientId: clientIds.A, key },
      });
      expect(record).toMatchObject({
        operation: 'delivery_requests.create',
        resourceType: 'DeliveryRequest',
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(JSON.stringify(record)).not.toMatch(
        /Cliente|Restaurante|9611000002/,
      );
    });

    it('same key + different payload → 409 and the original request is untouched', async () => {
      const key = `diff-${randomUUID()}`;
      const first = await create(b2b.A, key).expect(201);
      const conflict = await create(
        b2b.A,
        key,
        body({}, { address: 'Otra dirección 99', latitude: 16.7 }),
      ).expect(409);
      expect(conflict.body.message).toMatch(/Idempotency-Key/);
      await create(
        b2b.A,
        key,
        body({ externalReference: 'ORDER-OTHER' }),
      ).expect(409);
      const detail = await getOwn(b2b.A, first.body.publicId).expect(200);
      expect(detail.body.stops[1].address).toBe('Cliente, Calle 5 Poniente 42');
      expect(detail.body.externalReference).toBe(`ORDER-${run}`);
    });

    it('the same key is independent per IntegrationClient', async () => {
      const key = `shared-${randomUUID()}`;
      const a = await create(b2b.A, key).expect(201);
      const b = await create(b2b.B, key).expect(201);
      expect(a.body.publicId).not.toBe(b.body.publicId);
      // Replaying under B resolves B's own record, never A's.
      await create(b2b.B, key).expect(200);
    });

    it('concurrent requests with the same key create exactly one DeliveryRequest', async () => {
      const key = `race-${randomUUID()}`;
      const results = await Promise.all(
        Array.from({ length: 10 }, () => create(b2b.A, key)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([
        200, 200, 200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      expect(new Set(results.map((r) => r.body.publicId)).size).toBe(1);
      const record = await prisma.apiIdempotencyRecord.findFirstOrThrow({
        where: { integrationClientId: clientIds.A, key },
      });
      expect(
        await prisma.deliveryRequest.count({
          where: { id: record.resourceId },
        }),
      ).toBe(1);
      const divergent = `race-diff-${randomUUID()}`;
      const mixed = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          create(b2b.A, divergent, body({ externalReference: `RACE-${i}` })),
        ),
      );
      expect(mixed.map((r) => r.status).sort()).toEqual([
        201, 409, 409, 409, 409, 409,
      ]);
      const winner = await prisma.apiIdempotencyRecord.findFirstOrThrow({
        where: { integrationClientId: clientIds.A, key: divergent },
      });
      expect(
        await prisma.deliveryRequest.count({
          where: { id: winner.resourceId },
        }),
      ).toBe(1);
    });

    it('externalReference is not unique: it can repeat, including after cancellation', async () => {
      const ref = `ORDER-1842-${run}`;
      const first = await create(
        b2b.A,
        randomUUID(),
        body({ externalReference: ref }),
      ).expect(201);
      await cancel(b2b.A, first.body.publicId).expect(200);
      const second = await create(
        b2b.A,
        randomUUID(),
        body({ externalReference: ref }),
      ).expect(201);
      const list = await api()
        .get(path)
        .query({ externalReference: ref })
        .auth(b2b.A, bearer)
        .expect(200);
      expect(list.body.total).toBe(2);
      expect(
        list.body.items.map((i: { status: string }) => i.status).sort(),
      ).toEqual(['CANCELLED', 'CREATED']);
      expect(second.body.publicId).not.toBe(first.body.publicId);
    });

    it('isolates IntegrationClients A and B (read, list and cancel)', async () => {
      const a1 = (await create(b2b.A).expect(201)).body.publicId;
      const b1 = (await create(b2b.B).expect(201)).body.publicId;
      await getOwn(b2b.A, a1).expect(200);
      await getOwn(b2b.A, b1).expect(404);
      await getOwn(b2b.B, b1).expect(200);
      await getOwn(b2b.B, a1).expect(404);
      const aList = await api()
        .get(path)
        .query({ publicId: b1 })
        .auth(b2b.A, bearer)
        .expect(200);
      expect(aList.body.total).toBe(0);
      const all = await api()
        .get(path)
        .query({ pageSize: 100 })
        .auth(b2b.A, bearer)
        .expect(200);
      expect(
        all.body.items.some((i: { publicId: string }) => i.publicId === b1),
      ).toBe(false);
      for (const item of all.body.items) {
        expect(item).not.toHaveProperty('integrationClientId');
        expect(item).not.toHaveProperty('stops');
      }
      await api()
        .get(path)
        .query({ integrationClientId: clientIds.B })
        .auth(b2b.A, bearer)
        .expect(400);
      await cancel(b2b.A, b1).expect(404);
      expect((await getOwn(b2b.B, b1).expect(200)).body.status).toBe('CREATED');
      await cancel(b2b.A, a1).expect(200);
      await getOwn(b2b.A, 'MDR-999999999').expect(404);
      await getOwn(b2b.A, 'not-a-public-id').expect(400);
    });

    it('enforces create, read and cancel scopes independently', async () => {
      const created = await create(b2b.createOnly).expect(201);
      const id = created.body.publicId;
      await api().get(path).auth(b2b.createOnly, bearer).expect(403);
      await getOwn(b2b.createOnly, id).expect(403);
      await cancel(b2b.createOnly, id).expect(403);

      await create(b2b.readOnly).expect(403);
      await getOwn(b2b.readOnly, id).expect(200);
      await api().get(path).auth(b2b.readOnly, bearer).expect(200);
      await cancel(b2b.readOnly, id).expect(403);

      await create(b2b.cancelOnly).expect(403);
      await getOwn(b2b.cancelOnly, id).expect(403);
      await api().get(path).auth(b2b.cancelOnly, bearer).expect(403);
      await cancel(b2b.cancelOnly, id).expect(200);

      for (const call of [
        () => create(b2b.quotesOnly),
        () => getOwn(b2b.quotesOnly, id),
        () => cancel(b2b.quotesOnly, id),
      ])
        expect((await call()).status).toBe(403);
    });

    it('a suspended IntegrationClient loses access with its already issued token', async () => {
      const created = (await create(b2b.D).expect(201)).body.publicId;
      await api()
        .patch(`/api/v1/admin/integrations/${clientIds.D}`)
        .auth(human.sa, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(204);
      try {
        await create(b2b.D).expect(401);
        await getOwn(b2b.D, created).expect(401);
        await api().get(path).auth(b2b.D, bearer).expect(401);
        await cancel(b2b.D, created).expect(401);
      } finally {
        await api()
          .patch(`/api/v1/admin/integrations/${clientIds.D}`)
          .auth(human.sa, bearer)
          .send({ status: 'ACTIVE' })
          .expect(204);
      }
      await getOwn(b2b.D, created).expect(200);
    });

    it('cancels CREATED once; repeating keeps the original reason and timestamp; no edit or delete', async () => {
      const id = (await create(b2b.A).expect(201)).body.publicId;
      await api()
        .post(`${path}/${id}/cancel`)
        .auth(b2b.A, bearer)
        .send({})
        .expect(400);
      await api()
        .post(`${path}/${id}/cancel`)
        .auth(b2b.A, bearer)
        .send({ reason: '  ' })
        .expect(400);
      const first = await cancel(
        b2b.A,
        id,
        'El cliente canceló el pedido',
      ).expect(200);
      expect(first.body).toMatchObject({
        status: 'CANCELLED',
        cancellationReason: 'El cliente canceló el pedido',
        cancelledAt: expect.any(String),
      });
      const again = await cancel(b2b.A, id, 'Otra razón').expect(200);
      expect(again.body.cancellationReason).toBe(
        'El cliente canceló el pedido',
      );
      expect(again.body.cancelledAt).toBe(first.body.cancelledAt);
      const raced = (await create(b2b.A).expect(201)).body.publicId;
      const parallel = await Promise.all([
        cancel(b2b.A, raced, 'uno'),
        cancel(b2b.A, raced, 'dos'),
      ]);
      expect(parallel.map((r) => r.status)).toEqual([200, 200]);
      expect(parallel[0].body.cancellationReason).toBe(
        parallel[1].body.cancellationReason,
      );
      expect(
        logs.filter(
          (l) => l.includes('DELIVERY_REQUEST_CANCELLED') && l.includes(raced),
        ),
      ).toHaveLength(1);
      await api()
        .patch(`${path}/${id}`)
        .auth(b2b.A, bearer)
        .send({ status: 'CREATED' })
        .expect(404);
      await api().delete(`${path}/${id}`).auth(b2b.A, bearer).expect(404);
      await api()
        .patch(`${admin}/${id}`)
        .auth(human.sa, bearer)
        .send({})
        .expect(404);
      await api().delete(`${admin}/${id}`).auth(human.sa, bearer).expect(404);
      await api().post(admin).auth(human.sa, bearer).send(body()).expect(404);
    });

    it('filters and paginates own requests by publicId, externalReference, status and date range', async () => {
      const ref = `FILTER-${run}`;
      const created = [];
      for (let i = 0; i < 3; i++)
        created.push(
          (
            await create(
              b2b.B,
              randomUUID(),
              body({ externalReference: ref }),
            ).expect(201)
          ).body,
        );
      await cancel(b2b.B, created[0].publicId).expect(200);
      const query = (q: Record<string, unknown>) =>
        api()
          .get(path)
          .query({ externalReference: ref, ...q })
          .auth(b2b.B, bearer);
      const page1 = await query({ pageSize: 2, page: 1 }).expect(200);
      const page2 = await query({ pageSize: 2, page: 2 }).expect(200);
      expect(page1.body).toMatchObject({
        total: 3,
        totalPages: 2,
        pageSize: 2,
      });
      expect(page2.body.items).toHaveLength(1);
      expect(
        (await query({ status: 'CANCELLED' }).expect(200)).body.total,
      ).toBe(1);
      expect(
        (
          await query({ publicId: created[1].publicId.toLowerCase() }).expect(
            200,
          )
        ).body.total,
      ).toBe(1);
      const from = new Date(
        Date.parse(created[0].requestedAt) - 1000,
      ).toISOString();
      const future = new Date(Date.now() + 3600_000).toISOString();
      expect(
        (await query({ requestedFrom: from, requestedTo: future }).expect(200))
          .body.total,
      ).toBe(3);
      expect(
        (await query({ requestedFrom: future }).expect(200)).body.total,
      ).toBe(0);
      await query({ requestedFrom: future, requestedTo: from }).expect(400);
      await query({ requestedFrom: 'yesterday' }).expect(400);
      await query({ status: 'DELIVERED' }).expect(400);
      await query({ pageSize: 101 }).expect(400);
    });

    it('SUPER_ADMIN lists, reads and cancels any request; cannot create, edit or delete', async () => {
      const a = (
        await create(
          b2b.A,
          randomUUID(),
          body({ externalReference: `ADMIN-${run}` }),
        ).expect(201)
      ).body;
      const b = (
        await create(
          b2b.B,
          randomUUID(),
          body({ externalReference: `ADMIN-${run}` }),
        ).expect(201)
      ).body;
      const list = await api()
        .get(admin)
        .query({ externalReference: `ADMIN-${run}` })
        .auth(human.sa, bearer)
        .expect(200);
      expect(list.body.total).toBe(2);
      expect(list.body.items[0]).toMatchObject({
        id: expect.any(String),
        integrationClient: { code: expect.stringMatching(/^E2E_DR_/) },
      });
      const onlyA = await api()
        .get(admin)
        .query({
          externalReference: `ADMIN-${run}`,
          integrationClientId: clientIds.A,
        })
        .auth(human.sa, bearer)
        .expect(200);
      expect(
        onlyA.body.items.map((i: { publicId: string }) => i.publicId),
      ).toEqual([a.publicId]);
      const detail = await api()
        .get(`${admin}/${b.publicId}`)
        .auth(human.sa, bearer)
        .expect(200);
      expect(detail.body).toMatchObject({
        publicId: b.publicId,
        integrationClientId: clientIds.B,
        stops: [{ type: 'PICKUP' }, { type: 'DROPOFF' }],
        financialContext: { goodsValue: '450.00' },
      });
      const cancelled = await api()
        .post(`${admin}/${b.publicId}/cancel`)
        .auth(human.sa, bearer)
        .send({ reason: 'Fraude detectado' })
        .expect(200);
      expect(cancelled.body.status).toBe('CANCELLED');
      expect(
        (await getOwn(b2b.B, b.publicId).expect(200)).body.cancellationReason,
      ).toBe('Fraude detectado');
      const event = logs.find(
        (l) =>
          l.includes('DELIVERY_REQUEST_CANCELLED') && l.includes(b.publicId),
      )!;
      expect(event).toContain('"actorType":"USER"');
      expect(event).toContain(users.sa);
      expect(
        (
          await api()
            .get(admin)
            .query({ status: 'CANCELLED', externalReference: `ADMIN-${run}` })
            .auth(human.sa, bearer)
            .expect(200)
        ).body.total,
      ).toBe(1);
      await api()
        .get(admin)
        .query({ integrationClientId: 'nope' })
        .auth(human.sa, bearer)
        .expect(400);
      await api()
        .get(`${admin}/MDR-999999999`)
        .auth(human.sa, bearer)
        .expect(404);
    });

    it('PROVIDER_ADMIN and DRIVER cannot access requests; human and B2B tokens are not interchangeable', async () => {
      const id = (await create(b2b.A).expect(201)).body.publicId;
      for (const token of [human.providerAdmin, human.driver]) {
        await api().get(admin).auth(token, bearer).expect(403);
        await api().get(`${admin}/${id}`).auth(token, bearer).expect(403);
        await api()
          .post(`${admin}/${id}/cancel`)
          .auth(token, bearer)
          .send({ reason: 'x' })
          .expect(403);
      }
      for (const token of [human.providerAdmin, human.driver, human.sa]) {
        await api().get(path).auth(token, bearer).expect(401);
        await getOwn(token, id).expect(401);
        await create(token).expect(401);
        await cancel(token, id).expect(401);
      }
      await api().get(admin).auth(b2b.A, bearer).expect(401);
      await api()
        .post(`${admin}/${id}/cancel`)
        .auth(b2b.A, bearer)
        .send({ reason: 'x' })
        .expect(401);
      await api().get(path).expect(401);
      expect((await getOwn(b2b.A, id).expect(200)).body.status).toBe('CREATED');
    });

    it('rate-limits creation per the existing throttler', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 61; i++)
        statuses.push(
          (await api().post(path).auth(b2b.A, bearer).send({})).status,
        );
      expect(statuses.slice(0, 60).every((s) => s !== 429)).toBe(true);
      expect(statuses[60]).toBe(429);
    });

    it('documents the B2B and admin contracts and audits without secrets or personal data', async () => {
      const docs = (await api().get('/docs-json').expect(200)).body;
      const createOp = docs.paths[path].post;
      expect(createOp['x-scopes']).toEqual(['deliveries:create']);
      expect(createOp.security).toEqual([{ 'integration-bearer': [] }]);
      expect(createOp.parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: 'Idempotency-Key',
            in: 'header',
            required: true,
          }),
        ]),
      );
      for (const status of ['200', '201', '400', '401', '403', '409', '429'])
        expect(createOp.responses[status]).toBeDefined();
      expect(docs.paths[path].get['x-scopes']).toEqual(['deliveries:read']);
      expect(docs.paths[`${path}/{publicId}/cancel`].post['x-scopes']).toEqual([
        'deliveries:cancel',
      ]);
      expect(docs.paths[admin].get['x-roles']).toEqual(['SUPER_ADMIN']);
      expect(docs.paths[`${path}/{publicId}`].patch).toBeUndefined();
      expect(docs.paths[`${path}/{publicId}`].delete).toBeUndefined();
      const schemas = docs.components.schemas;
      expect(
        schemas.DeliveryFinancialContextDto.properties.goodsPaymentMode.enum,
      ).toEqual(['PREPAID', 'COURIER_ADVANCE']);
      expect(schemas.DeliveryPackageDto.properties.category.enum).toContain(
        'MEDICINE',
      );
      expect(schemas.DeliveryStopDto.properties.type.enum).toEqual([
        'PICKUP',
        'DROPOFF',
      ]);
      expect(schemas.DeliveryRequestResponse.properties.status.enum).toEqual([
        'CREATED',
        'CANCELLED',
      ]);
      for (const forbidden of [
        'deliveryFee',
        'providerId',
        'driverId',
        'vehicleId',
      ])
        expect(JSON.stringify(schemas.CreateDeliveryRequestDto)).not.toContain(
          forbidden,
        );

      const allLogs = logs.join('\n');
      const created = logs.find(
        (l) =>
          l.includes('DELIVERY_REQUEST_CREATED') && l.includes(clientIds.A),
      )!;
      expect(created).toContain('"actorType":"INTEGRATION"');
      expect(allLogs).toContain('IDEMPOTENCY_CONFLICT');
      expect(allLogs).toContain('IDEMPOTENCY_REPLAY');
      for (const sensitive of [
        'Cliente Final',
        '9611000002',
        'Calle 5 Poniente',
        'Pedido preparado',
      ])
        expect(allLogs).not.toContain(sensitive);
      expect(secrets.some((secret) => allLogs.includes(secret))).toBe(false);
    });
  },
);
