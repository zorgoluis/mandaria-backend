import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import {
  claimRejection,
  closeDispatchesForCancelledRequest,
  DISPATCH_ERRORS,
  dispatchExpiry,
  effectiveDispatchStatus,
  openDispatch,
} from '../dist/dispatch/dispatch-policy.js';
import {
  adminDispatchView,
  providerDispatchView,
} from '../dist/dispatch/dispatch.select.js';
import { DispatchService } from '../dist/dispatch/dispatch.service.js';
import { validateEnvironment } from '../src/config/environment.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const opened = new Date('2026-09-17T10:00:00Z');
const expiresAt = dispatchExpiry(opened, 10);
const at = (ms: number) => new Date(expiresAt.getTime() + ms);
const D = (n: string) => new Prisma.Decimal(n);

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    status: 'OPEN',
    openedAt: opened,
    expiresAt,
    claimedByProviderId: null,
    claimedAt: null,
    expiredAt: null,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: opened,
    updatedAt: opened,
    deliveryQuote: {
      publicId: 'MQ-000001',
      serviceType: 'LOCAL_DELIVERY',
      distanceMeters: 4700,
      durationSeconds: 780,
      amount: D('50'),
      currency: 'MXN',
      serviceZone: { id: 'z1', code: 'ZONE', name: 'Zona' },
    },
    deliveryRequest: {
      publicId: 'MDR-000001',
      externalReference: 'ORDER-SECRET-REF',
      status: 'CREATED',
      integrationClientId: 'client-uuid',
      stops: [
        {
          type: 'PICKUP',
          sequence: 1,
          address: 'Origen 1',
          latitude: D('16.761400'),
          longitude: D('-93.374300'),
          contactName: 'Restaurante Privado',
          contactPhone: '9610000001',
          instructions: 'Tocar timbre',
        },
        {
          type: 'DROPOFF',
          sequence: 2,
          address: 'Destino 2',
          latitude: D('16.770000'),
          longitude: D('-93.360000'),
          contactName: 'Cliente Privado',
          contactPhone: '9610000002',
          instructions: null,
        },
      ],
      packages: [
        {
          category: 'FOOD',
          description: 'Pedido con nombre del cliente',
          quantity: 2,
          weightKg: D('1.5'),
          lengthCm: null,
          widthCm: null,
          heightCm: null,
          isFragile: false,
          handlingInstructions: 'Mantener caliente',
        },
      ],
      financialContext: {
        goodsValue: D('450'),
        goodsPaymentMode: 'COURIER_ADVANCE',
        currency: 'MXN',
      },
    },
    deliveryAssignments: [],
    creditSnapshots: [],
    candidates: [
      {
        providerId: 'A',
        status: 'OFFERED',
        offeredAt: opened,
        claimedAt: null,
        releasedAt: null,
        releaseReason: null,
        provider: { id: 'A', name: 'A', code: 'A' },
      },
      {
        providerId: 'B',
        status: 'OFFERED',
        offeredAt: opened,
        claimedAt: null,
        releasedAt: null,
        releaseReason: null,
        provider: { id: 'B', name: 'B', code: 'B' },
      },
    ],
    ...overrides,
  } as never;
}

describe('dispatch TTL and lazy expiration', () => {
  it('opens for the configured minutes and closes exactly at expiresAt', () => {
    expect(expiresAt.toISOString()).toBe('2026-09-17T10:10:00.000Z');
    const open = { status: 'OPEN' as const, expiresAt };
    expect(effectiveDispatchStatus(open, at(-1))).toBe('OPEN');
    expect(effectiveDispatchStatus(open, at(0))).toBe('EXPIRED');
    // A claim survives the window; terminal states never change.
    for (const status of ['CLAIMED', 'CANCELLED', 'EXPIRED'] as const)
      expect(
        effectiveDispatchStatus({ status, expiresAt }, at(3_600_000)),
      ).toBe(status);
  });
  it('configures DISPATCH_TTL_MINUTES with a default of 10 and sane bounds', () => {
    const base = {
      DATABASE_URL: 'postgresql://localhost/mandaria',
      JWT_ACCESS_SECRET: 'a'.repeat(40),
      JWT_REFRESH_SECRET: 'b'.repeat(40),
      INTEGRATION_JWT_SECRET: 'c'.repeat(40),
    };
    expect(validateEnvironment(base).DISPATCH_TTL_MINUTES).toBe(10);
    expect(
      validateEnvironment({ ...base, DISPATCH_TTL_MINUTES: '3' })
        .DISPATCH_TTL_MINUTES,
    ).toBe(3);
    for (const bad of ['0', '1441', 'x'])
      expect(() =>
        validateEnvironment({ ...base, DISPATCH_TTL_MINUTES: bad }),
      ).toThrow();
  });
});

describe('claim rules', () => {
  const offered = { status: 'OFFERED' as const };
  const dispatch = (
    status: string,
    claimedByProviderId: string | null = null,
  ) => ({ status, expiresAt, claimedByProviderId }) as never;
  it('allows only OPEN, in-window dispatches for OFFERED candidates', () => {
    expect(claimRejection(dispatch('OPEN'), offered, 'A', at(-1))).toBeNull();
    expect(claimRejection(dispatch('OPEN'), offered, 'A', at(0))).toBe(
      'DISPATCH_EXPIRED',
    );
    expect(claimRejection(dispatch('EXPIRED'), offered, 'A', at(-1))).toBe(
      'DISPATCH_EXPIRED',
    );
    expect(claimRejection(dispatch('CANCELLED'), offered, 'A', at(-1))).toBe(
      'DISPATCH_CANCELLED',
    );
    expect(claimRejection(dispatch('CLAIMED', 'B'), offered, 'A', at(-1))).toBe(
      'DISPATCH_ALREADY_CLAIMED',
    );
    expect(claimRejection(dispatch('CLAIMED', 'A'), offered, 'A', at(-1))).toBe(
      'ALREADY_OWNER',
    );
    expect(
      claimRejection(dispatch('OPEN'), { status: 'RELEASED' }, 'A', at(-1)),
    ).toBe('DISPATCH_RECLAIM_NOT_ALLOWED');
    for (const code of Object.keys(DISPATCH_ERRORS))
      expect(DISPATCH_ERRORS[code as keyof typeof DISPATCH_ERRORS]).toBe(409);
  });
});

describe('opening and cancellation inside the caller transaction', () => {
  const quote = {
    id: 'q1',
    deliveryRequestId: 'r1',
    serviceZoneId: 'z1',
    serviceType: 'LOCAL_DELIVERY' as const,
    distanceMeters: 6240,
  };
  // V1.10-C: the ACTIVE policy of each actor (PROVIDER 1/km, INDEPENDENT_DRIVER 2/km, minimum 3).
  const policyOf = (actorType: string) => ({
    id: 'policy-' + actorType,
    version: actorType === 'PROVIDER' ? 3 : 2,
    serviceType: 'LOCAL_DELIVERY',
    actorType,
    calculationType: 'PER_KM',
    creditsPerKm: actorType === 'PROVIDER' ? 1 : 2,
    minimumCredits: 3,
    flatCredits: null,
    ranges: [],
  });
  const tx = (eligible: string[], policies = true) => ({
    $queryRaw: vi.fn().mockResolvedValue(eligible.map((id) => ({ id }))),
    dispatch: {
      create: vi.fn(async ({ data }) => ({
        id: 'd1',
        expiresAt: data.expiresAt,
      })),
    },
    dispatchCandidate: { createMany: vi.fn() },
    creditPolicy: {
      findFirst: vi.fn(async ({ where }) =>
        policies ? policyOf(where.actorType) : null,
      ),
    },
    dispatchCreditSnapshot: { create: vi.fn(async ({ data }) => data) },
  });
  it('snapshots every eligible provider as OFFERED with the TTL window', async () => {
    const t = tx(['A', 'B']);
    const result = await openDispatch(t as never, quote, 10, opened);
    expect(t.dispatch.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          deliveryRequestId: 'r1',
          deliveryQuoteId: 'q1',
          openedAt: opened,
          expiresAt,
        },
      }),
    );
    expect(t.dispatchCandidate.createMany).toHaveBeenCalledWith({
      data: [
        { dispatchId: 'd1', providerId: 'A', offeredAt: opened },
        { dispatchId: 'd1', providerId: 'B', offeredAt: opened },
      ],
    });
    expect(result.providerIds).toEqual(['A', 'B']);
    // V1.10-C: one frozen cost per allowed actor, from the quote's canonical distance.
    expect(t.dispatchCreditSnapshot.create).toHaveBeenCalledTimes(2);
    expect(
      result.creditSnapshots.map((s) => [
        s.actorType,
        s.policyVersion,
        s.billableKm,
        s.credits,
      ]),
    ).toEqual([
      ['PROVIDER', 3, 7, 7],
      ['INDEPENDENT_DRIVER', 2, 7, 14],
    ]);
    expect(
      t.dispatchCreditSnapshot.create.mock.calls.every(
        ([args]: [{ data: { dispatchId: string; distanceMeters: number } }]) =>
          args.data.dispatchId === 'd1' && args.data.distanceMeters === 6240,
      ),
    ).toBe(true);
  });
  it('fails closed when an allowed actor has no ACTIVE credit policy', async () => {
    const t = tx(['A'], false);
    await expect(
      openDispatch(t as never, quote, 10, opened),
    ).rejects.toMatchObject({ code: 'CREDIT_POLICY_UNAVAILABLE' });
    expect(t.dispatchCreditSnapshot.create).not.toHaveBeenCalled();
    expect(t.dispatchCandidate.createMany).not.toHaveBeenCalled();
  });
  it('still opens the dispatch when no provider is eligible', async () => {
    const t = tx([]);
    const result = await openDispatch(t as never, quote, 10, opened);
    expect(t.dispatch.create).toHaveBeenCalledOnce();
    expect(t.dispatchCandidate.createMany).not.toHaveBeenCalled();
    expect(result.providerIds).toEqual([]);
  });
  it('cancels OPEN and CLAIMED dispatches of a cancelled request, expiring lapsed OPEN ones', async () => {
    const update = vi.fn();
    const t = {
      $queryRaw: vi.fn().mockResolvedValue([
        { id: 'open', status: 'OPEN', expiresAt, claimedByProviderId: null },
        {
          id: 'lapsed',
          status: 'OPEN',
          expiresAt: at(-60_000),
          claimedByProviderId: null,
        },
        {
          id: 'claimed',
          status: 'CLAIMED',
          expiresAt: at(-60_000),
          claimedByProviderId: 'A',
        },
      ]),
      dispatch: { update },
      deliveryAssignment: {
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn(),
      },
    };
    const { events, assignments } = await closeDispatchesForCancelledRequest(
      t as never,
      'r1',
      at(-1),
    );
    expect(assignments).toEqual([]);
    expect(events).toEqual([
      { event: 'DISPATCH_CANCELLED', dispatchId: 'open', providerId: null },
      { event: 'DISPATCH_EXPIRED', dispatchId: 'lapsed', providerId: null },
      { event: 'DISPATCH_CANCELLED', dispatchId: 'claimed', providerId: 'A' },
    ]);
    // The claim owner is not cleared: cancellation keeps who had claimed it.
    expect(update.mock.calls[2][0].data).toEqual({
      status: 'CANCELLED',
      cancelledAt: at(-1),
      cancellationReason: 'DELIVERY_REQUEST_CANCELLED',
    });
    expect(update.mock.calls[1][0].data).toEqual({
      status: 'EXPIRED',
      expiredAt: at(-1),
    });
  });
});

describe('data exposure per provider relation', () => {
  const json = (v: unknown) => JSON.stringify(v);
  it('OFFER shows what is needed to decide, without contacts, instructions, references or client', () => {
    const view = providerDispatchView(record(), 'A', at(-1));
    expect(view.access).toBe('OFFER');
    expect(view.service).toMatchObject({
      deliveryFee: { amount: '50.00', currency: 'MXN' },
      route: { distanceMeters: 4700, durationSeconds: 780 },
      pickup: { address: 'Origen 1', latitude: 16.7614, longitude: -93.3743 },
      goods: {
        paymentMode: 'COURIER_ADVANCE',
        value: '450.00',
        driverAdvancesGoods: true,
      },
    });
    for (const hidden of [
      'Restaurante Privado',
      '9610000001',
      'Tocar timbre',
      'ORDER-SECRET-REF',
      'client-uuid',
      'Pedido con nombre del cliente',
      'Mantener caliente',
      '"providerId":"B"',
    ])
      expect(json(view)).not.toContain(hidden);
  });
  it('OWNER gets full operational detail; others only a summary', () => {
    const claimed = record({
      status: 'CLAIMED',
      claimedByProviderId: 'A',
      claimedAt: opened,
    });
    const owner = providerDispatchView(claimed, 'A', at(-1));
    expect(owner.access).toBe('OWNER');
    expect(json(owner)).toContain('9610000001');
    expect(json(owner)).toContain('ORDER-SECRET-REF');
    expect(json(owner)).not.toContain('client-uuid');
    const other = providerDispatchView(claimed, 'B', at(-1));
    expect(other).toMatchObject({
      access: 'SUMMARY',
      service: null,
      claimedByMe: false,
      claimedAt: null,
    });
    expect(providerDispatchView(record(), 'A', at(0))).toMatchObject({
      status: 'EXPIRED',
      access: 'SUMMARY',
      service: null,
    });
  });
  it('flags OPEN dispatches nobody can claim without a dedicated status', () => {
    expect(adminDispatchView(record({ candidates: [] }), at(-1))).toMatchObject(
      {
        status: 'OPEN',
        noProviderAvailable: true,
      },
    );
    expect(adminDispatchView(record(), at(-1)).noProviderAvailable).toBe(false);
  });
});

describe('DispatchService authorization inside the transaction', () => {
  const service = (candidate: unknown, eligible: string[] = ['A']) => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'd1',
          status: 'OPEN',
          expiresAt: new Date(Date.now() + 60_000),
          claimedByProviderId: null,
          serviceZoneId: 'z1',
          serviceType: 'LOCAL_DELIVERY',
        },
      ])
      .mockResolvedValue(eligible.map((id) => ({ id })));
    const tx = {
      $queryRaw: queryRaw,
      dispatch: { update: vi.fn() },
      dispatchCandidate: {
        findUnique: vi.fn().mockResolvedValue(candidate),
        update: vi.fn(),
      },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    return {
      tx,
      service: new DispatchService(
        prisma as unknown as PrismaService,
        new ConfigService({ LOCAL_DELIVERY_ASSIGNMENT_TTL_MINUTES: 5 }),
      ),
    };
  };
  const status = (p: Promise<unknown>) =>
    p.then(
      () => 200,
      (e: { getStatus(): number; code?: string }) =>
        `${e.getStatus()} ${e.code ?? ''}`.trim(),
    );
  it('treats a non-candidate like a missing dispatch and never writes', async () => {
    const { tx, service: s } = service(null);
    expect(await status(s.claim('d1', 'C', 'u'))).toBe('404');
    expect(tx.dispatch.update).not.toHaveBeenCalled();
  });
  it('re-checks eligibility before claiming', async () => {
    const { tx, service: s } = service({ status: 'OFFERED' }, []);
    expect(await status(s.claim('d1', 'A', 'u'))).toBe(
      '409 PROVIDER_NOT_ELIGIBLE',
    );
    expect(tx.dispatchCandidate.update).not.toHaveBeenCalled();
  });
  it('rejects releases from providers that do not hold the claim', async () => {
    const { tx, service: s } = service({ status: 'OFFERED' });
    expect(await status(s.release('d1', 'A', 'motivo', 'u'))).toBe(
      '409 DISPATCH_NOT_CLAIMED_BY_PROVIDER',
    );
    expect(tx.dispatch.update).not.toHaveBeenCalled();
  });
});
