import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  IdempotencyService,
  canonicalJson,
  fingerprint,
} from '../dist/idempotency/idempotency.service.js';
import {
  formatPublicId,
  normalizeDeliveryRequest,
} from '../dist/delivery-requests/delivery-requests.service.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const stop = (type: string, sequence: number) => ({
  type,
  sequence,
  address: 'Av. Central 123',
  latitude: 16.75,
  longitude: -93.11,
  contactName: 'Contacto',
  contactPhone: '9611234567',
});
const request = (overrides: Record<string, unknown> = {}) =>
  ({
    externalReference: 'ORDER-1842',
    stops: [stop('PICKUP', 1), stop('DROPOFF', 2)],
    packages: [{ category: 'FOOD', description: 'Pedido', quantity: 2 }],
    financialContext: {
      goodsValue: '450',
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
    },
    ...overrides,
  }) as never;
const status = async (fn: () => unknown) => {
  try {
    await fn();
    return 'ok';
  } catch (error) {
    return (error as { status?: number }).status;
  }
};

describe('V1.5 delivery request rules', () => {
  it('formats sequence values as MDR ids without truncating beyond six digits', () => {
    expect(formatPublicId(1n)).toBe('MDR-000001');
    expect(formatPublicId(123456)).toBe('MDR-123456');
    expect(formatPublicId(1234567n)).toBe('MDR-1234567');
  });

  it('accepts exactly PICKUP #1 and DROPOFF #2 in any array order', async () => {
    const normalized = normalizeDeliveryRequest(
      request({ stops: [stop('DROPOFF', 2), stop('PICKUP', 1)] }),
    );
    expect(normalized.stops.map((s) => s.type)).toEqual(['PICKUP', 'DROPOFF']);
    for (const stops of [
      [stop('PICKUP', 1), stop('PICKUP', 2)],
      [stop('DROPOFF', 1), stop('DROPOFF', 2)],
      [stop('DROPOFF', 1), stop('PICKUP', 2)],
      [stop('PICKUP', 1), stop('DROPOFF', 1)],
    ])
      expect(
        await status(() => normalizeDeliveryRequest(request({ stops }))),
      ).toBe(400);
  });

  it('enforces PREPAID/COURIER_ADVANCE goods value rules and canonical money', async () => {
    const financial = (goodsPaymentMode: string, goodsValue?: unknown) =>
      request({
        financialContext: { goodsPaymentMode, goodsValue, currency: 'MXN' },
      });
    expect(
      normalizeDeliveryRequest(financial('PREPAID', '450')).financialContext,
    ).toEqual({
      goodsValue: '450.00',
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
    });
    expect(
      normalizeDeliveryRequest(financial('PREPAID', null)).financialContext
        .goodsValue,
    ).toBeNull();
    expect(
      normalizeDeliveryRequest(financial('PREPAID')).financialContext
        .goodsValue,
    ).toBeNull();
    expect(
      normalizeDeliveryRequest(financial('COURIER_ADVANCE', '450.5'))
        .financialContext.goodsValue,
    ).toBe('450.50');
    for (const [mode, value] of [
      ['COURIER_ADVANCE', null],
      ['COURIER_ADVANCE', undefined],
      ['COURIER_ADVANCE', '0'],
      ['PREPAID', '0.00'],
    ])
      expect(
        await status(() =>
          normalizeDeliveryRequest(financial(mode as string, value)),
        ),
      ).toBe(400);
  });

  it('applies package defaults so omitted and explicit defaults fingerprint equally', () => {
    const explicit = normalizeDeliveryRequest(
      request({
        packages: [
          {
            category: 'FOOD',
            description: 'Pedido',
            quantity: 2,
            isFragile: false,
            weightKg: null,
          },
        ],
        financialContext: {
          goodsValue: '450.00',
          goodsPaymentMode: 'PREPAID',
          currency: 'MXN',
        },
      }),
    );
    const implicit = normalizeDeliveryRequest(request());
    expect(fingerprint('op', explicit)).toBe(fingerprint('op', implicit));
    expect(implicit.packages[0]).toMatchObject({
      isFragile: false,
      weightKg: null,
    });
  });

  it('canonical JSON ignores key order and undefined, but not values or array order', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [2, 1] } })).toBe(
      '{"a":{"c":[2,1]},"b":1}',
    );
    expect(fingerprint('op', { a: 1, b: 2 })).toBe(
      fingerprint('op', { b: 2, a: 1 }),
    );
    expect(fingerprint('op', { a: 1 })).not.toBe(fingerprint('op', { a: 2 }));
    expect(fingerprint('op', [1, 2])).not.toBe(fingerprint('op', [2, 1]));
    expect(fingerprint('create', { a: 1 })).not.toBe(
      fingerprint('cancel', { a: 1 }),
    );
    expect(fingerprint('op', {})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('IdempotencyService', () => {
  const scope = {
    integrationClientId: 'client',
    key: 'key-12345678',
    operation: 'delivery_requests.create',
    resourceType: 'DeliveryRequest',
  };
  const record = (payload: unknown) => ({
    requestHash: fingerprint(scope.operation, payload),
    resourceId: 'resource',
    resourceType: 'DeliveryRequest',
  });
  const service = (
    findUnique: ReturnType<typeof vi.fn>,
    transaction: ReturnType<typeof vi.fn>,
  ) =>
    new IdempotencyService({
      apiIdempotencyRecord: { findUnique },
      $transaction: transaction,
    } as unknown as PrismaService);

  it('replays the same payload without opening a transaction and never stores the payload', async () => {
    const transaction = vi.fn();
    const load = vi.fn().mockResolvedValue('loaded');
    const result = await service(
      vi.fn().mockResolvedValue(record({ a: 1 })),
      transaction,
    ).execute(scope, { a: 1 }, vi.fn(), load);
    expect(result).toEqual({ result: 'loaded', replayed: true });
    expect(transaction).not.toHaveBeenCalled();
    expect(load).toHaveBeenCalledWith('resource');
  });

  it('rejects the same key with a different payload (409) without creating', async () => {
    const create = vi.fn();
    await expect(
      service(vi.fn().mockResolvedValue(record({ a: 1 })), vi.fn()).execute(
        scope,
        { a: 2 },
        create,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it('inserts the ledger row before creating, inside one transaction', async () => {
    const order: string[] = [];
    const tx = {
      apiIdempotencyRecord: {
        create: vi.fn(async ({ data }) => {
          order.push('ledger');
          expect(data).toMatchObject({
            ...scope,
            requestHash: fingerprint(scope.operation, { a: 1 }),
          });
          expect(JSON.stringify(data)).not.toContain('"a":1');
        }),
      },
    };
    const transaction = vi.fn(async (fn: (t: typeof tx) => Promise<void>) =>
      fn(tx),
    );
    const create = vi.fn(async () => {
      order.push('resource');
    });
    const result = await service(
      vi.fn().mockResolvedValue(null),
      transaction,
    ).execute(scope, { a: 1 }, create, vi.fn().mockResolvedValue('created'));
    expect(order).toEqual(['ledger', 'resource']);
    expect(result.replayed).toBe(false);
  });

  it('turns a concurrent unique violation into a replay or a conflict', async () => {
    const unique = new Prisma.PrismaClientKnownRequestError('duplicate', {
      code: 'P2002',
      clientVersion: 'test',
    });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ a: 1 }));
    const replay = await service(
      findUnique,
      vi.fn().mockRejectedValue(unique),
    ).execute(scope, { a: 1 }, vi.fn(), vi.fn().mockResolvedValue('winner'));
    expect(replay).toEqual({ result: 'winner', replayed: true });
    const conflict = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(record({ a: 1 }));
    await expect(
      service(conflict, vi.fn().mockRejectedValue(unique)).execute(
        scope,
        { a: 9 },
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const failure = new Error('database down');
    await expect(
      service(
        vi.fn().mockResolvedValue(null),
        vi.fn().mockRejectedValue(failure),
      ).execute(scope, { a: 1 }, vi.fn(), vi.fn()),
    ).rejects.toBe(failure);
  });
});
