import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  MAX_DISTANCE_METERS,
  MAX_POLICY_CREDITS,
  MAX_POLICY_RANGES,
  billableKilometers,
  calculateCreditCost,
  findRange,
  formatKilometers,
  validatePolicyConfig,
} from '../dist/credit-policies/credit-policy-engine.js';
import type { PolicyForCalculation } from '../dist/credit-policies/credit-policy-engine.js';
import {
  CreateCreditPolicyDto,
  CreditCostQueryDto,
} from '../dist/credit-policies/credit-policies.dto.js';
import { CreditPoliciesService } from '../dist/credit-policies/credit-policies.service.js';
import { MAX_CREDIT_MOVEMENT } from '../dist/credits/credit-policy.js';
import type { PrismaService } from '../dist/prisma/prisma.service.js';

const policy = (over: Partial<PolicyForCalculation>): PolicyForCalculation => ({
  id: '00000000-0000-4000-8000-000000000001',
  version: 1,
  serviceType: 'LOCAL_DELIVERY',
  actorType: 'PROVIDER',
  calculationType: 'PER_KM',
  creditsPerKm: 1,
  minimumCredits: 3,
  flatCredits: null,
  ranges: [],
  ...over,
});
const cost = (p: PolicyForCalculation, distanceMeters: number) =>
  calculateCreditCost({ policy: p, distanceMeters }).credits;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};
/** [0,3000) 3 · [3000,5000) 5 · [5000,10000) 8 · [10000,∞) 15 */
const RANGES = [
  { minDistanceMeters: 0, maxDistanceMeters: 3000, credits: 3 },
  { minDistanceMeters: 3000, maxDistanceMeters: 5000, credits: 5 },
  { minDistanceMeters: 5000, maxDistanceMeters: 10000, credits: 8 },
  { minDistanceMeters: 10000, maxDistanceMeters: null, credits: 15 },
];
const rangePolicy = policy({
  calculationType: 'DISTANCE_RANGE',
  creditsPerKm: null,
  minimumCredits: null,
  ranges: RANGES.map((r, i) => ({ ...r, position: i + 1 })),
});
const errorsOf = async (cls: new () => object, body: object) =>
  (
    await validate(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    })
  ).map((e) => e.property);

afterEach(() => vi.useRealTimers());

describe('V1.10-B PER_KM', () => {
  it('bills whole kilometers rounded up, with integer arithmetic only', () => {
    for (const [meters, km] of [
      [0, 0],
      [1, 1],
      [999, 1],
      [1000, 1],
      [1001, 2],
      [6240, 7],
      [10000, 10],
      [MAX_DISTANCE_METERS, 2147484],
    ])
      expect(billableKilometers(meters), `${meters} m`).toBe(km);
    expect(formatKilometers(6240)).toBe('6.240');
    expect(formatKilometers(800)).toBe('0.800');
    expect(formatKilometers(0)).toBe('0.000');
  });

  it('applies the minimum: 1 credit/km, minimum 3', () => {
    for (const [meters, credits] of [
      [0, 3],
      [1, 3],
      [999, 3],
      [1000, 3],
      [1001, 3],
      [2001, 3],
      [3001, 4],
      [6240, 7],
    ])
      expect(cost(policy({}), meters), `${meters} m`).toBe(credits);
    const detail = calculateCreditCost({
      policy: policy({}),
      distanceMeters: 6240,
    });
    expect(detail).toMatchObject({
      policyVersion: 1,
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'PROVIDER',
      calculationType: 'PER_KM',
      distanceMeters: 6240,
      distanceKm: '6.240',
      billableKm: 7,
      calculatedCredits: 7,
      minimumCredits: 3,
      minimumApplied: false,
      credits: 7,
    });
    expect(
      calculateCreditCost({ policy: policy({}), distanceMeters: 800 }),
    ).toMatchObject({
      billableKm: 1,
      calculatedCredits: 1,
      minimumApplied: true,
      credits: 3,
    });
  });

  it('scales with the rate once the minimum no longer dominates', () => {
    const p = policy({ creditsPerKm: 2, minimumCredits: 5 });
    expect(cost(p, 1000)).toBe(5); // 1 km * 2 = 2 < 5
    expect(cost(p, 2001)).toBe(6); // 3 km * 2 = 6
    expect(cost(p, 6240)).toBe(14); // 7 km * 2
    expect(cost(policy({ minimumCredits: 0 }), 0)).toBe(0); // explicit minimum 0, distance 0
    expect(cost(policy({ minimumCredits: 0 }), 1)).toBe(1);
  });

  it('refuses a cost above the per-service limit instead of wrapping or truncating', () => {
    const p = policy({ creditsPerKm: MAX_POLICY_CREDITS, minimumCredits: 0 });
    expect(cost(p, 1000)).toBe(MAX_POLICY_CREDITS);
    expect(codeOf(() => cost(p, 1001))).toBe('CREDIT_COST_OUT_OF_RANGE');
    expect(codeOf(() => cost(p, MAX_DISTANCE_METERS))).toBe(
      'CREDIT_COST_OUT_OF_RANGE',
    );
    expect(MAX_POLICY_CREDITS).toBe(MAX_CREDIT_MOVEMENT);
  });
});

describe('V1.10-B FLAT', () => {
  it('costs the same whatever the distance', () => {
    const p = policy({
      calculationType: 'FLAT',
      creditsPerKm: null,
      minimumCredits: null,
      flatCredits: 5,
    });
    for (const meters of [0, 1, 999, 1000, 6240, 100000, MAX_DISTANCE_METERS])
      expect(cost(p, meters), `${meters} m`).toBe(5);
    expect(
      calculateCreditCost({ policy: p, distanceMeters: 6240 }),
    ).toMatchObject({
      billableKm: null,
      calculatedCredits: null,
      minimumApplied: false,
      rangePosition: null,
    });
  });
});

describe('V1.10-B DISTANCE_RANGE', () => {
  it('maps every boundary to exactly one range, [min, max)', () => {
    for (const [meters, credits, position] of [
      [0, 3, 1],
      [1, 3, 1],
      [2999, 3, 1],
      [3000, 5, 2],
      [3001, 5, 2],
      [4999, 5, 2],
      [5000, 8, 3],
      [5001, 8, 3],
      [9999, 8, 3],
      [10000, 15, 4],
      [10001, 15, 4],
      [MAX_DISTANCE_METERS, 15, 4],
    ]) {
      const result = calculateCreditCost({
        policy: rangePolicy,
        distanceMeters: meters,
      });
      expect(result.credits, `${meters} m`).toBe(credits);
      expect(result.rangePosition, `${meters} m`).toBe(position);
      expect(
        rangePolicy.ranges.filter(
          (r) =>
            meters >= r.minDistanceMeters &&
            (r.maxDistanceMeters === null || meters < r.maxDistanceMeters),
        ),
      ).toHaveLength(1);
    }
  });

  it('fails closed on a corrupt range set instead of guessing', () => {
    const gap = {
      ...rangePolicy,
      ranges: rangePolicy.ranges.filter((r) => r.position !== 2),
    };
    expect(codeOf(() => cost(gap, 4000))).toBe('CREDIT_POLICY_UNAVAILABLE');
    const overlap = {
      ...rangePolicy,
      ranges: [
        ...rangePolicy.ranges,
        {
          position: 5,
          minDistanceMeters: 4000,
          maxDistanceMeters: 6000,
          credits: 99,
        },
      ],
    };
    expect(codeOf(() => cost(overlap, 4500))).toBe('CREDIT_POLICY_UNAVAILABLE');
    expect(findRange(gap.ranges, 4000)).toBeUndefined();
  });
});

describe('V1.10-B configuration rules', () => {
  const invalid = (config: object) =>
    validatePolicyConfig(config as never).errors;
  it('accepts exactly the fields of each calculation type', () => {
    expect(
      validatePolicyConfig({
        calculationType: 'PER_KM',
        creditsPerKm: 1,
        minimumCredits: 3,
      }).valid,
    ).toBe(true);
    expect(
      validatePolicyConfig({
        calculationType: 'PER_KM',
        creditsPerKm: 1,
        minimumCredits: 0,
      }).valid,
    ).toBe(true);
    expect(
      validatePolicyConfig({ calculationType: 'FLAT', flatCredits: 5 }).valid,
    ).toBe(true);
    const ranges = validatePolicyConfig({
      calculationType: 'DISTANCE_RANGE',
      ranges: [...RANGES].reverse(),
    });
    expect(ranges.valid).toBe(true);
    // Normalized: sorted by distance and numbered 1..n whatever order they were sent in.
    expect(ranges.ranges.map((r) => [r.position, r.minDistanceMeters])).toEqual(
      [
        [1, 0],
        [2, 3000],
        [3, 5000],
        [4, 10000],
      ],
    );
  });

  it('rejects fields of another type instead of ignoring them', () => {
    expect(
      invalid({
        calculationType: 'PER_KM',
        creditsPerKm: 1,
        minimumCredits: 3,
        flatCredits: 50,
      }),
    ).toContain('flatCredits is not allowed for calculationType PER_KM');
    expect(
      invalid({
        calculationType: 'PER_KM',
        creditsPerKm: 1,
        minimumCredits: 3,
        ranges: RANGES,
      }),
    ).toContain('ranges is not allowed for calculationType PER_KM');
    expect(
      invalid({ calculationType: 'FLAT', flatCredits: 5, creditsPerKm: 1 }),
    ).toContain('creditsPerKm is not allowed for calculationType FLAT');
    expect(
      invalid({ calculationType: 'FLAT', flatCredits: 5, minimumCredits: 0 }),
    ).toContain('minimumCredits is not allowed for calculationType FLAT');
    expect(
      invalid({
        calculationType: 'DISTANCE_RANGE',
        ranges: RANGES,
        flatCredits: 1,
      }),
    ).toContain(
      'flatCredits is not allowed for calculationType DISTANCE_RANGE',
    );
  });

  it('requires valid whole credits for each type', () => {
    for (const config of [
      { calculationType: 'PER_KM', minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 0, minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 1.5, minimumCredits: 3 },
      { calculationType: 'PER_KM', creditsPerKm: 1 },
      { calculationType: 'PER_KM', creditsPerKm: 1, minimumCredits: -1 },
      {
        calculationType: 'PER_KM',
        creditsPerKm: MAX_POLICY_CREDITS + 1,
        minimumCredits: 3,
      },
      { calculationType: 'FLAT' },
      { calculationType: 'FLAT', flatCredits: 0 },
      { calculationType: 'FLAT', flatCredits: 2.5 },
      { calculationType: 'DISTANCE_RANGE' },
      { calculationType: 'DISTANCE_RANGE', ranges: [] },
      { calculationType: 'OTHER' },
    ])
      expect(invalid(config).length, JSON.stringify(config)).toBeGreaterThan(0);
  });

  it('rejects gaps, overlaps, a first range after 0, a closed last range and open middle ranges', () => {
    const r = (min: number, max: number | null, credits = 3) => ({
      minDistanceMeters: min,
      maxDistanceMeters: max,
      credits,
    });
    const cases: [string, object[], RegExp][] = [
      ['overlap', [r(0, 5000), r(4000, null)], /overlap/],
      ['gap', [r(0, 5000), r(7000, null)], /gap between 5000 and 7000/],
      ['first range after 0', [r(100, null)], /first range must start at 0/],
      [
        'closed last range',
        [r(0, 3000), r(3000, 5000)],
        /last range must be open-ended/,
      ],
      [
        'open middle range',
        [r(0, null), r(3000, null)],
        /only the last range may be open-ended/,
      ],
      ['same start twice', [r(0, 3000), r(0, null)], /two ranges start at 0/],
      ['max <= min', [r(0, 0), r(0, null)], /greater than minDistanceMeters/],
      ['zero credits', [r(0, null, 0)], /credits must be an integer/],
      ['decimal credits', [r(0, null, 1.5)], /credits must be an integer/],
      ['negative start', [r(-1, null)], /minDistanceMeters must be an integer/],
    ];
    for (const [label, ranges, message] of cases)
      expect(
        invalid({ calculationType: 'DISTANCE_RANGE', ranges }).join(' | '),
        label,
      ).toMatch(message);
    const tooMany = Array.from({ length: MAX_POLICY_RANGES + 1 }, (_, i) =>
      r(i * 100, i === MAX_POLICY_RANGES ? null : (i + 1) * 100),
    );
    expect(
      invalid({ calculationType: 'DISTANCE_RANGE', ranges: tooMany }).join(
        ' | ',
      ),
    ).toMatch(/at most 50 ranges/);
  });
});

describe('V1.10-B canonical distance and determinism', () => {
  it('rejects distances that are not whole non-negative INTEGER meters', () => {
    for (const bad of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MAX_DISTANCE_METERS + 1,
      2 ** 53,
      '6240',
      null,
      undefined,
    ])
      expect(
        codeOf(() => cost(policy({}), bad as number)),
        String(bad),
      ).toBe('CREDIT_DISTANCE_INVALID');
  });

  it('gives the same result for the same policy version and inputs, whatever the clock', () => {
    const first = calculateCreditCost({
      policy: rangePolicy,
      distanceMeters: 4321,
    });
    vi.useFakeTimers();
    for (const time of ['2020-01-01T00:00:00Z', '2030-06-15T12:00:00Z']) {
      vi.setSystemTime(new Date(time));
      for (let i = 0; i < 50; i += 1)
        expect(
          calculateCreditCost({ policy: rangePolicy, distanceMeters: 4321 }),
        ).toEqual(first);
    }
  });

  it('validates admin input: forged fields, generic DRIVER actor, bad distances', async () => {
    const base = {
      serviceType: 'LOCAL_DELIVERY',
      actorType: 'PROVIDER',
      calculationType: 'PER_KM',
      creditsPerKm: 1,
      minimumCredits: 3,
    };
    expect(await errorsOf(CreateCreditPolicyDto, base)).toEqual([]);
    for (const forged of [
      'version',
      'status',
      'createdByUserId',
      'effectiveFrom',
      'effectiveUntil',
      'id',
    ])
      expect(
        await errorsOf(CreateCreditPolicyDto, { ...base, [forged]: 7 }),
        forged,
      ).toContain(forged);
    expect(
      await errorsOf(CreateCreditPolicyDto, { ...base, actorType: 'DRIVER' }),
    ).toContain('actorType');
    expect(
      await errorsOf(CreateCreditPolicyDto, {
        ...base,
        serviceType: 'FREIGHT',
      }),
    ).toContain('serviceType');
    const query = (distanceMeters: unknown) =>
      errorsOf(CreditCostQueryDto, {
        serviceType: 'LOCAL_DELIVERY',
        actorType: 'PROVIDER',
        distanceMeters,
      });
    expect(await query('6240')).toEqual([]);
    for (const bad of ['-1', '1.5', 'abc', '1e20', ['1', '2'], ''])
      expect(await query(bad), JSON.stringify(bad)).toContain('distanceMeters');
  });
});

describe('V1.10-B policy resolution', () => {
  /** A Prisma double that only exposes creditPolicy.findFirst: any other access fails the test. */
  const onlyPolicies = (found: unknown) =>
    new Proxy(
      { creditPolicy: { findFirst: vi.fn().mockResolvedValue(found) } },
      {
        get(target, prop) {
          if (prop in target) return target[prop as keyof typeof target];
          if (prop === 'then') return undefined;
          throw new Error(`calculation touched prisma.${String(prop)}`);
        },
      },
    ) as unknown as PrismaService;

  it('fails closed when there is no ACTIVE policy: never 0 credits', async () => {
    const service = new CreditPoliciesService(onlyPolicies(null));
    await expect(
      service.calculate('LOCAL_DELIVERY', 'INDEPENDENT_DRIVER', 6240),
    ).rejects.toMatchObject({
      code: 'CREDIT_POLICY_UNAVAILABLE',
    });
  });

  it('resolves only the ACTIVE policy of the combination and touches nothing else (no account, no ledger)', async () => {
    const db = onlyPolicies(policy({}));
    const service = new CreditPoliciesService(db);
    expect(
      (await service.calculate('LOCAL_DELIVERY', 'PROVIDER', 6240)).credits,
    ).toBe(7);
    expect(db.creditPolicy.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          serviceType: 'LOCAL_DELIVERY',
          actorType: 'PROVIDER',
          status: 'ACTIVE',
        },
      }),
    );
  });
});
