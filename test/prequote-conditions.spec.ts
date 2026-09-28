import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import {
  normalizePrequoteConditions,
  prequoteEffectiveStatus,
} from '../src/delivery-prequotes/prequote-conditions.js';
import {
  canonicalJson,
  fingerprint,
} from '../src/idempotency/idempotency.service.js';
const input = () => ({
  conditionsVersion: 1,
  serviceType: 'LOCAL_DELIVERY',
  stops: [
    { type: 'PICKUP', sequence: 1, latitude: 16.123456, longitude: -93.123456 },
    { type: 'DROPOFF', sequence: 2, latitude: 16.2, longitude: -93.2 },
  ],
  packages: [
    { category: 'FOOD', quantity: 1 },
    { category: 'FOOD', quantity: 2 },
    { category: 'FOOD', quantity: 1 },
  ],
});
describe('Prequote conditions, separate from legacy', () => {
  it('canonicalizes ordering and omitted/null measurements without removing duplicates', () => {
    const a = input();
    const b = input();
    b.packages.reverse();
    b.stops.reverse();
    const normalized = normalizePrequoteConditions(a);
    expect(normalizePrequoteConditions(b)).toEqual(normalized);
    expect(normalized.packages).toHaveLength(3);
    expect(normalized.packages.filter((p) => p.quantity === 1)).toHaveLength(2);
    expect(normalized.packages[0]).toMatchObject({
      weightKg: null,
      lengthCm: null,
      widthCm: null,
      heightCm: null,
      isFragile: false,
    });
    expect(
      normalizePrequoteConditions({ ...a, packages: normalized.packages }),
    ).toEqual(normalized);
    expect(fingerprint('delivery_prequotes.create', normalized)).toBe(
      fingerprint('delivery_prequotes.create', normalizePrequoteConditions(b)),
    );
    expect(canonicalJson(a.packages)).not.toBe(
      canonicalJson([...a.packages].sort((x, y) => y.quantity - x.quantity)),
    ); // legacy arrays retain order
  });
  it.each([
    (v: ReturnType<typeof input>) => ({ ...v, conditionsVersion: 2 }),
    (v: ReturnType<typeof input>) => ({ ...v, serviceType: 'FREIGHT' }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      financialContext: { goodsPaymentMode: 'PREPAID' },
    }),
    (v: ReturnType<typeof input>) => ({ ...v, scheduledAt: 'tomorrow' }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      stops: [{ ...v.stops[0], latitude: 16.1234567 }, v.stops[1]],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      stops: [{ ...v.stops[0], latitude: 91 }, v.stops[1]],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      stops: [{ ...v.stops[0], contactName: 'not allowed' }, v.stops[1]],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      stops: [v.stops[0], v.stops[0]],
    }),
    (v: ReturnType<typeof input>) => ({ ...v, packages: [] }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      packages: [{ category: 'OTHER', quantity: 1 }],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      packages: [{ category: 'FOOD', quantity: 0 }],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      packages: [{ category: 'FOOD', quantity: 1, weightKg: 0.0001 }],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      packages: [{ category: 'FOOD', quantity: 1, lengthCm: 1.001 }],
    }),
    (v: ReturnType<typeof input>) => ({
      ...v,
      packages: [{ category: 'FOOD', quantity: 1, isFragile: null }],
    }),
  ])('rejects invalid or extraneous conditions %#', (mutate) =>
    expect(() => normalizePrequoteConditions(mutate(input()))).toThrow(
      'Invalid prequote conditions',
    ),
  );
  it('accepts six decimal coordinates, finite measurements and preserves exact expiry', () => {
    expect(normalizePrequoteConditions(input()).stops[0].latitude).toBe(
      16.123456,
    );
    const expiresAt = new Date('2026-09-28T12:00:00Z');
    expect(
      prequoteEffectiveStatus({ expiresAt }, new Date(expiresAt.getTime() - 1)),
    ).toBe('OFFERED');
    expect(prequoteEffectiveStatus({ expiresAt }, expiresAt)).toBe('EXPIRED');
    expect(
      prequoteEffectiveStatus({ expiresAt }, new Date(expiresAt.getTime() + 1)),
    ).toBe('EXPIRED');
  });
});
