import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  ASSIGNMENT_ERRORS,
  assignmentDeadline,
  assignmentTtlMinutes,
  pairingConflict,
  paymentContext,
} from '../dist/delivery-assignments/assignment-policy.js';
import {
  DeliveryAssignmentsService,
  cancelActiveAssignments,
} from '../dist/delivery-assignments/delivery-assignments.service.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const D = (n: string) => new Prisma.Decimal(n);
const claimedAt = new Date('2026-09-17T12:00:00Z');
const at = (ms: number) => new Date(claimedAt.getTime() + ms);
const quote = { amount: D('60'), currency: 'MXN' };

describe('assignment deadline', () => {
  it('starts at claimedAt, is independent from the dispatch window and only flags unassigned claims', () => {
    const claimed = { status: 'CLAIMED', claimedAt };
    expect(assignmentDeadline(claimed, false, 5, at(0))).toEqual({
      assignmentDeadline: at(300_000),
      assignmentOverdue: false,
    });
    expect(
      assignmentDeadline(claimed, false, 5, at(300_001)).assignmentOverdue,
    ).toBe(true);
    // With resources already assigned the provider is not overdue.
    expect(
      assignmentDeadline(claimed, true, 5, at(3_600_000)).assignmentOverdue,
    ).toBe(false);
    for (const status of ['OPEN', 'EXPIRED', 'CANCELLED'])
      expect(
        assignmentDeadline({ status, claimedAt }, false, 5, at(1e9)),
      ).toEqual({
        assignmentDeadline: null,
        assignmentOverdue: false,
      });
  });
  it('reads the TTL of each ServiceType from configuration', () => {
    const config = new ConfigService({
      LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES: 7,
    });
    expect(assignmentTtlMinutes(config, 'LOCAL_DELIVERY')).toBe(7);
    const base = {
      DATABASE_URL: 'postgresql://localhost/mandaria',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      INTEGRATION_JWT_SECRET: 'c'.repeat(40),
    };
    expect(
      validateEnvironment(base).LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES,
    ).toBe(5);
    // Assignment deadline and dispatch TTL are separate settings.
    expect(validateEnvironment(base).DISPATCH_TTL_MINUTES).toBe(10);
    for (const bad of ['0', '1441', 'x'])
      expect(() =>
        validateEnvironment({
          ...base,
          LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES: bad,
        }),
      ).toThrow();
  });
});

describe('payment context', () => {
  it('separates delivery fee from goods and states what the driver must advance', () => {
    expect(
      paymentContext(quote, {
        goodsValue: D('800'),
        goodsPaymentMode: 'COURIER_ADVANCE',
        currency: 'MXN',
      }),
    ).toEqual({
      deliveryFee: { amount: '60.00', currency: 'MXN' },
      goodsValue: { amount: '800.00', currency: 'MXN' },
      goodsPaymentMode: 'COURIER_ADVANCE',
      driverAdvancesGoods: true,
      driverAdvanceAmount: { amount: '800.00', currency: 'MXN' },
    });
    const prepaid = paymentContext(quote, {
      goodsValue: D('800'),
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
    });
    expect(prepaid.driverAdvancesGoods).toBe(false);
    expect(prepaid.driverAdvanceAmount).toBeNull();
    expect(prepaid.deliveryFee).toEqual({ amount: '60.00', currency: 'MXN' });
    expect(paymentContext(quote, null)).toMatchObject({
      goodsValue: null,
      goodsPaymentMode: null,
      driverAdvancesGoods: false,
      driverAdvanceAmount: null,
    });
  });
});

describe('V1.4 pairing consistency', () => {
  it('rejects a driver or vehicle paired with another resource, allows the paired couple and free ones', () => {
    const paired = [{ driverId: 'carlos', vehicleId: 'moto03' }];
    expect(pairingConflict(paired, 'carlos', 'moto03')).toBe(false);
    expect(pairingConflict(paired, 'carlos', 'moto07')).toBe(true);
    expect(pairingConflict(paired, 'pedro', 'moto03')).toBe(true);
    expect(pairingConflict([], 'carlos', 'moto03')).toBe(false);
    for (const code of Object.keys(ASSIGNMENT_ERRORS))
      expect(ASSIGNMENT_ERRORS[code as keyof typeof ASSIGNMENT_ERRORS]).toBe(
        409,
      );
  });
});

describe('DeliveryAssignmentsService rules inside the transaction', () => {
  const dispatchRow = (overrides: Record<string, unknown> = {}) => ({
    status: 'CLAIMED',
    claimedByProviderId: 'A',
    ...overrides,
  });
  function service(options: {
    dispatch?: Record<string, unknown> | null;
    active?: { id: string; driverId: string; vehicleId: string } | null;
    provider?: { id: string; status: string };
    driver?: { status: string; userActive: boolean } | null;
    vehicle?: { status: string } | null;
    busy?: { driverId: string; vehicleId: string }[];
    pairings?: { driverId: string; vehicleId: string }[];
  }) {
    const queue: unknown[][] = [
      options.dispatch === null ? [] : [dispatchRow(options.dispatch)],
    ];
    if (options.active !== undefined)
      queue.push(options.active ? [options.active] : []);
    queue.push([options.provider ?? { id: 'A', status: 'ACTIVE' }]);
    queue.push(
      options.driver === null
        ? []
        : [options.driver ?? { status: 'ACTIVE', userActive: true }],
    );
    queue.push(
      options.vehicle === null ? [] : [options.vehicle ?? { status: 'ACTIVE' }],
    );
    const tx = {
      $queryRaw: vi.fn(async () => queue.shift() ?? []),
      deliveryAssignment: {
        findFirst: vi
          .fn()
          .mockResolvedValue(
            options.active === undefined ? null : options.active,
          ),
        findMany: vi.fn().mockResolvedValue(options.busy ?? []),
        create: vi
          .fn()
          .mockResolvedValue({
            id: 'new',
            driver: { id: 'd' },
            vehicle: { id: 'v' },
          }),
        update: vi
          .fn()
          .mockResolvedValue({
            id: 'old',
            driver: { id: 'd' },
            vehicle: { id: 'v' },
          }),
      },
      driverVehicleAssignment: {
        findMany: vi.fn().mockResolvedValue(options.pairings ?? []),
      },
    };
    const prisma = {
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
      dispatch: { findUniqueOrThrow: vi.fn() },
    };
    return {
      tx,
      service: new DeliveryAssignmentsService(
        prisma as unknown as PrismaService,
      ),
    };
  }
  const actor = { providerId: 'A', userId: 'u1' };
  const input = { driverId: 'carlos', vehicleId: 'moto03' };
  const failure = async (promise: Promise<unknown>) =>
    promise.then(
      () => 'no error',
      (e: { getStatus(): number; code?: string }) =>
        `${e.getStatus()} ${e.code ?? ''}`.trim(),
    );

  it('hides dispatches of other providers and refuses when the claim is not ours', async () => {
    expect(
      await failure(
        service({ dispatch: null }).service.create('d1', input, actor),
      ),
    ).toBe('404');
    expect(
      await failure(
        service({ dispatch: { claimedByProviderId: 'B' } }).service.create(
          'd1',
          input,
          actor,
        ),
      ),
    ).toBe('409 DISPATCH_NOT_CLAIMED_BY_PROVIDER');
    expect(
      await failure(
        service({
          dispatch: { status: 'OPEN', claimedByProviderId: null },
        }).service.create('d1', input, actor),
      ),
    ).toBe('409 DISPATCH_NOT_CLAIMED_BY_PROVIDER');
  });

  it('refuses a second assignment, ineligible or busy resources and pairing mismatches', async () => {
    const cases: [string, Parameters<typeof service>[0]][] = [
      [
        '409 DISPATCH_ALREADY_ASSIGNED',
        { active: { id: 'a1', driverId: 'x', vehicleId: 'y' } },
      ],
      [
        '409 PROVIDER_NOT_ACTIVE',
        { provider: { id: 'A', status: 'SUSPENDED' } },
      ],
      ['404', { driver: null }],
      ['404', { vehicle: null }],
      [
        '409 DRIVER_NOT_ELIGIBLE',
        { driver: { status: 'PENDING', userActive: true } },
      ],
      [
        '409 DRIVER_NOT_ELIGIBLE',
        { driver: { status: 'ACTIVE', userActive: false } },
      ],
      ['409 VEHICLE_NOT_ELIGIBLE', { vehicle: { status: 'MAINTENANCE' } }],
      [
        '409 DRIVER_BUSY',
        { busy: [{ driverId: 'carlos', vehicleId: 'other' }] },
      ],
      [
        '409 VEHICLE_BUSY',
        { busy: [{ driverId: 'other', vehicleId: 'moto03' }] },
      ],
      [
        '409 DRIVER_VEHICLE_MISMATCH',
        { pairings: [{ driverId: 'carlos', vehicleId: 'moto07' }] },
      ],
      [
        '409 DRIVER_VEHICLE_MISMATCH',
        { pairings: [{ driverId: 'pedro', vehicleId: 'moto03' }] },
      ],
    ];
    for (const [expected, options] of cases) {
      const { service: s, tx } = service(options);
      expect(await failure(s.create('d1', input, actor)), expected).toBe(
        expected,
      );
      expect(tx.deliveryAssignment.create).not.toHaveBeenCalled();
    }
  });

  it('accepts the paired couple and records who assigned', async () => {
    const { service: s, tx } = service({
      pairings: [{ driverId: 'carlos', vehicleId: 'moto03' }],
    });
    await s.create('d1', input, actor).catch(() => undefined);
    expect(tx.deliveryAssignment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          dispatchId: 'd1',
          providerId: 'A',
          driverId: 'carlos',
          vehicleId: 'moto03',
          assignedByUserId: 'u1',
        }),
      }),
    );
  });

  it('rejects reassigning to the same couple and cancelling without an active assignment', async () => {
    const same = service({ active: { id: 'a1', ...input } });
    expect(
      await failure(
        same.service.reassign(
          'd1',
          { ...input, reason: 'OPERATIONAL_CHANGE' },
          actor,
        ),
      ),
    ).toBe('409 ASSIGNMENT_UNCHANGED');
    expect(same.tx.deliveryAssignment.update).not.toHaveBeenCalled();
    const empty = service({ active: null });
    expect(
      await failure(
        empty.service.cancel('d1', { reason: 'DRIVER_UNAVAILABLE' }, actor),
      ),
    ).toBe('409 NO_ACTIVE_ASSIGNMENT');
    const emptyReassign = service({ active: null });
    expect(
      await failure(
        emptyReassign.service.reassign(
          'd1',
          { driverId: 'pedro', vehicleId: 'moto07', reason: 'VEHICLE_ISSUE' },
          actor,
        ),
      ),
    ).toBe('409 NO_ACTIVE_ASSIGNMENT');
  });

  it('ends the previous assignment before creating the new one', async () => {
    const { service: s, tx } = service({
      active: { id: 'a1', driverId: 'pedro', vehicleId: 'moto07' },
    });
    await s
      .reassign('d1', { ...input, reason: 'DRIVER_UNAVAILABLE' }, actor)
      .catch(() => undefined);
    expect(tx.deliveryAssignment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'a1' },
        data: expect.objectContaining({
          status: 'REASSIGNED',
          endedByUserId: 'u1',
          endReason: 'DRIVER_UNAVAILABLE',
        }),
      }),
    );
    const updateOrder =
      tx.deliveryAssignment.update.mock.invocationCallOrder[0];
    const createOrder =
      tx.deliveryAssignment.create.mock.invocationCallOrder[0];
    expect(updateOrder).toBeLessThan(createOrder);
  });
});

describe('cancelling a delivery ends its active assignments', () => {
  it('marks them CANCELLED / DELIVERY_CANCELLED and returns them for the audit log', async () => {
    const update = vi.fn();
    const active = [
      {
        id: 'a1',
        dispatchId: 'd1',
        providerId: 'A',
        driverId: 'carlos',
        vehicleId: 'moto03',
      },
    ];
    const tx = {
      deliveryAssignment: {
        findMany: vi.fn().mockResolvedValue(active),
        update,
      },
    };
    const now = new Date('2026-09-17T13:00:00Z');
    expect(
      await cancelActiveAssignments(tx as never, ['d1'], now, 'u9'),
    ).toEqual(active);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a1' },
      data: {
        status: 'CANCELLED',
        endedAt: now,
        endedByUserId: 'u9',
        endReason: 'DELIVERY_CANCELLED',
      },
    });
    expect(await cancelActiveAssignments(tx as never, [], now, null)).toEqual(
      [],
    );
    expect(tx.deliveryAssignment.findMany).toHaveBeenCalledOnce();
  });
});
