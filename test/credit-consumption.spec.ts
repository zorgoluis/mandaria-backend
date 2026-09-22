import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

const { chargeDispatchAward, awardRejectionCode } =
  await import('../dist/credits/service-award.js');

/**
 * V1.10-D unit rules: the charge comes from the frozen snapshot and from nothing else. These use a
 * transaction double, so they also prove what the charge does NOT touch: no credit policy is
 * resolved, no distance is recalculated and no routing provider exists here at all.
 */
type Snapshot = { id: string; credits: number } | null;
function txDouble(options: {
  snapshot?: Snapshot;
  balance?: number | null;
  onCreate?: (data: Record<string, unknown>) => unknown;
}) {
  const calls = { snapshotWhere: [] as unknown[], locked: [] as string[] };
  const created: Record<string, unknown>[] = [];
  const tx = {
    dispatchCreditSnapshot: {
      findUnique: vi.fn(async ({ where }: { where: unknown }) => {
        calls.snapshotWhere.push(where);
        return options.snapshot ?? null;
      }),
    },
    creditLedgerEntry: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        if (options.onCreate) options.onCreate(data);
        return {
          id: 'entry-1',
          sequence: 41,
          balanceBefore: data.balanceBefore,
          balanceAfter: data.balanceAfter,
        };
      }),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      calls.locked.push(strings.join('?'));
      return options.balance === null || options.balance === undefined
        ? []
        : [{ id: 'account-1', balance: options.balance }];
    }),
    // Anything else would be a dependency this charge must not have.
  } as unknown as Parameters<typeof chargeDispatchAward>[0];
  return { tx, calls, created };
}
const monetized = { id: 'dispatch-1', creditMode: 'MONETIZED' as const };
const provider = { actorType: 'PROVIDER' as const, providerId: 'provider-1' };
const independent = {
  actorType: 'INDEPENDENT_DRIVER' as const,
  independentDriverProfileId: 'profile-1',
};

describe('V1.10-D charge of a dispatch award', () => {
  it('debits exactly the frozen credits and writes one SERVICE_AWARD', async () => {
    const { tx, created } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 10,
    });
    const outcome = await chargeDispatchAward(
      tx,
      monetized,
      provider,
      'user-1',
    );
    expect(outcome).toMatchObject({
      kind: 'charged',
      actorType: 'PROVIDER',
      credits: 7,
      snapshotId: 'snap-1',
      balanceBefore: 10,
      balanceAfter: 3,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      type: 'SERVICE_AWARD',
      amount: -7,
      balanceBefore: 10,
      balanceAfter: 3,
      referenceType: 'DISPATCH',
      referenceId: 'dispatch-1',
      createdByUserId: 'user-1',
    });
    // The human idempotency contract stays with recharges and adjustments.
    expect(created[0].idempotencyKey).toBeUndefined();
  });

  it('accepts an exact balance and leaves zero, which is a valid balance', async () => {
    const { tx, created } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 7,
    });
    const outcome = await chargeDispatchAward(
      tx,
      monetized,
      provider,
      'user-1',
    );
    expect(outcome).toMatchObject({ kind: 'charged', balanceAfter: 0 });
    expect(created[0]).toMatchObject({ balanceAfter: 0 });
  });

  it('refuses an insufficient balance and writes nothing', async () => {
    const { tx, created } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 6,
    });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(created).toHaveLength(0);
  });

  it('refuses a zero balance when the service costs credits', async () => {
    const { tx, created } = txDouble({
      snapshot: { id: 'snap-1', credits: 1 },
      balance: 0,
    });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
    expect(created).toHaveLength(0);
  });

  it('charges the independent driver account, never a provider one', async () => {
    const { tx, calls, created } = txDouble({
      snapshot: { id: 'snap-2', credits: 14 },
      balance: 20,
    });
    const outcome = await chargeDispatchAward(
      tx,
      monetized,
      independent,
      'user-2',
    );
    expect(outcome).toMatchObject({
      kind: 'charged',
      actorType: 'INDEPENDENT_DRIVER',
      credits: 14,
    });
    expect(calls.locked.join()).toContain('independentDriverProfileId');
    expect(calls.locked.join()).not.toContain('"providerId"');
    expect(created[0]).toMatchObject({ amount: -14 });
  });

  it('reads the snapshot of its own actor, not of the other one', async () => {
    const { tx, calls } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 10,
    });
    await chargeDispatchAward(tx, monetized, provider, 'user-1');
    expect(calls.snapshotWhere[0]).toEqual({
      dispatchId_actorType: {
        dispatchId: 'dispatch-1',
        actorType: 'PROVIDER',
      },
    });
  });

  it('fails closed when a monetized dispatch has no snapshot: never a free service', async () => {
    const { tx, created } = txDouble({ snapshot: null, balance: 100 });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'CREDIT_SNAPSHOT_UNAVAILABLE' });
    expect(created).toHaveLength(0);
  });

  it('fails when the actor has no credit account instead of creating one', async () => {
    const { tx, created } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: null,
    });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'CREDIT_ACCOUNT_UNAVAILABLE' });
    expect(created).toHaveLength(0);
  });

  it('skips a legacy dispatch without reading a snapshot or an account', async () => {
    const { tx, calls, created } = txDouble({ balance: 10 });
    const outcome = await chargeDispatchAward(
      tx,
      { id: 'dispatch-legacy', creditMode: 'LEGACY' },
      provider,
      'user-1',
    );
    expect(outcome).toEqual({ kind: 'legacy' });
    expect(calls.snapshotWhere).toHaveLength(0);
    expect(calls.locked).toHaveLength(0);
    expect(created).toHaveLength(0);
  });

  it('turns a duplicated award into a conflict, never a second debit', async () => {
    const { tx } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 10,
      onCreate: () => {
        // The real barrier is the partial unique index, so this is the real Prisma error for it.
        throw new Prisma.PrismaClientKnownRequestError(
          'Unique constraint failed on the fields: (`creditAccountId`,`referenceId`)',
          {
            code: 'P2002',
            clientVersion: Prisma.prismaVersion.client,
            meta: { target: ['creditAccountId', 'referenceId'] },
          },
        );
      },
    });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'CREDIT_MOVEMENT_CONFLICT' });
  });

  it('turns a ledger guard rejection into a conflict, not a 500', async () => {
    const { tx } = txDouble({
      snapshot: { id: 'snap-1', credits: 7 },
      balance: 10,
      onCreate: () => {
        throw new Error(
          'CREDIT_LEDGER_STALE: balanceBefore does not match the current account balance',
        );
      },
    });
    await expect(
      chargeDispatchAward(tx, monetized, provider, 'user-1'),
    ).rejects.toMatchObject({ code: 'CREDIT_MOVEMENT_CONFLICT' });
  });

  it('names only economic refusals for observability', async () => {
    const { tx } = txDouble({ snapshot: null, balance: 10 });
    const error = await chargeDispatchAward(
      tx,
      monetized,
      provider,
      'user-1',
    ).catch((e: unknown) => e);
    expect(awardRejectionCode(error)).toBe('CREDIT_SNAPSHOT_UNAVAILABLE');
    expect(awardRejectionCode(new Error('Dispatch not found'))).toBeNull();
  });
});
