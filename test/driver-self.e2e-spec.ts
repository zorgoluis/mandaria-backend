import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, LoggerService } from '@nestjs/common';
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
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const password = randomBytes(24).toString('base64url');
const mail = (name: string) => `${name}-${run}@driver-self.test`.toLowerCase();
const emails = {
  adminA: mail('admin-a'),
  adminB: mail('admin-b'),
  noMembership: mail('admin-none'),
};
const codes = { providerA: `E2E_DA_${run}`, providerB: `E2E_DB_${run}` };
const ids = { sa: randomUUID(), carlos: randomUUID(), pedro: randomUUID() };
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
const integrationIds: string[] = [];
let app: INestApplication;
let scenario: Awaited<ReturnType<typeof seedLocalProviderAdmins>>;
let sa: string, adminA: string, carlosToken: string, pedroToken: string;
let carlos: { id: string }, pedro: { id: string }, vehicle: { id: string };
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;
const login = async (email: string) =>
  (await api().post('/api/v1/auth/login').send({ email, password }).expect(200))
    .body.accessToken as string;
const availability = (token: string, value: string, extra = {}) =>
  api()
    .patch('/api/v1/driver/availability')
    .auth(token, bearer)
    .send({ availability: value, ...extra });

beforeAll(async () => {
  const passwordHash = await argon2.hash(password);
  await prisma.user.createMany({
    data: [
      { id: ids.sa, email: mail('sa'), passwordHash, role: 'SUPER_ADMIN' },
      { id: ids.carlos, email: mail('carlos'), passwordHash, role: 'DRIVER' },
      { id: ids.pedro, email: mail('pedro'), passwordHash, role: 'DRIVER' },
    ],
  });
  scenario = await seedLocalProviderAdmins(prisma, { password, emails, codes });
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, { logger, bodyParser: false });
  setup(app);
  await app.init();
  sa = await login(mail('sa'));
  adminA = await login(emails.adminA);
  carlosToken = await login(mail('carlos'));
  pedroToken = await login(mail('pedro'));
}, 60000);

afterAll(async () => {
  await app?.close();
  const providerIds = [scenario?.providerA.id, scenario?.providerB.id].filter(
    Boolean,
  ) as string[];
  const where = { providerId: { in: providerIds } };
  await prisma.driverVehicleAssignment.deleteMany({ where });
  await prisma.driver.deleteMany({ where });
  await prisma.vehicle.deleteMany({ where });
  await prisma.providerMembership.deleteMany({ where });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.integrationClient.deleteMany({
    where: { id: { in: integrationIds } },
  });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          ...Object.values(ids),
          ...([
            scenario?.adminA.id,
            scenario?.adminB.id,
            scenario?.noMembership.id,
          ].filter(Boolean) as string[]),
        ],
      },
    },
  });
  await prisma.$disconnect();
});

describe.sequential(
  'V1.4 Driver self-service and IntegrationClient isolation',
  () => {
    it('DRIVER without a Driver profile gets 404; other roles cannot use /driver', async () => {
      await api()
        .get('/api/v1/driver/me')
        .auth(carlosToken, bearer)
        .expect(404);
      await availability(carlosToken, 'OFFLINE').expect(404);
      for (const token of [adminA, sa]) {
        await api().get('/api/v1/driver/me').auth(token, bearer).expect(403);
        await availability(token, 'AVAILABLE').expect(403);
      }
      await api().get('/api/v1/driver/me').expect(401);
    });

    it('resolves User → Driver → Provider → current vehicle with safe fields only', async () => {
      carlos = (
        await api()
          .post('/api/v1/provider/drivers')
          .auth(adminA, bearer)
          .send({ userId: ids.carlos, name: 'Carlos' })
          .expect(201)
      ).body;
      pedro = (
        await api()
          .post('/api/v1/provider/drivers')
          .auth(adminA, bearer)
          .send({ userId: ids.pedro, name: 'Pedro' })
          .expect(201)
      ).body;
      vehicle = (
        await api()
          .post('/api/v1/provider/vehicles')
          .auth(adminA, bearer)
          .send({ identifier: 'MOTO-01', type: 'MOTORCYCLE', plate: 'abc-123' })
          .expect(201)
      ).body;
      await api()
        .post(`/api/v1/provider/drivers/${carlos.id}/vehicle`)
        .auth(adminA, bearer)
        .send({ vehicleId: vehicle.id })
        .expect(201);
      const me = await api()
        .get('/api/v1/driver/me')
        .auth(carlosToken, bearer)
        .expect(200);
      expect(me.body).toMatchObject({
        id: carlos.id,
        name: 'Carlos',
        status: 'PENDING',
        availability: 'OFFLINE',
        provider: {
          id: scenario.providerA.id,
          name: 'Rápidos de Coita',
          status: 'ACTIVE',
        },
        currentAssignment: {
          vehicle: { id: vehicle.id, identifier: 'MOTO-01', plate: 'ABC-123' },
        },
      });
      expect(Object.keys(me.body).sort()).toEqual([
        'availability',
        'currentAssignment',
        'id',
        'name',
        'provider',
        'status',
      ]);
      const serialized = JSON.stringify(me.body);
      for (const forbidden of ['passwordHash', 'email', 'maxDrivers', 'userId'])
        expect(serialized).not.toContain(forbidden);
    });

    it('changes only its own availability and respects driver status', async () => {
      await availability(carlosToken, 'AVAILABLE')
        .expect(409)
        .expect((res) =>
          expect(res.body.message).toMatch(/Driver must be ACTIVE/),
        );
      for (const driver of [carlos, pedro])
        await api()
          .patch(`/api/v1/provider/drivers/${driver.id}`)
          .auth(adminA, bearer)
          .send({ status: 'ACTIVE' })
          .expect(200);
      const available = await availability(carlosToken, 'AVAILABLE').expect(
        200,
      );
      expect(available.body.availability).toBe('AVAILABLE');
      await availability(carlosToken, 'BUSY').expect(200);
      // Cannot target another driver: extra identifiers are rejected, and the body only
      // ever affects the authenticated driver.
      await availability(pedroToken, 'AVAILABLE', {
        driverId: carlos.id,
      }).expect(400);
      await availability(pedroToken, 'AVAILABLE', {
        userId: ids.carlos,
      }).expect(400);
      await availability(pedroToken, 'OFFLINE').expect(200);
      expect(
        (await prisma.driver.findUniqueOrThrow({ where: { id: carlos.id } }))
          .availability,
      ).toBe('BUSY');
      await availability(carlosToken, 'SLEEPING').expect(400);
      // Suspension forces OFFLINE and blocks AVAILABLE; OFFLINE remains allowed.
      await api()
        .patch(`/api/v1/provider/drivers/${carlos.id}`)
        .auth(adminA, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(200)
        .expect((res) => expect(res.body.availability).toBe('OFFLINE'));
      await availability(carlosToken, 'AVAILABLE').expect(409);
      await availability(carlosToken, 'OFFLINE').expect(200);
      const me = await api()
        .get('/api/v1/driver/me')
        .auth(carlosToken, bearer)
        .expect(200);
      expect(me.body.status).toBe('SUSPENDED');
      await api()
        .patch(`/api/v1/provider/drivers/${carlos.id}`)
        .auth(adminA, bearer)
        .send({ status: 'ACTIVE' })
        .expect(200);
    });

    it('suspended provider forces drivers OFFLINE and rejects AVAILABLE until reactivated', async () => {
      await availability(carlosToken, 'AVAILABLE').expect(200);
      const providerPath = `/api/v1/admin/providers/${scenario.providerA.id}`;
      await api().post(`${providerPath}/suspend`).auth(sa, bearer).expect(200);
      try {
        const me = await api()
          .get('/api/v1/driver/me')
          .auth(carlosToken, bearer)
          .expect(200);
        expect(me.body).toMatchObject({
          availability: 'OFFLINE',
          provider: { status: 'SUSPENDED' },
        });
        await availability(carlosToken, 'AVAILABLE')
          .expect(409)
          .expect((res) =>
            expect(res.body.message).toMatch(/Provider must be ACTIVE/),
          );
        await availability(carlosToken, 'BUSY').expect(409);
      } finally {
        await api()
          .post(`${providerPath}/activate`)
          .auth(sa, bearer)
          .expect(200);
      }
      await availability(carlosToken, 'AVAILABLE').expect(200);
    });

    it('DRIVER cannot administer providers, drivers or vehicles', async () => {
      const a = scenario.providerA.id;
      const denied: [string, string, object?][] = [
        ['get', '/api/v1/provider/drivers'],
        ['post', '/api/v1/provider/drivers', { userId: ids.pedro, name: 'X' }],
        [
          'patch',
          `/api/v1/provider/drivers/${pedro.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          `/api/v1/provider/drivers/${pedro.id}/vehicle`,
          { vehicleId: vehicle.id },
        ],
        ['delete', `/api/v1/provider/drivers/${carlos.id}/vehicle`],
        ['get', '/api/v1/provider/vehicles'],
        [
          'patch',
          `/api/v1/provider/vehicles/${vehicle.id}`,
          { status: 'SUSPENDED' },
        ],
        ['get', '/api/v1/provider/profile'],
        ['get', '/api/v1/provider/capacity'],
        ['get', '/api/v1/admin/providers'],
        ['get', `/api/v1/admin/providers/${a}/drivers`],
        [
          'patch',
          `/api/v1/admin/providers/${a}/drivers/${pedro.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          `/api/v1/admin/providers/${a}/vehicles`,
          { identifier: 'X', type: 'CAR' },
        ],
        ['get', '/api/v1/admin/integrations'],
      ];
      for (const [method, path, body] of denied) {
        const req = api()[method as 'get'](path).auth(carlosToken, bearer);
        const res = await (body ? req.send(body) : req);
        expect({ method, path, status: res.status }).toEqual({
          method,
          path,
          status: 403,
        });
      }
      expect(
        await prisma.driver.findUniqueOrThrow({ where: { id: pedro.id } }),
      ).toMatchObject({
        status: 'ACTIVE',
      });
    });

    it('IntegrationClient JWT cannot create, modify or assign Drivers/Vehicles (401)', async () => {
      const client = await api()
        .post('/api/v1/admin/integrations')
        .auth(sa, bearer)
        .send({ name: 'Fleet isolation', code: `E2E_FLEET_${run}` })
        .expect(201);
      integrationIds.push(client.body.id);
      const credential = await api()
        .post(`/api/v1/admin/integrations/${client.body.id}/credentials`)
        .auth(sa, bearer)
        .send({ scopes: ['deliveries:read', 'deliveries:create'] })
        .expect(201);
      secrets.push(credential.body.clientSecret);
      const token = (
        await api()
          .post('/api/v1/integrations/token')
          .send({
            clientId: credential.body.clientId,
            clientSecret: credential.body.clientSecret,
          })
          .expect(200)
      ).body.accessToken as string;
      const a = scenario.providerA.id;
      const attempts: [string, string, object?][] = [
        ['post', '/api/v1/provider/drivers', { userId: ids.pedro, name: 'X' }],
        [
          'patch',
          `/api/v1/provider/drivers/${pedro.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          '/api/v1/provider/vehicles',
          { identifier: 'B2B-1', type: 'CAR' },
        ],
        [
          'patch',
          `/api/v1/provider/vehicles/${vehicle.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          `/api/v1/provider/drivers/${pedro.id}/vehicle`,
          { vehicleId: vehicle.id },
        ],
        ['delete', `/api/v1/provider/drivers/${carlos.id}/vehicle`],
        [
          'post',
          `/api/v1/admin/providers/${a}/drivers`,
          { userId: ids.pedro, name: 'X' },
        ],
        [
          'patch',
          `/api/v1/admin/providers/${a}/drivers/${pedro.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          `/api/v1/admin/providers/${a}/vehicles`,
          { identifier: 'B2B-1', type: 'CAR' },
        ],
        [
          'patch',
          `/api/v1/admin/providers/${a}/vehicles/${vehicle.id}`,
          { status: 'SUSPENDED' },
        ],
        [
          'post',
          `/api/v1/admin/providers/${a}/drivers/${pedro.id}/vehicle`,
          { vehicleId: vehicle.id },
        ],
        ['get', '/api/v1/driver/me'],
        ['patch', '/api/v1/driver/availability', { availability: 'AVAILABLE' }],
      ];
      for (const [method, path, body] of attempts) {
        const req = api()[method as 'get'](path).auth(token, bearer);
        const res = await (body ? req.send(body) : req);
        expect({ method, path, status: res.status }).toEqual({
          method,
          path,
          status: 401,
        });
      }
      expect(
        await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicle.id } }),
      ).toMatchObject({
        status: 'ACTIVE',
      });
      expect(
        await prisma.vehicle.count({ where: { identifier: 'B2B-1' } }),
      ).toBe(0);
    });

    it('documents V1.4 schemas, permissions and errors, and logs events without secrets', async () => {
      const docs = (await api().get('/docs-json').expect(200)).body;
      expect(docs.info.version).toBe('1.4.0');
      for (const schema of [
        'DriverResponse',
        'VehicleResponse',
        'AssignmentResponse',
        'DriverSelfResponse',
        'ProviderCapacityResponse',
        'CreateVehicleDto',
      ])
        expect(docs.components.schemas[schema]).toBeDefined();
      expect(
        docs.components.schemas.CreateVehicleDto.properties.type.enum,
      ).toEqual([
        'BICYCLE',
        'MOTORCYCLE',
        'CAR',
        'PICKUP',
        'VAN',
        'TRUCK',
        'OTHER',
      ]);
      expect(
        docs.components.schemas.DriverResponse.properties.availability.enum,
      ).toEqual(['OFFLINE', 'AVAILABLE', 'BUSY']);
      const paths = Object.keys(docs.paths).filter((p) =>
        /\/(drivers|vehicles|driver\/|capacity)/.test(p),
      );
      expect(paths.length).toBeGreaterThanOrEqual(12);
      for (const path of paths)
        for (const operation of Object.values(docs.paths[path]) as {
          description: string;
          security: unknown[];
          responses: Record<string, unknown>;
          'x-roles'?: string[];
        }[]) {
          expect(operation.description.length).toBeGreaterThan(60);
          expect(operation.security).toEqual([{ bearer: [] }]);
          expect(operation['x-roles']?.length).toBe(1);
          for (const status of ['400', '401', '403', '429'])
            expect(operation.responses[status]).toBeDefined();
        }
      const allLogs = logs.join('\n');
      for (const event of [
        'DRIVER_CREATED',
        'DRIVER_STATUS_CHANGED',
        'DRIVER_AVAILABILITY_CHANGED',
        'VEHICLE_CREATED',
        'VEHICLE_ASSIGNED',
      ])
        expect(allLogs).toContain(event);
      expect(secrets.some((secret) => allLogs.includes(secret))).toBe(false);
    });
  },
);
