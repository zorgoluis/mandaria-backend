import { describe, it, expect, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { ConvertPrequoteDto } from '../src/delivery-prequotes/prequote-conversion.dto.js';
import {
  conversionPayload,
  PrequoteConversionService,
} from '../src/delivery-prequotes/prequote-conversion.service.js';
import { fingerprint } from '../src/idempotency/idempotency.service.js';
const body = () => ({
  conditionsVersion: 1,
  deliveryRequest: {
    serviceType: 'LOCAL_DELIVERY',
    stops: [
      {
        type: 'PICKUP',
        sequence: 1,
        latitude: 10,
        longitude: 10,
        address: 'Example pickup',
        contactName: 'Fixture',
        contactPhone: '0000000000',
      },
      {
        type: 'DROPOFF',
        sequence: 2,
        latitude: 11,
        longitude: 11,
        address: 'Example dropoff',
        contactName: 'Fixture',
        contactPhone: '0000000000',
      },
    ],
    packages: [
      { category: 'FOOD', description: 'Food', quantity: 1 },
      { category: 'FOOD', description: 'Food 2', quantity: 2 },
    ],
    financialContext: {
      goodsPaymentMode: 'PREPAID',
      currency: 'MXN',
      goodsValue: '150',
    },
  },
  merchantConfirmation: {
    goodsPaymentStatus: 'CONFIRMED_BY_MERCHANT',
    goodsPaymentReference: ' receipt ',
    goodsPaymentConfirmedAt: '2026-01-01T06:00:00+06:00',
    orderAcceptanceStatus: 'ACCEPTED_BY_MERCHANT',
    orderAcceptanceReference: ' order ',
    orderAcceptedAt: '2026-01-01T00:00:00Z',
  },
  deliveryCollectionInstruction: {
    payer: 'RECIPIENT',
    method: 'CASH',
    dueAt: 'DELIVERY',
    components: ['DELIVERY_FEE'],
  },
});
const normalized = (input: unknown) => {
  const dto = plainToInstance(ConvertPrequoteDto, input);
  expect(
    validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }),
  ).toHaveLength(0);
  return conversionPayload('MPQ-000001', dto);
};
describe('B2 normalization and retry identity', () => {
  it('normalizes dates, monetary values, references and optional physical defaults', () => {
    const { conditions, payload } = normalized(body());
    expect(payload.merchantConfirmation?.goodsPaymentConfirmedAt).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(payload.merchantConfirmation?.goodsPaymentReference).toBe('receipt');
    expect(payload.deliveryRequest.financialContext.goodsValue).toBe('150.00');
    expect(conditions.packages[0].weightKg).toBeNull();
    expect(conditions.packages[0].isFragile).toBe(false);
  });
  it('physical order is canonical but legacy package order remains part of retry payload', () => {
    const a = body(),
      b = body();
    b.deliveryRequest.packages.reverse();
    const x = normalized(a),
      y = normalized(b);
    expect(x.conditions).toEqual(y.conditions);
    expect(x.payload.deliveryRequest.packages[0].quantity).toBe(1);
    expect(y.payload.deliveryRequest.packages[0].quantity).toBe(2);
    expect(fingerprint('delivery_prequotes.convert', x.payload)).not.toBe(
      fingerprint('delivery_prequotes.convert', y.payload),
    );
  });
  it('multiplicity is retained, not collapsed into total quantity', () => {
    const a = body();
    a.deliveryRequest.packages = [
      a.deliveryRequest.packages[0],
      { ...a.deliveryRequest.packages[0] },
    ];
    const x = normalized(a);
    expect(x.conditions.packages).toHaveLength(2);
    expect(x.conditions.packages[0]).toEqual(x.conditions.packages[1]);
  });
  it('textual changes affect fingerprint without repricing physical conditions', () => {
    const a = body(),
      b = body();
    b.deliveryRequest.stops[0].address = 'Different text';
    const x = normalized(a),
      y = normalized(b);
    expect(x.conditions).toEqual(y.conditions);
    expect(x.payload).not.toEqual(y.payload);
  });
  it('source publicId is part of the retry identity', () => {
    const dto = plainToInstance(ConvertPrequoteDto, body());
    expect(conversionPayload('MPQ-000001', dto).payload).not.toEqual(
      conversionPayload('MPQ-000002', dto).payload,
    );
  });
  it('rejects unknown nested financial evidence', () => {
    const input = body();
    Object.assign(input.merchantConfirmation, { bankAccount: 'not-accepted' });
    expect(
      validateSync(plainToInstance(ConvertPrequoteDto, input), {
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    ).not.toHaveLength(0);
  });
});

// Simulated exact DB clock boundary in the actual service; real deferred expiry is covered by E2E.
it('rejects equality at expiry using the DB clock before construction', async () => {
  const expiresAt = new Date('2026-09-28T12:00:00.000Z');
  const create = vi.fn();
  const tx = {
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([{ id: 'source' }])
      .mockResolvedValueOnce([{ status: 'ACTIVE' }])
      .mockResolvedValueOnce([{ now: expiresAt }]),
    deliveryPrequote: {
      findUniqueOrThrow: vi
        .fn()
        .mockResolvedValue({ id: 'source', serviceZoneId: 'zone', expiresAt }),
    },
    prequoteConversion: { findUnique: vi.fn().mockResolvedValue(null), create },
  };
  const idem = {
    execute: async (
      _scope: unknown,
      _payload: unknown,
      callback: (tx: unknown, id: string) => Promise<void>,
    ) => callback(tx, 'conversion'),
  };
  const service = new PrequoteConversionService(
    {} as never,
    idem as never,
    { get: () => true } as never,
  );
  await expect(
    service.convert(
      'owner',
      'MPQ-000001',
      'boundary-key',
      plainToInstance(ConvertPrequoteDto, body()),
    ),
  ).rejects.toMatchObject({ code: 'PREQUOTE_EXPIRED' });
  expect(create).not.toHaveBeenCalled();
});
import { Prisma } from '@prisma/client';
it('does not translate arbitrary Prisma metadata containing a business code', async () => {
  const error = new Prisma.PrismaClientKnownRequestError(
    'Unrelated persistence failure',
    {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['PREQUOTE_EXPIRED'] },
    },
  );
  const service = new PrequoteConversionService(
    {} as never,
    {
      execute: async () => {
        throw error;
      },
    } as never,
    { get: () => true } as never,
  );
  await expect(
    service.convert(
      'owner',
      'MPQ-000001',
      'unrelated-key',
      plainToInstance(ConvertPrequoteDto, body()),
    ),
  ).rejects.toBe(error);
});
