import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  prepareQuotePricing,
  validateQuoteRatePlan,
  evaluateQuotePrice,
  buildDeliveryQuoteSnapshot,
  type QuotePricingConfiguration,
} from '../src/pricing/quote-pricing.js';

const configuration = (): QuotePricingConfiguration => ({
  zone: { id: 'zone', currency: 'MXN' },
  plan: {
    id: 'plan',
    version: 2,
    currency: 'MXN',
    calculationType: 'DISTANCE_BANDS',
    quoteValidityMinutes: 15,
    bands: [
      {
        id: 'first',
        minDistanceMeters: 0,
        maxDistanceMeters: 1000,
        amount: new Prisma.Decimal('25.10'),
        currency: 'MXN',
      },
      {
        id: 'second',
        minDistanceMeters: 1000,
        maxDistanceMeters: 3000,
        amount: new Prisma.Decimal('40.99'),
        currency: 'MXN',
      },
    ],
  },
});
const origin = { latitude: 16.7, longitude: -93.3 };
const destination = { latitude: 16.71, longitude: -93.31 };
const route = (distanceMeters: number) => ({
  distanceMeters,
  durationSeconds: 123,
  routingProvider: 'controlled',
  calculatedAt: new Date('2026-09-28T12:00:08Z'),
});
const tx = {} as Prisma.TransactionClient;
const dependencies = (config = configuration()) => ({
  zones: { resolveActive: vi.fn().mockResolvedValue([config.zone]) },
  plans: { findActive: vi.fn().mockResolvedValue(config.plan) },
});
const domainError = (code: string, statusCode: number, message: string) => ({
  code,
  status: statusCode,
  response: { code, message },
});

describe('Shared quote pricing — preparation and error precedence', () => {
  it('resolves pickup, dropoff, then tariff on exactly the supplied transaction', async () => {
    const config = configuration();
    const deps = dependencies(config);
    expect(
      await prepareQuotePricing(
        tx,
        origin,
        destination,
        'LOCAL_DELIVERY',
        deps,
      ),
    ).toEqual(config);
    expect(deps.zones.resolveActive.mock.calls).toEqual([
      [origin, tx],
      [destination, tx],
    ]);
    expect(deps.plans.findActive.mock.calls).toEqual([
      ['zone', 'LOCAL_DELIVERY', tx],
    ]);
    expect(deps.zones.resolveActive.mock.invocationCallOrder[1]).toBeLessThan(
      deps.plans.findActive.mock.invocationCallOrder[0],
    );
  });

  it.each([
    [
      [],
      [{ id: 'zone' }],
      'OUT_OF_SERVICE_AREA',
      422,
      'Pickup is outside every active service zone',
    ],
    [
      [{ id: 'zone' }],
      [],
      'OUT_OF_SERVICE_AREA',
      422,
      'Dropoff is outside every active service zone',
    ],
    [
      [{ id: 'zone' }, { id: 'other' }],
      [],
      'OUT_OF_SERVICE_AREA',
      422,
      'Dropoff is outside every active service zone',
    ],
    [
      [{ id: 'zone' }, { id: 'other' }],
      [{ id: 'zone' }],
      'SERVICE_ZONE_AMBIGUOUS',
      503,
      'A stop matches more than one active service zone',
    ],
    [
      [{ id: 'zone' }],
      [{ id: 'other' }],
      'CROSS_ZONE_NOT_SUPPORTED',
      422,
      'LOCAL_DELIVERY requires pickup and dropoff in the same service zone',
    ],
  ])(
    'preserves coverage errors and precedence: %s / %s',
    async (pickup, dropoff, code, status, message) => {
      const deps = dependencies();
      deps.zones.resolveActive
        .mockReset()
        .mockResolvedValueOnce(pickup)
        .mockResolvedValueOnce(dropoff);
      await expect(
        prepareQuotePricing(tx, origin, destination, 'LOCAL_DELIVERY', deps),
      ).rejects.toMatchObject(
        domainError(code as string, status as number, message as string),
      );
      expect(deps.zones.resolveActive).toHaveBeenCalledTimes(2);
      expect(deps.plans.findActive).not.toHaveBeenCalled();
    },
  );

  it('keeps the missing-plan error', async () => {
    const deps = dependencies();
    deps.plans.findActive.mockResolvedValue(null);
    await expect(
      prepareQuotePricing(tx, origin, destination, 'LOCAL_DELIVERY', deps),
    ).rejects.toMatchObject(
      domainError(
        'RATE_CONFIGURATION_UNAVAILABLE',
        503,
        'No active rate plan for this zone and service type',
      ),
    );
  });

  it.each([
    'calculationType',
    'zoneCurrency',
    'bandCurrency',
    'emptyBands',
    'gap',
    'amount',
  ])(
    'preparation rejects invalid %s before a caller can route',
    async (invalid) => {
      const config = configuration();
      if (invalid === 'calculationType')
        config.plan.calculationType = 'OTHER' as never;
      if (invalid === 'zoneCurrency') config.zone.currency = 'USD';
      if (invalid === 'bandCurrency') config.plan.bands[0].currency = 'USD';
      if (invalid === 'emptyBands') config.plan.bands = [];
      if (invalid === 'gap') config.plan.bands[1].minDistanceMeters++;
      if (invalid === 'amount')
        config.plan.bands[0].amount = new Prisma.Decimal(0);
      const expected = domainError(
        'RATE_CONFIGURATION_INVALID',
        503,
        'Active rate plan is inconsistent',
      );
      expect(() => validateQuoteRatePlan(config)).toThrowError(
        'Active rate plan is inconsistent',
      );
      await expect(
        prepareQuotePricing(
          tx,
          origin,
          destination,
          'LOCAL_DELIVERY',
          dependencies(config),
        ),
      ).rejects.toMatchObject(expected);
    },
  );
});

describe('Shared quote pricing — pure evaluation and explicit snapshot', () => {
  it.each([
    [0, 0],
    [999, 0],
    [1000, 1],
    [2999, 1],
  ])(
    'prices %i meters using band %i without Decimal conversion',
    (distance, index) => {
      const config = configuration();
      const result = evaluateQuotePrice(config, route(distance));
      expect(result.band).toBe(config.plan.bands[index]);
      expect(result.amount).toBe(config.plan.bands[index].amount);
      expect(result.amount).toBeInstanceOf(Prisma.Decimal);
      expect(result.amount.toFixed(2)).toBe(index === 0 ? '25.10' : '40.99');
      expect(result.currency).toBe('MXN');
    },
  );

  it('rejects the exclusive maximum with the exact legacy error', () => {
    try {
      evaluateQuotePrice(configuration(), route(3000));
      expect.fail('must reject unsupported distance');
    } catch (error) {
      expect(error).toMatchObject(
        domainError(
          'DISTANCE_NOT_SUPPORTED',
          422,
          'Route distance exceeds the supported rate bands',
        ),
      );
    }
  });

  it('uses supplied identifiers, route and issuance/expiry without applying tariff TTL', () => {
    const config = configuration();
    const calculatedRoute = route(1000);
    const price = evaluateQuotePrice(config, calculatedRoute);
    const createdAt = new Date('2026-09-28T12:10:00Z');
    // Deliberately different from the plan TTL: policy belongs to the caller.
    const expiresAt = new Date('2026-09-28T12:11:23Z');
    const snapshot = buildDeliveryQuoteSnapshot(
      {
        publicId: 'MQ-000123',
        deliveryRequestId: 'request',
        serviceType: 'LOCAL_DELIVERY',
      },
      config,
      calculatedRoute,
      price,
      { createdAt, expiresAt },
    );
    expect(snapshot).toEqual({
      publicId: 'MQ-000123',
      deliveryRequestId: 'request',
      serviceType: 'LOCAL_DELIVERY',
      serviceZoneId: 'zone',
      ratePlanId: 'plan',
      rateBandId: 'second',
      distanceMeters: 1000,
      durationSeconds: 123,
      amount: new Prisma.Decimal('40.99'),
      currency: 'MXN',
      routingProvider: 'controlled',
      routeCalculatedAt: calculatedRoute.calculatedAt,
      createdAt,
      expiresAt,
    });
    expect(snapshot.amount).toBe(price.amount);
    expect(snapshot.createdAt).toBe(createdAt);
    expect(snapshot.expiresAt).toBe(expiresAt);
  });
});
