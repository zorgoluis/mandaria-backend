import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import {
  createDispatchCreditSnapshots,
  creditActorsFor,
  creditCostFor,
} from '../dist/credit-policies/dispatch-credit-snapshots.js';

type Policy = Record<string, unknown>;
const perKm = (
  actorType: string,
  creditsPerKm: number,
  version = 1,
): Policy => ({
  id: `pol-${actorType}-${version}`,
  version,
  serviceType: 'LOCAL_DELIVERY',
  actorType,
  calculationType: 'PER_KM',
  creditsPerKm,
  minimumCredits: 3,
  flatCredits: null,
  ranges: [],
});
/**
 * A transaction double exposing ONLY what freezing a cost may use: the advisory lock, the ACTIVE
 * policy lookup and the snapshot insert. Touching accounts, the ledger or anything else fails.
 */
function tx(policies: Record<string, Policy | null>) {
  const target = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    creditPolicy: {
      findFirst: vi.fn(
        async ({ where }: { where: { actorType: string } }) =>
          policies[where.actorType] ?? null,
      ),
    },
    dispatchCreditSnapshot: {
      create: vi.fn(async ({ data }: { data: object }) => data),
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as keyof typeof t];
      if (prop === 'then') return undefined;
      throw new Error(`snapshot creation touched tx.${String(prop)}`);
    },
  }) as typeof target;
}
const quote = (distanceMeters: number) => ({
  serviceType: 'LOCAL_DELIVERY' as const,
  distanceMeters,
});
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'NO_ERROR';
  } catch (error) {
    return (error as { code?: string }).code ?? String(error);
  }
};

describe('V1.10-C applicable actors', () => {
  it('derives the actors from the real execution policy (LOCAL_DELIVERY is BOTH)', () => {
    expect(creditActorsFor('LOCAL_DELIVERY')).toEqual([
      'PROVIDER',
      'INDEPENDENT_DRIVER',
    ]);
  });
  it('a FLEET-only or INDEPENDENT-only service gets only its own actor', () => {
    expect(
      creditActorsFor('LOCAL_DELIVERY', { LOCAL_DELIVERY: 'FLEET' }),
    ).toEqual(['PROVIDER']);
    expect(
      creditActorsFor('LOCAL_DELIVERY', { LOCAL_DELIVERY: 'INDEPENDENT' }),
    ).toEqual(['INDEPENDENT_DRIVER']);
    expect(creditActorsFor('LOCAL_DELIVERY', {})).toEqual([]);
  });
  it('does not require the policy of an actor that cannot take the service', async () => {
    const t = tx({ PROVIDER: perKm('PROVIDER', 1), INDEPENDENT_DRIVER: null });
    const snapshots = await createDispatchCreditSnapshots(
      t as never,
      'd1',
      quote(6240),
      ['PROVIDER'],
    );
    expect(snapshots.map((s) => [s.actorType, s.credits])).toEqual([
      ['PROVIDER', 7],
    ]);
    expect(t.creditPolicy.findFirst).toHaveBeenCalledTimes(1);
  });
  it('fails closed when an allowed actor has no ACTIVE policy, never 0 credits', async () => {
    const t = tx({ PROVIDER: perKm('PROVIDER', 1), INDEPENDENT_DRIVER: null });
    expect(
      await codeOf(
        createDispatchCreditSnapshots(t as never, 'd1', quote(6240)),
      ),
    ).toBe('CREDIT_POLICY_UNAVAILABLE');
  });
});

describe('V1.10-C frozen evidence', () => {
  it('PER_KM: canonical distance, billable km, rate, minimum and result; different per actor', async () => {
    const t = tx({
      PROVIDER: perKm('PROVIDER', 1, 3),
      INDEPENDENT_DRIVER: perKm('INDEPENDENT_DRIVER', 2, 2),
    });
    const [p, i] = await createDispatchCreditSnapshots(
      t as never,
      'd1',
      quote(6240),
    );
    expect(p).toMatchObject({
      dispatchId: 'd1',
      actorType: 'PROVIDER',
      serviceType: 'LOCAL_DELIVERY',
      creditPolicyId: 'pol-PROVIDER-3',
      policyVersion: 3,
      calculationType: 'PER_KM',
      distanceMeters: 6240,
      billableKm: 7,
      creditsPerKm: 1,
      minimumCredits: 3,
      calculatedCredits: 7,
      flatCredits: null,
      appliedRangeId: null,
      credits: 7,
    });
    expect(i).toMatchObject({
      actorType: 'INDEPENDENT_DRIVER',
      policyVersion: 2,
      billableKm: 7,
      calculatedCredits: 14,
      credits: 14,
    });
    const short = await createDispatchCreditSnapshots(
      tx({
        PROVIDER: perKm('PROVIDER', 1),
        INDEPENDENT_DRIVER: perKm('INDEPENDENT_DRIVER', 1),
      }) as never,
      'd2',
      quote(800),
    );
    expect(short[0]).toMatchObject({
      billableKm: 1,
      calculatedCredits: 1,
      minimumCredits: 3,
      credits: 3,
    });
  });
  it('FLAT: no billable km invented', async () => {
    const flat = {
      ...perKm('PROVIDER', 1),
      calculationType: 'FLAT',
      creditsPerKm: null,
      minimumCredits: null,
      flatCredits: 5,
    };
    const [s] = await createDispatchCreditSnapshots(
      tx({ PROVIDER: flat }) as never,
      'd1',
      quote(6240),
      ['PROVIDER'],
    );
    expect(s).toMatchObject({
      calculationType: 'FLAT',
      flatCredits: 5,
      credits: 5,
      billableKm: null,
      calculatedCredits: null,
      creditsPerKm: null,
      minimumCredits: null,
    });
  });
  it('DISTANCE_RANGE: the applied range is identified and its limits frozen', async () => {
    const ranges = [
      {
        id: 'r1',
        position: 1,
        minDistanceMeters: 0,
        maxDistanceMeters: 10000,
        credits: 8,
      },
      {
        id: 'r2',
        position: 2,
        minDistanceMeters: 10000,
        maxDistanceMeters: 20000,
        credits: 20,
      },
      {
        id: 'r3',
        position: 3,
        minDistanceMeters: 20000,
        maxDistanceMeters: null,
        credits: 30,
      },
    ];
    const policy = {
      ...perKm('INDEPENDENT_DRIVER', 1),
      calculationType: 'DISTANCE_RANGE',
      creditsPerKm: null,
      minimumCredits: null,
      ranges,
    };
    const run = (m: number) =>
      createDispatchCreditSnapshots(
        tx({ INDEPENDENT_DRIVER: policy }) as never,
        'd1',
        quote(m),
        ['INDEPENDENT_DRIVER'],
      );
    expect((await run(12400))[0]).toMatchObject({
      appliedRangeId: 'r2',
      appliedRangePosition: 2,
      appliedRangeMinDistanceMeters: 10000,
      appliedRangeMaxDistanceMeters: 20000,
      credits: 20,
      billableKm: null,
    });
    expect((await run(25000))[0]).toMatchObject({
      appliedRangeId: 'r3',
      appliedRangeMaxDistanceMeters: null,
      credits: 30,
    });
    expect((await run(9999))[0]).toMatchObject({
      appliedRangeId: 'r1',
      credits: 8,
    });
  });
  it('refuses to freeze a zero-credit service (explicit minimum 0 at 0 m)', async () => {
    const zero = { ...perKm('PROVIDER', 1), minimumCredits: 0 };
    expect(
      await codeOf(
        createDispatchCreditSnapshots(
          tx({ PROVIDER: zero }) as never,
          'd1',
          quote(0),
          ['PROVIDER'],
        ),
      ),
    ).toBe('CREDIT_COST_OUT_OF_RANGE');
  });
  it('takes the shared policy lock per actor before reading the ACTIVE policy', async () => {
    const t = tx({
      PROVIDER: perKm('PROVIDER', 1),
      INDEPENDENT_DRIVER: perKm('INDEPENDENT_DRIVER', 2),
    });
    await createDispatchCreditSnapshots(t as never, 'd1', quote(6240));
    const sql = t.$queryRaw.mock.calls.map((call: unknown[]) =>
      (call[0] as TemplateStringsArray).join('?'),
    );
    expect(sql).toHaveLength(2);
    expect(
      sql.every((s: string) => s.includes('pg_advisory_xact_lock_shared')),
    ).toBe(true);
  });
  it('picks each actor its own cost; null for a legacy dispatch without snapshots', () => {
    const snaps = [
      { actorType: 'PROVIDER' as const, credits: 7 },
      { actorType: 'INDEPENDENT_DRIVER' as const, credits: 14 },
    ];
    expect(creditCostFor(snaps, 'PROVIDER')).toBe(7);
    expect(creditCostFor(snaps, 'INDEPENDENT_DRIVER')).toBe(14);
    expect(creditCostFor([], 'PROVIDER')).toBeNull();
  });
});
