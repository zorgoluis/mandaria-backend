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
const run = randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
const password = randomBytes(24).toString('base64url');
const mail = (name: string) => `${name}-${run}@fleet.test`.toLowerCase();
const emails = {
  adminA: mail('admin-a'),
  adminB: mail('admin-b'),
  noMembership: mail('admin-none'),
};
const codes = { providerA: `E2E_FA_${run}`, providerB: `E2E_FB_${run}` };
const superAdminId = randomUUID();
const createdProviders: string[] = [];
const driverUsers: string[] = [];
let app: INestApplication;
let scenario: Awaited<ReturnType<typeof seedLocalProviderAdmins>>;
let sa: string, adminA: string, adminB: string, noMembership: string;
const api = () => request(app.getHttpServer());
const bearer = { type: 'bearer' } as const;

async function login(email: string) {
  return (
    await api().post('/api/v1/auth/login').send({ email, password }).expect(200)
  ).body.accessToken as string;
}
async function driverUser() {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      id,
      email: mail(`driver-${id.slice(0, 8)}`),
      passwordHash: 'not-used-in-this-suite',
      role: 'DRIVER',
    },
  });
  driverUsers.push(id);
  return id;
}
const scoped = (path: string, providerId?: string) =>
  providerId
    ? `${path}${path.includes('?') ? '&' : '?'}providerId=${providerId}`
    : path;
async function providerDriver(
  token: string,
  providerId?: string,
  name = 'Driver',
) {
  return (
    await api()
      .post(scoped('/api/v1/provider/drivers', providerId))
      .auth(token, bearer)
      .send({ userId: await driverUser(), name })
      .expect(201)
  ).body;
}
async function providerVehicle(
  token: string,
  providerId?: string,
  data: Record<string, unknown> = {},
) {
  return (
    await api()
      .post(scoped('/api/v1/provider/vehicles', providerId))
      .auth(token, bearer)
      .send({
        identifier: `V-${randomUUID().slice(0, 8)}`,
        type: 'MOTORCYCLE',
        ...data,
      })
      .expect(201)
  ).body;
}
async function adminProvider(data: Record<string, unknown> = {}) {
  const res = await api()
    .post('/api/v1/admin/providers')
    .auth(sa, bearer)
    .send({
      name: 'Limits fixture',
      code: `E2E_L_${randomUUID().replaceAll('-', '').slice(0, 20).toUpperCase()}`,
      type: 'FLEET',
      ...data,
    })
    .expect(201);
  createdProviders.push(res.body.id);
  return res.body as { id: string };
}

beforeAll(async () => {
  await prisma.user.create({
    data: {
      id: superAdminId,
      email: mail('sa'),
      passwordHash: await argon2.hash(password),
      role: 'SUPER_ADMIN',
    },
  });
  scenario = await seedLocalProviderAdmins(prisma, { password, emails, codes });
  const { AppModule } = await import('../dist/app.module.js');
  const { setup } = await import('../dist/setup.js');
  app = await NestFactory.create(AppModule, {
    logger: false,
    bodyParser: false,
  });
  setup(app);
  await app.init();
  sa = await login(mail('sa'));
  adminA = await login(emails.adminA);
  adminB = await login(emails.adminB);
  noMembership = await login(emails.noMembership);
}, 60000);

afterAll(async () => {
  await app?.close();
  const providerIds = [
    scenario?.providerA.id,
    scenario?.providerB.id,
    ...createdProviders,
  ].filter(Boolean) as string[];
  const where = { providerId: { in: providerIds } };
  await prisma.driverVehicleAssignment.deleteMany({ where });
  await prisma.driver.deleteMany({ where });
  await prisma.vehicle.deleteMany({ where });
  await prisma.providerMembership.deleteMany({ where });
  await prisma.deliveryProvider.deleteMany({
    where: { id: { in: providerIds } },
  });
  await prisma.user.deleteMany({
    where: {
      id: {
        in: [
          superAdminId,
          ...driverUsers,
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
  'V1.4 Drivers & Vehicles — access, limits and assignments',
  () => {
    it('Admin A manages Drivers and Vehicles of Provider A (implicit and explicit providerId)', async () => {
      const driver = await providerDriver(adminA, undefined, '  Carlos  ');
      expect(driver).toMatchObject({
        providerId: scenario.providerA.id,
        name: 'Carlos',
        status: 'PENDING',
        availability: 'OFFLINE',
        currentAssignment: null,
        user: { role: 'DRIVER', active: true },
      });
      expect(JSON.stringify(driver)).not.toContain('passwordHash');
      const vehicle = await providerVehicle(adminA, scenario.providerA.id, {
        identifier: ' bici-01 ',
        type: 'BICYCLE',
        plate: null,
      });
      expect(vehicle).toMatchObject({
        providerId: scenario.providerA.id,
        identifier: 'BICI-01',
        type: 'BICYCLE',
        status: 'ACTIVE',
        plate: null,
      });
      const list = await api()
        .get('/api/v1/provider/drivers')
        .query({ search: 'carl', status: 'PENDING', availability: 'OFFLINE' })
        .auth(adminA, bearer)
        .expect(200);
      expect(list.body.items.map((d: { id: string }) => d.id)).toContain(
        driver.id,
      );
      expect(
        list.body.items.every(
          (d: { providerId: string }) => d.providerId === scenario.providerA.id,
        ),
      ).toBe(true);
      const vehicles = await api()
        .get('/api/v1/provider/vehicles')
        .query({
          providerId: scenario.providerA.id,
          type: 'BICYCLE',
          search: 'bici',
        })
        .auth(adminA, bearer)
        .expect(200);
      expect(vehicles.body.items.map((v: { id: string }) => v.id)).toEqual([
        vehicle.id,
      ]);
      await api()
        .get(`/api/v1/provider/drivers/${driver.id}`)
        .auth(adminA, bearer)
        .expect(200);
      const patched = await api()
        .patch(`/api/v1/provider/drivers/${driver.id}`)
        .auth(adminA, bearer)
        .send({ name: 'Carlos Pérez', status: 'ACTIVE' })
        .expect(200);
      expect(patched.body).toMatchObject({
        name: 'Carlos Pérez',
        status: 'ACTIVE',
      });
      const updatedVehicle = await api()
        .patch(`/api/v1/provider/vehicles/${vehicle.id}`)
        .auth(adminA, bearer)
        .send({ brand: 'Benotto', color: 'Azul', year: 2024 })
        .expect(200);
      expect(updatedVehicle.body).toMatchObject({
        brand: 'Benotto',
        year: 2024,
      });
      await api()
        .patch(`/api/v1/provider/vehicles/${vehicle.id}`)
        .auth(adminA, bearer)
        .send({ brand: null })
        .expect(200)
        .expect((res) => expect(res.body.brand).toBeNull());
      const capacity = await api()
        .get('/api/v1/provider/capacity')
        .auth(adminA, bearer)
        .expect(200);
      expect(capacity.body).toMatchObject({
        providerId: scenario.providerA.id,
        drivers: { count: 1, max: 10 },
        vehicles: { count: 1, max: 10 },
      });
    });

    it('rejects invalid driver/vehicle payloads, unknown fields and bad transitions', async () => {
      const userId = await driverUser();
      for (const body of [
        {},
        { userId, name: '' },
        { userId, name: '   ' },
        { userId: 'not-uuid', name: 'X' },
        { userId, name: 'X', providerId: scenario.providerB.id },
        { userId, name: 'X', status: 'ACTIVE' },
        { userId, name: 'X', password: 'nope' },
      ])
        await api()
          .post('/api/v1/provider/drivers')
          .auth(adminA, bearer)
          .send(body)
          .expect(400);
      for (const body of [
        { identifier: 'bad id!', type: 'CAR' },
        { identifier: 'CAR-01', type: 'SPACESHIP' },
        { identifier: 'CAR-01', type: 'CAR', year: 1800 },
        { identifier: 'CAR-01', type: 'CAR', status: 'BROKEN' },
        { identifier: 'CAR-01', type: 'CAR', driverId: randomUUID() },
        {
          identifier: 'CAR-01',
          type: 'CAR',
          providerId: scenario.providerB.id,
        },
      ])
        await api()
          .post('/api/v1/provider/vehicles')
          .auth(adminA, bearer)
          .send(body)
          .expect(400);
      const first = await providerVehicle(adminA, undefined, {
        identifier: 'DUP-01',
      });
      await api()
        .post('/api/v1/provider/vehicles')
        .auth(adminA, bearer)
        .send({ identifier: 'dup-01', type: 'CAR' })
        .expect(409);
      // Identifier is unique per provider only.
      await providerVehicle(adminB, undefined, { identifier: 'DUP-01' });
      await api()
        .patch(`/api/v1/provider/vehicles/${first.id}`)
        .auth(adminA, bearer)
        .send({})
        .expect(400);
      const driver = await providerDriver(adminA);
      await api()
        .post('/api/v1/provider/drivers')
        .auth(adminA, bearer)
        .send({ userId: driver.userId, name: 'Duplicate profile' })
        .expect(409);
      for (const userId of [scenario.adminA.id, superAdminId])
        await api()
          .post('/api/v1/provider/drivers')
          .auth(adminA, bearer)
          .send({ userId, name: 'Wrong role' })
          .expect(409);
      await api()
        .post('/api/v1/provider/drivers')
        .auth(adminA, bearer)
        .send({ userId: randomUUID(), name: 'Missing' })
        .expect(404);
      const path = `/api/v1/provider/drivers/${driver.id}`;
      await api()
        .patch(path)
        .auth(adminA, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await api()
        .patch(path)
        .auth(adminA, bearer)
        .send({ status: 'PENDING' })
        .expect(409);
      await api()
        .patch(path)
        .auth(adminA, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await api()
        .patch(path)
        .auth(adminA, bearer)
        .send({ status: 'ACTIVE' })
        .expect(200);
      await api()
        .patch(path)
        .auth(adminA, bearer)
        .send({ availability: 'AVAILABLE' })
        .expect(400);
    });

    it('isolates Provider A and B: foreign scope 403, foreign resource IDs 404', async () => {
      const driverB = await providerDriver(adminB, undefined, 'Mario');
      const vehicleB = await providerVehicle(adminB);
      const driverA = await providerDriver(adminA, undefined, 'Pedro');
      const vehicleA = await providerVehicle(adminA);
      for (const [token, foreign] of [
        [adminA, scenario.providerB.id],
        [adminB, scenario.providerA.id],
      ] as const) {
        for (const path of [
          '/api/v1/provider/drivers',
          '/api/v1/provider/vehicles',
        ]) {
          await api()
            .get(scoped(path, foreign))
            .auth(token, bearer)
            .expect(403);
          await api()
            .post(scoped(path, foreign))
            .auth(token, bearer)
            .send(
              path.endsWith('drivers')
                ? { userId: await driverUser(), name: 'Intruder' }
                : { identifier: 'INTRUDER-01', type: 'CAR' },
            )
            .expect(403);
        }
      }
      // Resource IDs from the other provider are invisible inside the caller's provider.
      for (const [token, driver, vehicle] of [
        [adminA, driverB, vehicleB],
        [adminB, driverA, vehicleA],
      ] as const) {
        await api()
          .get(`/api/v1/provider/drivers/${driver.id}`)
          .auth(token, bearer)
          .expect(404);
        await api()
          .patch(`/api/v1/provider/drivers/${driver.id}`)
          .auth(token, bearer)
          .send({ status: 'SUSPENDED' })
          .expect(404);
        await api()
          .get(`/api/v1/provider/vehicles/${vehicle.id}`)
          .auth(token, bearer)
          .expect(404);
        await api()
          .patch(`/api/v1/provider/vehicles/${vehicle.id}`)
          .auth(token, bearer)
          .send({ status: 'SUSPENDED' })
          .expect(404);
        await api()
          .get(`/api/v1/provider/drivers/${driver.id}/assignments`)
          .auth(token, bearer)
          .expect(404);
        await api()
          .delete(`/api/v1/provider/drivers/${driver.id}/vehicle`)
          .auth(token, bearer)
          .expect(404);
      }
      // Own driver + foreign vehicle: rejected by the provider-scoped lookup.
      await api()
        .post(`/api/v1/provider/drivers/${driverA.id}/vehicle`)
        .auth(adminA, bearer)
        .send({ vehicleId: vehicleB.id })
        .expect(404);
      // Client-supplied providerId naming the foreign provider cannot re-scope the request.
      await api()
        .post(
          scoped(
            `/api/v1/provider/drivers/${driverA.id}/vehicle`,
            scenario.providerB.id,
          ),
        )
        .auth(adminA, bearer)
        .send({ vehicleId: vehicleB.id })
        .expect(403);
      const lists = await api()
        .get('/api/v1/provider/drivers')
        .auth(adminB, bearer)
        .expect(200);
      expect(
        lists.body.items.every(
          (d: { providerId: string }) => d.providerId === scenario.providerB.id,
        ),
      ).toBe(true);
      // Unchanged after every rejected request.
      expect(
        await prisma.driver.findUniqueOrThrow({ where: { id: driverB.id } }),
      ).toMatchObject({ status: 'PENDING' });
      expect(
        await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleA.id } }),
      ).toMatchObject({ status: 'ACTIVE' });
      expect(
        await prisma.vehicle.count({ where: { identifier: 'INTRUDER-01' } }),
      ).toBe(0);
    });

    it('PROVIDER_ADMIN without membership cannot create or list Drivers/Vehicles', async () => {
      await api()
        .post('/api/v1/provider/drivers')
        .auth(noMembership, bearer)
        .send({ userId: await driverUser(), name: 'Nope' })
        .expect(403);
      await api()
        .get(scoped('/api/v1/provider/drivers', scenario.providerA.id))
        .auth(noMembership, bearer)
        .expect(403);
      await api()
        .post('/api/v1/provider/vehicles')
        .auth(noMembership, bearer)
        .send({ identifier: 'NOPE-01', type: 'CAR' })
        .expect(403);
      await api()
        .get(scoped('/api/v1/provider/vehicles', scenario.providerA.id))
        .auth(noMembership, bearer)
        .expect(403);
      await api()
        .get('/api/v1/provider/capacity')
        .auth(noMembership, bearer)
        .expect(403);
    });

    it('membership never replaces the global role check (defence in depth)', async () => {
      const membership = await prisma.providerMembership.create({
        data: {
          providerId: scenario.providerA.id,
          userId: scenario.noMembership.id,
          role: 'ADMIN',
        },
      });
      try {
        await api()
          .get(scoped('/api/v1/provider/drivers', scenario.providerA.id))
          .auth(noMembership, bearer)
          .expect(200);
        await prisma.user.update({
          where: { id: scenario.noMembership.id },
          data: { role: 'DRIVER' },
        });
        for (const path of [
          '/api/v1/provider/drivers',
          '/api/v1/provider/vehicles',
        ])
          await api()
            .get(scoped(path, scenario.providerA.id))
            .auth(noMembership, bearer)
            .expect(403);
      } finally {
        await prisma.user.update({
          where: { id: scenario.noMembership.id },
          data: { role: 'PROVIDER_ADMIN' },
        });
        await prisma.providerMembership.delete({
          where: { id: membership.id },
        });
      }
    });

    it('SUPER_ADMIN administers Drivers/Vehicles of A and B and sees usage without N+1', async () => {
      for (const provider of [scenario.providerA, scenario.providerB]) {
        const base = `/api/v1/admin/providers/${provider.id}`;
        const driver = (
          await api()
            .post(`${base}/drivers`)
            .auth(sa, bearer)
            .send({ userId: await driverUser(), name: 'Admin created' })
            .expect(201)
        ).body;
        const vehicle = (
          await api()
            .post(`${base}/vehicles`)
            .auth(sa, bearer)
            .send({ identifier: `SA-${randomUUID().slice(0, 6)}`, type: 'VAN' })
            .expect(201)
        ).body;
        await api()
          .get(`${base}/drivers`)
          .auth(sa, bearer)
          .query({ status: 'PENDING' })
          .expect(200);
        await api()
          .get(`${base}/drivers/${driver.id}`)
          .auth(sa, bearer)
          .expect(200);
        await api()
          .patch(`${base}/drivers/${driver.id}`)
          .auth(sa, bearer)
          .send({ status: 'ACTIVE' })
          .expect(200);
        await api()
          .get(`${base}/vehicles`)
          .auth(sa, bearer)
          .query({ type: 'VAN' })
          .expect(200);
        await api()
          .patch(`${base}/vehicles/${vehicle.id}`)
          .auth(sa, bearer)
          .send({ status: 'MAINTENANCE' })
          .expect(200);
        const capacity = await api()
          .get(`${base}/capacity`)
          .auth(sa, bearer)
          .expect(200);
        expect(capacity.body.drivers.count).toBe(
          await prisma.driver.count({ where: { providerId: provider.id } }),
        );
      }
      const list = await api()
        .get('/api/v1/admin/providers')
        .query({ search: run })
        .auth(sa, bearer)
        .expect(200);
      const itemA = list.body.items.find(
        (p: { id: string }) => p.id === scenario.providerA.id,
      );
      expect(itemA.usage).toEqual({
        drivers: {
          count: await prisma.driver.count({
            where: { providerId: scenario.providerA.id },
          }),
          max: 10,
        },
        vehicles: {
          count: await prisma.vehicle.count({
            where: { providerId: scenario.providerA.id },
          }),
          max: 10,
        },
      });
      const missing = `/api/v1/admin/providers/${randomUUID()}`;
      await api().get(`${missing}/drivers`).auth(sa, bearer).expect(404);
      await api().get(`${missing}/vehicles`).auth(sa, bearer).expect(404);
      await api()
        .post(`${missing}/vehicles`)
        .auth(sa, bearer)
        .send({ identifier: 'X-1', type: 'CAR' })
        .expect(404);
      // PROVIDER_ADMIN cannot use the SUPER_ADMIN surface, even for its own provider.
      const own = `/api/v1/admin/providers/${scenario.providerA.id}`;
      await api().get(`${own}/drivers`).auth(adminA, bearer).expect(403);
      await api()
        .post(`${own}/vehicles`)
        .auth(adminA, bearer)
        .send({ identifier: 'X-1', type: 'CAR' })
        .expect(403);
      await api().get(`${own}/capacity`).auth(adminA, bearer).expect(403);
    });

    it('enforces maxDrivers/maxVehicles counting every status and blocks lowering limits below usage', async () => {
      const provider = await adminProvider({ maxDrivers: 3, maxVehicles: 3 });
      const base = `/api/v1/admin/providers/${provider.id}`;
      const drivers = [];
      for (const name of ['Carlos', 'Pedro', 'José'])
        drivers.push(
          (
            await api()
              .post(`${base}/drivers`)
              .auth(sa, bearer)
              .send({ userId: await driverUser(), name })
              .expect(201)
          ).body,
        );
      await api()
        .post(`${base}/drivers`)
        .auth(sa, bearer)
        .send({ userId: await driverUser(), name: 'Luis' })
        .expect(409)
        .expect((res) => expect(res.body.message).toMatch(/driver limit/));
      for (const identifier of ['MOTO-01', 'MOTO-02', 'BICI-01'])
        await api()
          .post(`${base}/vehicles`)
          .auth(sa, bearer)
          .send({
            identifier,
            type: identifier.startsWith('BICI') ? 'BICYCLE' : 'MOTORCYCLE',
          })
          .expect(201);
      await api()
        .post(`${base}/vehicles`)
        .auth(sa, bearer)
        .send({ identifier: 'MOTO-03', type: 'MOTORCYCLE' })
        .expect(409)
        .expect((res) => expect(res.body.message).toMatch(/vehicle limit/));
      // Suspending does not free a slot.
      await api()
        .patch(`${base}/drivers/${drivers[0].id}`)
        .auth(sa, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await api()
        .post(`${base}/drivers`)
        .auth(sa, bearer)
        .send({ userId: await driverUser(), name: 'Luis' })
        .expect(409);
      await api()
        .patch(`/api/v1/admin/providers/${provider.id}`)
        .auth(sa, bearer)
        .send({ maxDrivers: 2 })
        .expect(409);
      await api()
        .patch(`/api/v1/admin/providers/${provider.id}`)
        .auth(sa, bearer)
        .send({ maxVehicles: 1 })
        .expect(409);
      await api()
        .patch(`/api/v1/admin/providers/${provider.id}`)
        .auth(sa, bearer)
        .send({ maxDrivers: 3, maxVehicles: 4 })
        .expect(200);
      await api()
        .post(`${base}/vehicles`)
        .auth(sa, bearer)
        .send({ identifier: 'MOTO-03', type: 'MOTORCYCLE' })
        .expect(201);
    });

    it('INDEPENDENT uses the same model and limits are configurable, not hardcoded', async () => {
      const provider = await adminProvider({
        name: 'Juan',
        type: 'INDEPENDENT',
      });
      const base = `/api/v1/admin/providers/${provider.id}`;
      await api()
        .post(`${base}/drivers`)
        .auth(sa, bearer)
        .send({ userId: await driverUser(), name: 'Juan' })
        .expect(201);
      await api()
        .post(`${base}/drivers`)
        .auth(sa, bearer)
        .send({ userId: await driverUser(), name: 'Second' })
        .expect(409);
      for (const [identifier, type] of [
        ['BICI', 'BICYCLE'],
        ['MOTO', 'MOTORCYCLE'],
      ])
        await api()
          .post(`${base}/vehicles`)
          .auth(sa, bearer)
          .send({ identifier, type })
          .expect(201);
      await api()
        .post(`${base}/vehicles`)
        .auth(sa, bearer)
        .send({ identifier: 'CAR', type: 'CAR' })
        .expect(409);
      await api()
        .patch(`/api/v1/admin/providers/${provider.id}`)
        .auth(sa, bearer)
        .send({ maxDrivers: 2 })
        .expect(200);
      await api()
        .post(`${base}/drivers`)
        .auth(sa, bearer)
        .send({ userId: await driverUser(), name: 'Second' })
        .expect(201);
    });

    it('keeps limits under concurrent creation (provider row lock)', async () => {
      const provider = await adminProvider({ maxDrivers: 3, maxVehicles: 3 });
      const base = `/api/v1/admin/providers/${provider.id}`;
      const users = await Promise.all(
        Array.from({ length: 6 }, () => driverUser()),
      );
      const driverResults = await Promise.all(
        users.map((userId, i) =>
          api()
            .post(`${base}/drivers`)
            .auth(sa, bearer)
            .send({ userId, name: `C${i}` }),
        ),
      );
      const vehicleResults = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          api()
            .post(`${base}/vehicles`)
            .auth(sa, bearer)
            .send({ identifier: `CONC-${i}`, type: 'CAR' }),
        ),
      );
      for (const results of [driverResults, vehicleResults]) {
        const statuses = results.map((r) => r.status).sort();
        expect(statuses).toEqual([201, 201, 201, 409, 409, 409]);
      }
      expect(
        await prisma.driver.count({ where: { providerId: provider.id } }),
      ).toBe(3);
      expect(
        await prisma.vehicle.count({ where: { providerId: provider.id } }),
      ).toBe(3);
    });

    it('assigns, rejects busy/ineligible resources, unassigns, reassigns and keeps history', async () => {
      const carlos = await providerDriver(adminA, undefined, 'Carlos');
      const pedro = await providerDriver(adminA, undefined, 'Pedro');
      const jose = await providerDriver(adminA, undefined, 'José');
      const moto1 = await providerVehicle(adminA, undefined, {
        identifier: `M1-${run}`,
      });
      const moto2 = await providerVehicle(adminA, undefined, {
        identifier: `M2-${run}`,
      });
      const assign = (driverId: string, vehicleId: string) =>
        api()
          .post(`/api/v1/provider/drivers/${driverId}/vehicle`)
          .auth(adminA, bearer)
          .send({ vehicleId });
      const unassign = (driverId: string) =>
        api()
          .delete(`/api/v1/provider/drivers/${driverId}/vehicle`)
          .auth(adminA, bearer);

      // PENDING drivers may receive a vehicle during onboarding.
      const first = await assign(carlos.id, moto1.id).expect(201);
      expect(first.body).toMatchObject({
        driverId: carlos.id,
        vehicleId: moto1.id,
        unassignedAt: null,
        vehicle: { identifier: moto1.identifier },
      });
      await assign(carlos.id, moto2.id).expect(409); // driver already assigned
      await assign(pedro.id, moto1.id).expect(409); // vehicle busy
      const who = await api()
        .get(`/api/v1/provider/vehicles/${moto1.id}`)
        .auth(adminA, bearer)
        .expect(200);
      expect(who.body.currentAssignment.driver).toMatchObject({
        id: carlos.id,
        name: 'Carlos',
      });
      const closed = await unassign(carlos.id).expect(200);
      expect(closed.body.unassignedAt).not.toBeNull();
      await unassign(carlos.id).expect(404);
      await assign(carlos.id, moto2.id).expect(201);
      await assign(pedro.id, moto1.id).expect(201);
      const detail = await api()
        .get(`/api/v1/provider/drivers/${carlos.id}`)
        .auth(adminA, bearer)
        .expect(200);
      expect(detail.body.currentAssignment.vehicle.id).toBe(moto2.id);
      const history = await api()
        .get(`/api/v1/provider/drivers/${carlos.id}/assignments`)
        .auth(adminA, bearer)
        .expect(200);
      expect(history.body.total).toBe(2);
      expect(history.body.items[0]).toMatchObject({
        vehicleId: moto2.id,
        unassignedAt: null,
      });
      expect(history.body.items[1].vehicleId).toBe(moto1.id);
      expect(history.body.items[1].unassignedAt).not.toBeNull();
      const vehicleHistory = await api()
        .get(`/api/v1/provider/vehicles/${moto1.id}/assignments`)
        .auth(adminA, bearer)
        .expect(200);
      expect(
        vehicleHistory.body.items.map((a: { driverId: string }) => a.driverId),
      ).toEqual([pedro.id, carlos.id]);

      // Ineligible vehicles.
      const spare = await providerVehicle(adminA, undefined, {
        identifier: `SP-${run}`,
      });
      for (const status of ['INACTIVE', 'MAINTENANCE', 'SUSPENDED']) {
        await api()
          .patch(`/api/v1/provider/vehicles/${spare.id}`)
          .auth(adminA, bearer)
          .send({ status })
          .expect(200);
        await assign(jose.id, spare.id)
          .expect(409)
          .expect((res) => expect(res.body.message).toMatch(/ACTIVE vehicles/));
      }
      // Suspended driver.
      await api()
        .patch(`/api/v1/provider/vehicles/${spare.id}`)
        .auth(adminA, bearer)
        .send({ status: 'ACTIVE' })
        .expect(200);
      await api()
        .patch(`/api/v1/provider/drivers/${jose.id}`)
        .auth(adminA, bearer)
        .send({ status: 'SUSPENDED' })
        .expect(200);
      await assign(jose.id, spare.id)
        .expect(409)
        .expect((res) => expect(res.body.message).toMatch(/Suspended drivers/));
      await api()
        .patch(`/api/v1/provider/drivers/${jose.id}`)
        .auth(adminA, bearer)
        .send({ status: 'ACTIVE' })
        .expect(200);

      // Concurrent assignment of one vehicle to two drivers: exactly one wins.
      const race = await Promise.all([
        assign(jose.id, spare.id),
        assign(pedro.id, spare.id),
      ]);
      expect(race.map((r) => r.status).sort()).toEqual([201, 409]);

      // Cross-provider also rejected on the SUPER_ADMIN surface and at database level.
      const vehicleB = await providerVehicle(adminB);
      await api()
        .post(
          `/api/v1/admin/providers/${scenario.providerA.id}/drivers/${carlos.id}/vehicle`,
        )
        .auth(sa, bearer)
        .send({ vehicleId: vehicleB.id })
        .expect(404);
      await expect(
        prisma.driverVehicleAssignment.create({
          data: {
            providerId: scenario.providerA.id,
            driverId: carlos.id,
            vehicleId: vehicleB.id,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.driverVehicleAssignment.create({
          data: {
            providerId: scenario.providerB.id,
            driverId: carlos.id,
            vehicleId: vehicleB.id,
          },
        }),
      ).rejects.toThrow();
      expect(
        await prisma.driverVehicleAssignment.count({
          where: { driverId: carlos.id, unassignedAt: null },
        }),
      ).toBe(1);
    });

    it('suspended provider blocks new assignments and forces drivers OFFLINE', async () => {
      const provider = await adminProvider();
      const base = `/api/v1/admin/providers/${provider.id}`;
      await api()
        .post(`/api/v1/admin/providers/${provider.id}/activate`)
        .auth(sa, bearer)
        .expect(200);
      const driver = (
        await api()
          .post(`${base}/drivers`)
          .auth(sa, bearer)
          .send({ userId: await driverUser(), name: 'Offline' })
          .expect(201)
      ).body;
      const vehicle = (
        await api()
          .post(`${base}/vehicles`)
          .auth(sa, bearer)
          .send({ identifier: 'SUSP-01', type: 'CAR' })
          .expect(201)
      ).body;
      await prisma.driver.update({
        where: { id: driver.id },
        data: { status: 'ACTIVE', availability: 'AVAILABLE' },
      });
      await api()
        .post(`/api/v1/admin/providers/${provider.id}/suspend`)
        .auth(sa, bearer)
        .expect(200);
      expect(
        (await prisma.driver.findUniqueOrThrow({ where: { id: driver.id } }))
          .availability,
      ).toBe('OFFLINE');
      await api()
        .post(`${base}/drivers/${driver.id}/vehicle`)
        .auth(sa, bearer)
        .send({ vehicleId: vehicle.id })
        .expect(409);
    });
  },
);
