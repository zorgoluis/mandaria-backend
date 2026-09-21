import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  INDEPENDENT_ERRORS,
  isGuardRejection,
  INDEPENDENT_RELEASE_REASONS,
  RELEASE_END_REASON,
  SERVICE_EXECUTION_MODES,
  allowsIndependent,
  independentServiceTypes,
  takeRejection,
} from '../dist/independent-drivers/independent-driver-policy.js';
import { IndependentDriversService } from '../dist/independent-drivers/independent-drivers.service.js';
import { IndependentDispatchesService } from '../dist/independent-drivers/independent-dispatches.service.js';
import { assignmentDeadline } from '../dist/delivery-assignments/assignment-policy.js';
import { validateEnvironment } from '../src/config/environment.js';
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
const config = new ConfigService({ INDEPENDENT_DRIVER_MAX_VEHICLES: 3 });
const open = (extra: object = {}) => ({
  status: 'OPEN',
  expiresAt: new Date('2026-09-18T12:00:00Z'),
  serviceType: 'LOCAL_DELIVERY' as const,
  ...extra,
});
const inWindow = new Date('2026-09-18T11:00:00Z');
const afterWindow = new Date('2026-09-18T12:00:01Z');

describe('V1.9 service execution policy', () => {
  it('decides per ServiceType whether independents may execute it', () => {
    // The policy is exhaustive by construction: a new ServiceType must be declared here.
    expect(Object.keys(SERVICE_EXECUTION_MODES)).toEqual(['LOCAL_DELIVERY']);
    expect(SERVICE_EXECUTION_MODES.LOCAL_DELIVERY).toBe('BOTH');
    expect(allowsIndependent('LOCAL_DELIVERY')).toBe(true);
    expect(independentServiceTypes).toEqual(['LOCAL_DELIVERY']);
  });
  it('would hide a FLEET-only service from independents without touching the fleet path', () => {
    // Simulates the shape a future FREIGHT entry would take.
    const modes: Record<string, string> = {
      LOCAL_DELIVERY: 'BOTH',
      X: 'FLEET',
    };
    const allowed = Object.entries(modes)
      .filter(([, m]) => m === 'BOTH' || m === 'INDEPENDENT')
      .map(([k]) => k);
    expect(allowed).toEqual(['LOCAL_DELIVERY']);
  });
});

describe('V1.9 take eligibility', () => {
  it('rejects in the same order as the provider claim, and only then checks the service policy', () => {
    expect(takeRejection(open({ status: 'CANCELLED' }), false, inWindow)).toBe(
      'DISPATCH_CANCELLED',
    );
    expect(takeRejection(open({ status: 'EXPIRED' }), false, inWindow)).toBe(
      'DISPATCH_EXPIRED',
    );
    // An OPEN dispatch past its window is expired even before a write persists it.
    expect(takeRejection(open(), false, afterWindow)).toBe('DISPATCH_EXPIRED');
    expect(takeRejection(open({ status: 'CLAIMED' }), false, inWindow)).toBe(
      'DISPATCH_ALREADY_CLAIMED',
    );
    expect(
      takeRejection(open({ serviceType: 'FREIGHT' as never }), false, inWindow),
    ).toBe('DISPATCH_NOT_OPEN_TO_INDEPENDENT');
    expect(takeRejection(open(), true, inWindow)).toBe(
      'DISPATCH_RETAKE_NOT_ALLOWED',
    );
    expect(takeRejection(open(), false, inWindow)).toBeNull();
  });
  it('maps every driver motive onto the shared V1.8 end-reason enum', () => {
    for (const reason of INDEPENDENT_RELEASE_REASONS)
      expect(RELEASE_END_REASON[reason]).toBeTruthy();
    expect(RELEASE_END_REASON.PERSONAL_EMERGENCY).toBe('DRIVER_UNAVAILABLE');
    expect(RELEASE_END_REASON.VEHICLE_ISSUE).toBe('VEHICLE_ISSUE');
    expect(RELEASE_END_REASON.OPERATIONAL_ISSUE).toBe('OPERATIONAL_CHANGE');
    // DELIVERY_CANCELLED stays reserved for the official cancellation of the request.
    expect(Object.values(RELEASE_END_REASON)).not.toContain(
      'DELIVERY_CANCELLED',
    );
  });
  it('every V1.9 conflict is a 409, never a silent success', () => {
    expect(new Set(Object.values(INDEPENDENT_ERRORS))).toEqual(new Set([409]));
  });
});

describe('V1.9 assignment deadline', () => {
  it('does not apply to an independent claim, whose assignment is created in the same transaction', () => {
    const claimedAt = new Date('2026-09-18T10:00:00Z');
    const late = new Date('2026-09-18T23:00:00Z');
    // A fleet claim with no assignment after the TTL is overdue...
    expect(
      assignmentDeadline({ status: 'CLAIMED', claimedAt }, false, 5, late)
        .assignmentOverdue,
    ).toBe(true);
    // ...an independent one can never be: take = claim + assignment.
    expect(
      assignmentDeadline(
        {
          status: 'CLAIMED',
          claimedAt,
          claimedByIndependentDriverId: 'driver-1',
        },
        false,
        5,
        late,
      ),
    ).toEqual({ assignmentDeadline: null, assignmentOverdue: false });
  });
});

describe('V1.9 enabling an independent driver', () => {
  const driverRow = (extra: object = {}) => ({
    id: 'd',
    name: 'Carlos',
    status: 'ACTIVE',
    user: { id: 'u', active: true, role: 'DRIVER' },
    ...extra,
  });
  it('requires a real, operational Driver and never creates one', async () => {
    for (const bad of [
      driverRow({ status: 'PENDING' }),
      driverRow({ status: 'SUSPENDED' }),
      driverRow({ user: { id: 'u', active: false, role: 'DRIVER' } }),
      driverRow({ user: { id: 'u', active: true, role: 'PROVIDER_ADMIN' } }),
    ]) {
      const create = vi.fn();
      const { prisma } = prismaDouble([], {
        driver: { findUnique: vi.fn().mockResolvedValue(bad) },
        independentDriverProfile: { findUnique: vi.fn(), create },
      });
      await expect(
        new IndependentDriversService(prisma, config).approve('d', undefined, {
          userId: 'admin',
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'DRIVER_NOT_ELIGIBLE' },
      });
      expect(create).not.toHaveBeenCalled();
    }
  });
  it('is a 404 for an unknown driver, so ids cannot be probed', async () => {
    const { prisma } = prismaDouble([], {
      driver: { findUnique: vi.fn().mockResolvedValue(null) },
      independentDriverProfile: { findUnique: vi.fn(), create: vi.fn() },
    });
    await expect(
      new IndependentDriversService(prisma, config).approve('d', undefined, {
        userId: 'admin',
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('creates the profile APPROVED with the acting SUPER_ADMIN, and is idempotent', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'p' });
    const findProfile = vi.fn().mockResolvedValue(null);
    const { prisma } = prismaDouble([], {
      driver: { findUnique: vi.fn().mockResolvedValue(driverRow()) },
      independentDriverProfile: {
        findUnique: findProfile,
        create,
        update: vi.fn(),
      },
    });
    const service = new IndependentDriversService(prisma, config);
    // getByDriver runs after the transaction; make it resolve.
    findProfile.mockResolvedValueOnce(null).mockResolvedValue({ id: 'p' });
    await service.approve('d', 'alta piloto', { userId: 'admin' });
    expect(create.mock.lastCall![0].data).toMatchObject({
      driverId: 'd',
      status: 'APPROVED',
      approvedByUserId: 'admin',
      reason: 'alta piloto',
      suspendedAt: null,
      rejectedAt: null,
    });

    const update = vi.fn();
    const create2 = vi.fn();
    const { prisma: prisma2 } = prismaDouble([], {
      driver: { findUnique: vi.fn().mockResolvedValue(driverRow()) },
      independentDriverProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: 'p', status: 'APPROVED' }),
        create: create2,
        update,
      },
    });
    await new IndependentDriversService(prisma2, config).approve(
      'd',
      undefined,
      { userId: 'admin' },
    );
    expect(create2).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
  it('reapproving a SUSPENDED profile clears the suspension instead of creating a second profile', async () => {
    const update = vi.fn().mockResolvedValue({ id: 'p' });
    const create = vi.fn();
    const { prisma } = prismaDouble([], {
      driver: { findUnique: vi.fn().mockResolvedValue(driverRow()) },
      independentDriverProfile: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({ id: 'p', status: 'SUSPENDED' })
          .mockResolvedValue({ id: 'p' }),
        create,
        update,
      },
    });
    await new IndependentDriversService(prisma, config).approve('d', 'ok ya', {
      userId: 'admin',
    });
    expect(create).not.toHaveBeenCalled();
    expect(update.mock.lastCall![0].data).toMatchObject({
      status: 'APPROVED',
      suspendedAt: null,
      suspendedByUserId: null,
      rejectedAt: null,
    });
  });
});

describe('V1.9 suspension with an active service', () => {
  it('refuses the suspension instead of cancelling a delivery in progress', async () => {
    const update = vi.fn();
    const { prisma } = prismaDouble([[{ id: 'p', status: 'APPROVED' }]], {
      deliveryAssignment: {
        findFirst: vi.fn().mockResolvedValue({ id: 'assignment-1' }),
      },
      independentDriverProfile: { update, findUnique: vi.fn() },
    });
    await expect(
      new IndependentDriversService(prisma, config).suspend('d', 'motivo', {
        userId: 'admin',
      }),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'INDEPENDENT_DRIVER_HAS_ACTIVE_ASSIGNMENT' },
    });
    expect(update).not.toHaveBeenCalled();
  });
  it('suspends a free driver, recording who and why', async () => {
    const update = vi.fn();
    const { prisma } = prismaDouble([[{ id: 'p', status: 'APPROVED' }]], {
      deliveryAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
      independentDriverProfile: {
        update,
        findUnique: vi.fn().mockResolvedValue({ id: 'p' }),
      },
    });
    await new IndependentDriversService(prisma, config).suspend(
      'd',
      'documentos vencidos',
      { userId: 'admin' },
    );
    expect(update.mock.lastCall![0].data).toMatchObject({
      status: 'SUSPENDED',
      suspendedByUserId: 'admin',
      reason: 'documentos vencidos',
    });
  });
});

describe('V1.9 vehicle limit', () => {
  it('is configurable and counts every vehicle whatever its status', async () => {
    const create = vi.fn();
    const { prisma } = prismaDouble([[{ id: 'p', status: 'APPROVED' }]], {
      vehicle: { count: vi.fn().mockResolvedValue(3), create },
    });
    await expect(
      new IndependentDriversService(prisma, config).createVehicle(
        'd',
        { identifier: 'MOTO-01', type: 'MOTORCYCLE' },
        { userId: 'admin' },
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'VEHICLE_LIMIT_REACHED' },
    });
    expect(create).not.toHaveBeenCalled();
  });
  it('creates the vehicle owned by the profile and never by a provider', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'v' });
    const { prisma } = prismaDouble([[{ id: 'p', status: 'APPROVED' }]], {
      vehicle: { count: vi.fn().mockResolvedValue(0), create },
    });
    await new IndependentDriversService(prisma, config).createVehicle(
      'd',
      { identifier: 'MOTO-CARLOS-01', type: 'MOTORCYCLE' },
      { userId: 'admin' },
    );
    expect(create.mock.lastCall![0].data).toMatchObject({
      identifier: 'MOTO-CARLOS-01',
      providerId: null,
      independentDriverProfileId: 'p',
    });
  });
  it('reads the limit from the environment with a safe default', () => {
    const base = {
      DATABASE_URL: 'postgresql://localhost/mandaria',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      INTEGRATION_JWT_SECRET: 'c'.repeat(40),
    };
    expect(validateEnvironment(base).INDEPENDENT_DRIVER_MAX_VEHICLES).toBe(3);
    expect(
      validateEnvironment({ ...base, INDEPENDENT_DRIVER_MAX_VEHICLES: '5' })
        .INDEPENDENT_DRIVER_MAX_VEHICLES,
    ).toBe(5);
  });
});

describe('V1.9 driver identity is never taken from the payload', () => {
  const service = (tx: Record<string, unknown>) =>
    new IndependentDispatchesService(prismaDouble([], tx).prisma);
  it('rejects a DRIVER without an independent profile', async () => {
    const svc = service({
      driver: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'd',
          status: 'ACTIVE',
          independentProfile: null,
        }),
      },
    });
    await expect(svc.myVehicles('u')).rejects.toMatchObject({
      status: 409,
      response: { code: 'INDEPENDENT_NOT_APPROVED' },
    });
  });
  it('rejects a SUSPENDED profile without revealing anything else', async () => {
    const svc = service({
      driver: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'd',
          status: 'ACTIVE',
          independentProfile: { id: 'p', status: 'SUSPENDED' },
        }),
      },
    });
    await expect(svc.myVehicles('u')).rejects.toMatchObject({
      status: 409,
      response: { code: 'INDEPENDENT_NOT_APPROVED' },
    });
  });
  it('is a 404 when the user has no Driver profile at all', async () => {
    const svc = service({
      driver: { findUnique: vi.fn().mockResolvedValue(null) },
    });
    await expect(svc.myVehicles('u')).rejects.toMatchObject({ status: 404 });
  });
  it('reports canTakeServices false while any assignment is ACTIVE, fleet or independent', async () => {
    for (const mode of ['FLEET', 'INDEPENDENT']) {
      const svc = service({
        driver: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'd',
            independentProfile: { id: 'p', status: 'APPROVED' },
          }),
        },
        deliveryAssignment: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ id: 'a', mode, dispatchId: 'x' }),
        },
      });
      expect((await svc.profileForUser('u'))!.canTakeServices).toBe(false);
    }
    const free = service({
      driver: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'd',
          independentProfile: { id: 'p', status: 'APPROVED' },
        }),
      },
      deliveryAssignment: { findFirst: vi.fn().mockResolvedValue(null) },
    });
    expect((await free.profileForUser('u'))!.canTakeServices).toBe(true);
  });
});

/**
 * Regression for the CHECK V1.9-A finding: `take` locked the Driver row but not the
 * IndependentDriverProfile row, while suspension locks only the profile. The two never met, so a
 * suspension could commit mid-take and leave a SUSPENDED driver executing an ACTIVE service, with
 * the trigger surfacing as a 500 and the caller receiving a 409 for work that had committed.
 */
describe('V1.9 take serializes against suspension', () => {
  const dispatchRow = {
    id: 'disp',
    status: 'OPEN',
    expiresAt: new Date(Date.now() + 3_600_000),
    claimedByProviderId: null,
    claimedByIndependentDriverId: null,
    serviceType: 'LOCAL_DELIVERY',
  };
  const driverDouble = {
    findUnique: vi.fn().mockResolvedValue({
      id: 'd',
      status: 'ACTIVE',
      independentProfile: { id: 'p', status: 'APPROVED' },
    }),
  };
  const takeDouble = (createImpl: () => unknown) =>
    prismaDouble(
      [
        [dispatchRow],
        [{ status: 'ACTIVE', userActive: true, profileStatus: 'APPROVED' }],
        [{ status: 'ACTIVE' }],
      ],
      {
        driver: driverDouble,
        deliveryAssignment: {
          findFirst: vi.fn().mockResolvedValue(null),
          findMany: vi.fn().mockResolvedValue([]),
          create: vi.fn().mockImplementation(createImpl),
        },
        dispatch: {
          update: vi.fn(),
          findFirst: vi.fn().mockResolvedValue(null),
        },
      },
    );

  it('locks the profile row together with the driver row', async () => {
    const { prisma, queryRaw } = takeDouble(() => ({ id: 'a' }));
    await new IndependentDispatchesService(prisma)
      .take('u', 'disp', 'v')
      .catch(() => undefined);
    const statements = queryRaw.mock.calls.map((call) =>
      Array.isArray(call[0])
        ? (call[0] as string[]).join('?')
        : String(call[0]),
    );
    const driverLock = statements.find((q) =>
      q.includes('IndependentDriverProfile'),
    );
    expect(driverLock).toBeDefined();
    // Without `p` in the FOR UPDATE list the suspension never blocks and the race reopens.
    expect(driverLock).toMatch(/FOR UPDATE OF d, p/);
  });

  it('turns a PostgreSQL guard rejection into 409, never a 500', async () => {
    const guardError = Object.assign(
      new Error(
        'Error occurred during query execution: PostgresError { code: "P0001", message: "DELIVERY_ASSIGNMENT_INVALID: independent profile must be APPROVED and own the driver" }',
      ),
      { code: 'P2010' },
    );
    const { prisma } = takeDouble(() => {
      throw guardError;
    });
    await expect(
      new IndependentDispatchesService(prisma).take('u', 'disp', 'v'),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'TAKE_CONFLICT' },
    });
  });

  it('recognises a guard rejection without confusing it with an ordinary failure', () => {
    expect(
      isGuardRejection({ message: 'PostgresError { code: "P0001" }' }),
    ).toBe(true);
    expect(
      isGuardRejection({ message: 'DELIVERY_ASSIGNMENT_INVALID: ...' }),
    ).toBe(true);
    expect(isGuardRejection({ message: 'DISPATCH_INVALID: ...' })).toBe(true);
    expect(isGuardRejection({ message: 'connection refused' })).toBe(false);
    expect(isGuardRejection(null)).toBe(false);
  });
});
