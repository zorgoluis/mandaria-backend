import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DriversService } from '../dist/drivers/drivers.service.js';
import { VehiclesService } from '../dist/vehicles/vehicles.service.js';
import { AssignmentsService } from '../dist/assignments/assignments.service.js';
import { ProvidersService } from '../dist/providers/providers.service.js';
import { withCurrentAssignment } from '../dist/assignments/assignment.select.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

/** Minimal transaction double: raw row-lock queries return the queued rows in order. */
function prismaDouble(rawRows: unknown[][], tx: Record<string, unknown> = {}) {
  const queryRaw = vi.fn<(...args: unknown[]) => Promise<unknown[]>>(
    async () => rawRows.shift() ?? [],
  );
  const client = { $queryRaw: queryRaw, ...tx };
  return {
    queryRaw,
    prisma: {
      ...client,
      $transaction: (fn: (t: typeof client) => unknown) => fn(client),
    } as unknown as PrismaService,
  };
}
const provider = (status = 'ACTIVE', maxDrivers = 2, maxVehicles = 2) => [
  { id: 'p', status, maxDrivers, maxVehicles },
];

describe('V1.4 service rules', () => {
  it('rejects driver creation at maxDrivers after locking the provider row', async () => {
    const create = vi.fn();
    const { prisma, queryRaw } = prismaDouble([provider('ACTIVE', 2), []], {
      user: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ active: true, role: 'DRIVER', driver: null }),
      },
      driver: { count: vi.fn().mockResolvedValue(2), create },
    });
    await expect(
      new DriversService(prisma).create(
        'p',
        { userId: 'u', name: 'Luis' },
        'actor',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(String(queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(create).not.toHaveBeenCalled();
  });

  it('requires an active DRIVER user without a previous profile', async () => {
    for (const user of [
      { active: true, role: 'PROVIDER_ADMIN', driver: null },
      { active: false, role: 'DRIVER', driver: null },
      { active: true, role: 'DRIVER', driver: { id: 'existing' } },
    ]) {
      const { prisma } = prismaDouble([provider(), []], {
        user: { findUnique: vi.fn().mockResolvedValue(user) },
        driver: { count: vi.fn().mockResolvedValue(0), create: vi.fn() },
      });
      await expect(
        new DriversService(prisma).create(
          'p',
          { userId: 'u', name: 'X' },
          'actor',
        ),
      ).rejects.toMatchObject({ status: 409 });
    }
  });

  it('rejects returning to PENDING and forces OFFLINE when a driver leaves ACTIVE', async () => {
    const update = vi
      .fn()
      .mockResolvedValue({ assignments: [], status: 'SUSPENDED' });
    const rejected = prismaDouble(
      [[{ status: 'ACTIVE', availability: 'AVAILABLE', name: 'C' }]],
      { driver: { update } },
    );
    await expect(
      new DriversService(rejected.prisma).update(
        'p',
        'd',
        { status: 'PENDING' },
        'a',
      ),
    ).rejects.toMatchObject({ status: 409 });
    const ok = prismaDouble(
      [[{ status: 'ACTIVE', availability: 'AVAILABLE', name: 'C' }]],
      {
        driver: { update },
      },
    );
    await new DriversService(ok.prisma).update(
      'p',
      'd',
      { status: 'SUSPENDED' },
      'a',
    );
    expect(update.mock.lastCall![0].data).toMatchObject({
      status: 'SUSPENDED',
      availability: 'OFFLINE',
    });
  });

  it('only allows AVAILABLE/BUSY for ACTIVE drivers of ACTIVE providers', async () => {
    const cases: [string, string, number | null][] = [
      ['ACTIVE', 'ACTIVE', null],
      ['PENDING', 'ACTIVE', 409],
      ['SUSPENDED', 'ACTIVE', 409],
      ['ACTIVE', 'SUSPENDED', 409],
      ['ACTIVE', 'PENDING', 409],
    ];
    for (const [driverStatus, providerStatus, expected] of cases) {
      const update = vi.fn();
      const { prisma } = prismaDouble(
        [
          provider(providerStatus),
          [{ status: driverStatus, availability: 'OFFLINE' }],
        ],
        {
          driver: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ id: 'd', providerId: 'p' })
              .mockResolvedValue({ assignments: [] }),
            update,
          },
        },
      );
      const call = new DriversService(prisma).setOwnAvailability(
        'u',
        'AVAILABLE',
      );
      if (expected) {
        await expect(call).rejects.toMatchObject({ status: expected });
        expect(update).not.toHaveBeenCalled();
      } else {
        await call;
        expect(update).toHaveBeenCalledWith({
          where: { id: 'd' },
          data: { availability: 'AVAILABLE' },
        });
      }
    }
  });

  it('rejects vehicle creation at maxVehicles', async () => {
    const create = vi.fn();
    const { prisma } = prismaDouble([provider('ACTIVE', 2, 3)], {
      vehicle: { count: vi.fn().mockResolvedValue(3), create },
    });
    await expect(
      new VehiclesService(prisma).create(
        'p',
        { identifier: 'MOTO-03', type: 'MOTORCYCLE' },
        'actor',
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it('blocks assignments for suspended drivers/providers, non-ACTIVE vehicles and busy resources', async () => {
    const run = async (
      rows: unknown[][],
      active: { driverId: string }[] = [],
    ) => {
      const create = vi.fn();
      const { prisma } = prismaDouble(rows, {
        driverVehicleAssignment: {
          findMany: vi.fn().mockResolvedValue(active),
          create,
        },
      });
      await expect(
        new AssignmentsService(prisma).assign('p', 'd', 'v', 'actor'),
      ).rejects.toMatchObject({ status: expect.any(Number) });
      expect(create).not.toHaveBeenCalled();
    };
    await run([
      provider('SUSPENDED'),
      [{ status: 'ACTIVE' }],
      [{ status: 'ACTIVE' }],
    ]);
    await run([provider(), [{ status: 'SUSPENDED' }], [{ status: 'ACTIVE' }]]);
    for (const status of ['INACTIVE', 'MAINTENANCE', 'SUSPENDED'])
      await run([provider(), [{ status: 'ACTIVE' }], [{ status }]]);
    await run(
      [provider(), [{ status: 'ACTIVE' }], [{ status: 'ACTIVE' }]],
      [{ driverId: 'd' }],
    );
    await run(
      [provider(), [{ status: 'ACTIVE' }], [{ status: 'ACTIVE' }]],
      [{ driverId: 'x' }],
    );
    // Vehicle outside the provider scope looks missing.
    await run([provider(), [{ status: 'ACTIVE' }], []]);
  });

  it('refuses to lower provider limits below current usage', async () => {
    const update = vi.fn();
    const { prisma } = prismaDouble([[]], {
      deliveryProvider: {
        findUnique: vi
          .fn()
          .mockResolvedValue({ maxDrivers: 5, maxVehicles: 5 }),
        update,
      },
      driver: { count: vi.fn().mockResolvedValue(4) },
      vehicle: { count: vi.fn().mockResolvedValue(1) },
    });
    const service = new ProvidersService(prisma, new ConfigService({}));
    await expect(
      service.update('p', { maxDrivers: 3 }, 'actor'),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('maps the one-row assignments relation to currentAssignment', () => {
    expect(withCurrentAssignment({ id: 'd', assignments: [] })).toEqual({
      id: 'd',
      currentAssignment: null,
    });
    expect(
      withCurrentAssignment({ id: 'd', assignments: [{ id: 'a' }] }),
    ).toEqual({
      id: 'd',
      currentAssignment: { id: 'a' },
    });
  });
});
